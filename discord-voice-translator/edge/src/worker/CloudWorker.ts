/**
 * Fast cloud pipeline that runs inside the edge process (no Python worker).
 *
 * It speaks the same interface as WorkerClient, so GuildSession, captions, playout
 * and the web companion work unchanged:
 *
 *   per speaker: 16 kHz PCM ──► Soniox real-time (speech-to-text + translation, one WebSocket)
 *   per translated phrase:     ──► ElevenLabs streaming TTS (PCM 48 kHz) ──► 'audio' events
 *
 * Latency rules:
 *  - no VAD / endpointing of our own: Soniox finalises words while the person is talking;
 *  - every finalised translated phrase is spoken immediately (it is not held until the
 *    end of the sentence), and phrases are synthesised in parallel while playout keeps order;
 *  - a phrase is only dubbed into language L if at least part of it actually needed
 *    translating into L (a listener is never dubbed their own language back).
 *
 * Taglish: Soniox tags every token with its language. For target L we keep, in arrival
 * order, the original tokens already in L plus the translation tokens into L. Soniox
 * emits each translated chunk right after its source chunk, so the order is correct.
 *
 * v1 limit: one Soniox stream per speaker, so at most two languages per server
 * (two-way translation, e.g. Tagalog <-> English) or one target (one-way).
 */

import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

import { Agc } from '../audio/Agc.js';
import type { Json } from '../protocol/frames.js';
import type { HelloAck, LanguageInfo } from '../protocol/messages.js';
import { languageName } from '../languages.js';
import { createLogger, type Logger } from '../util/log.js';
import type { WorkerStatus } from './WorkerClient.js';

/** ElevenLabs Flash v2.5 languages, in our (Whisper-style) codes. */
const ELEVEN_LANGS: Record<string, string> = {
  ar: 'ar', bg: 'bg', cs: 'cs', da: 'da', de: 'de', el: 'el', en: 'en', es: 'es', fi: 'fi', tl: 'fil', fr: 'fr',
  hi: 'hi', hr: 'hr', hu: 'hu', id: 'id', it: 'it', ja: 'ja', ko: 'ko', ms: 'ms', nl: 'nl', no: 'no', pl: 'pl',
  pt: 'pt', ro: 'ro', ru: 'ru', sk: 'sk', sv: 'sv', ta: 'ta', tr: 'tr', uk: 'uk', vi: 'vi', zh: 'zh',
};

const PHRASE_END = /[.!?,;:。！？、]\s*$/;
const MIN_WORDS_TO_SPEAK = 4;
const PHRASE_TIMEOUT_MS = 300;
const IDLE_CLOSE_MS = 120_000;
const KEEPALIVE_MS = 8_000;
const MAX_PENDING_AUDIO_BYTES = 32_000 * 5; // 5 s at 16 kHz s16 while the socket opens

export interface CloudWorkerOptions {
  /** Returns the Soniox API key (or a temporary key) used in the WebSocket config. */
  sonioxKey: () => Promise<string>;
  sonioxUrl?: string;
  sonioxModel?: string;
  elevenKey: string;
  elevenVoiceId?: string;
  elevenModel?: string;
  elevenBaseUrl?: string;
  defaultLangs?: string[];
  /** Optional HTTP agent for the Soniox WebSocket (e.g. behind an HTTPS proxy). */
  wsAgent?: import('node:http').Agent;
  log?: Logger;
}

interface GuildCfg {
  textTargets: string[];
  audioTargets: string[];
  expected: string[] | null;
}

interface Utt {
  id: number;
  original: string;
  langCount: Map<string, number>;
  confSum: number;
  confN: number;
  text: Map<string, string>; // per target: final text (translation + passthrough)
  phrase: Map<string, { text: string; translated: boolean }>; // per audio target: not yet spoken
  translatedInto: Set<string>; // targets that needed translation in this utterance
  firstAt: number;
}

interface Stream {
  sid: number;
  guildId: string;
  userId: string;
  name: string;
  speakLang: string;
  ws: WebSocket | null;
  wsOpen: boolean;
  sig: string;
  agc: Agc;
  pending: Buffer[];
  pendingBytes: number;
  lastAudioAt: number;
  keepalive: NodeJS.Timeout | null;
  phraseTimer: NodeJS.Timeout | null;
  utt: Utt;
  nextUtt: number;
  lastPartial: string;
  errorNotified: boolean;
  retryAt: number;
  backoffMs: number;
}

interface Dub {
  ctrl: AbortController;
  sid: number;
  startedAt: number;
}

let dubSeq = 1;

export class CloudWorker extends EventEmitter {
  readonly name = 'cloud (Soniox + ElevenLabs)';
  status: WorkerStatus = 'down';
  info: HelloAck | null = null;
  stats = { connects: 0, disconnects: 0, audioBuffered: 0, audioDroppedCongested: 0, lastRttMs: 0 };

  private streams = new Map<number, Stream>();
  private guilds = new Map<string, GuildCfg>();
  private dubs = new Map<number, Dub>();
  private replayers = new Set<() => Json[]>();
  private sweeper: NodeJS.Timeout | null = null;
  private readonly log: Logger;
  private readonly o: Required<Omit<CloudWorkerOptions, 'log' | 'wsAgent'>> & { wsAgent?: import('node:http').Agent };

  constructor(opts: CloudWorkerOptions) {
    super();
    this.o = {
      sonioxKey: opts.sonioxKey,
      sonioxUrl: opts.sonioxUrl ?? 'wss://stt-rt.soniox.com/transcribe-websocket',
      sonioxModel: opts.sonioxModel ?? 'stt-rt-v6',
      elevenKey: opts.elevenKey,
      elevenVoiceId: opts.elevenVoiceId ?? 'JBFqnCBsd6RMkjVDRZzb',
      elevenModel: opts.elevenModel ?? 'eleven_flash_v2_5',
      elevenBaseUrl: (opts.elevenBaseUrl ?? 'https://api.elevenlabs.io').replace(/\/$/, ''),
      defaultLangs: opts.defaultLangs ?? ['tl', 'en'],
      wsAgent: opts.wsAgent,
    };
    this.log = opts.log ?? createLogger('cloud');
  }

  get ready(): boolean {
    return this.status === 'ready';
  }

  // ------------------------------------------------------------------ lifecycle (WorkerClient API)
  start(): void {
    this.info = this.helloAck();
    this.status = 'ready';
    this.stats.connects++;
    this.sweeper = setInterval(() => this.sweep(), 5_000);
    this.sweeper.unref();
    queueMicrotask(() => {
      this.emit('status', 'ready');
      this.emit('ready', this.info);
      for (const fn of this.replayers) for (const m of fn()) this.sendJson(m);
    });
  }

  stop(): void {
    this.status = 'stopped';
    if (this.sweeper) clearInterval(this.sweeper);
    for (const s of this.streams.values()) this.closeSession(s, false);
    this.streams.clear();
    for (const d of this.dubs.values()) d.ctrl.abort();
    this.dubs.clear();
  }

  addReplayer(fn: () => Json[]): () => void {
    this.replayers.add(fn);
    return () => this.replayers.delete(fn);
  }

  sendJson(m: Json): boolean {
    if (!this.ready) return false;
    switch (m.type) {
      case 'guild_config':
        this.onGuildConfig(m);
        break;
      case 'stream_open':
        this.onStreamOpen(m);
        break;
      case 'stream_update': {
        const s = this.streams.get(Number(m.sid));
        if (s) {
          s.speakLang = String(m.speak_lang ?? 'auto');
          this.closeSession(s, true); // reopens with new hints on next audio
        }
        break;
      }
      case 'stream_close': {
        const s = this.streams.get(Number(m.sid));
        if (s) {
          this.closeSession(s, true);
          this.streams.delete(s.sid);
        }
        break;
      }
      case 'cancel_dub':
        this.cancelDub(Number(m.dub_id), String(m.reason ?? 'cancelled'));
        break;
      default:
        break; // ping, correct, etc. are not needed in cloud mode
    }
    return true;
  }

  sendAudio(sid: number, _seq: number, raw: Buffer): void {
    const s = this.streams.get(sid);
    if (!s) return;
    const pcm = s.agc.process(raw); // lift faint speakers before recognition
    s.lastAudioAt = performance.now();
    if (!s.ws && s.lastAudioAt >= s.retryAt) this.openSession(s);
    if (s.wsOpen && s.ws?.readyState === WebSocket.OPEN) {
      s.ws.send(pcm);
      return;
    }
    if (s.pendingBytes + pcm.length > MAX_PENDING_AUDIO_BYTES) {
      const drop = s.pending.shift();
      if (drop) s.pendingBytes -= drop.length;
      this.stats.audioDroppedCongested++;
    }
    s.pending.push(pcm);
    s.pendingBytes += pcm.length;
    this.stats.audioBuffered++;
  }

  sendBlob(): boolean {
    return false; // voice-clone enrollment is not part of cloud mode
  }

  dropStream(sid: number): void {
    const s = this.streams.get(sid);
    if (s) s.pending = [];
  }

  async request<T extends Json = Json>(msg: Json, resultType: string): Promise<T> {
    if (msg.type === 'voice_status') return { type: resultType, enrolled: false } as unknown as T;
    if (msg.type === 'voice_delete') return { type: resultType, deleted: false } as unknown as T;
    throw new Error(`"${String(msg.type)}" is not available in fast (cloud) mode yet`);
  }

  // ------------------------------------------------------------------ config
  private onGuildConfig(m: Json): void {
    const cfg: GuildCfg = {
      textTargets: (m.text_targets as string[] | undefined) ?? [],
      audioTargets: (m.audio_targets as string[] | undefined) ?? [],
      expected: (m.expected_langs as string[] | null | undefined) ?? null,
    };
    this.guilds.set(String(m.guild_id), cfg);
    for (const s of this.streams.values()) {
      if (s.guildId === String(m.guild_id) && s.ws && this.signature(s) !== s.sig) this.closeSession(s, true);
    }
  }

  private onStreamOpen(m: Json): void {
    const sid = Number(m.sid);
    const old = this.streams.get(sid);
    if (old) this.closeSession(old, false);
    this.streams.set(sid, {
      sid,
      guildId: String(m.guild_id),
      userId: String(m.user_id),
      name: String(m.name ?? ''),
      speakLang: String(m.speak_lang ?? 'auto'),
      ws: null,
      wsOpen: false,
      sig: '',
      agc: new Agc(),
      pending: [],
      pendingBytes: 0,
      lastAudioAt: performance.now(),
      keepalive: null,
      phraseTimer: null,
      utt: newUtt(1),
      nextUtt: 2,
      lastPartial: '',
      errorNotified: false,
      retryAt: 0,
      backoffMs: 500,
    });
  }

  /** Target languages of a guild, capped at two (one Soniox stream per speaker). */
  private targets(guildId: string): string[] {
    const g = this.guilds.get(guildId);
    const all = [...new Set([...(g?.audioTargets ?? []), ...(g?.textTargets ?? [])])];
    if (all.length > 2) this.noticeOnce(guildId, 'too_many_langs', `Fast mode translates between up to two languages per server for now; using ${all.slice(0, 2).map(languageName).join(' and ')}.`);
    return all.slice(0, 2);
  }

  private hints(s: Stream, targets: string[]): string[] {
    if (s.speakLang && s.speakLang !== 'auto') return [s.speakLang];
    const g = this.guilds.get(s.guildId);
    return [...new Set([...(g?.expected ?? this.o.defaultLangs), ...targets])];
  }

  private signature(s: Stream): string {
    const t = this.targets(s.guildId);
    return JSON.stringify([t, this.hints(s, t)]);
  }

  // ------------------------------------------------------------------ Soniox session
  private openSession(s: Stream): void {
    const targets = this.targets(s.guildId);
    const hints = this.hints(s, targets);
    s.sig = this.signature(s);
    const ws = new WebSocket(this.o.sonioxUrl, this.o.wsAgent ? { agent: this.o.wsAgent } : undefined);
    s.ws = ws;
    s.wsOpen = false;
    const translation =
      targets.length === 2
        ? { type: 'two_way', language_a: targets[0], language_b: targets[1] }
        : targets.length === 1
          ? { type: 'one_way', target_language: targets[0] }
          : undefined;
    ws.on('open', async () => {
      try {
        const apiKey = await this.o.sonioxKey();
        if (s.ws !== ws) return;
        ws.send(JSON.stringify({
          api_key: apiKey,
          model: this.o.sonioxModel,
          audio_format: 'pcm_s16le',
          sample_rate: 16000,
          num_channels: 1,
          language_hints: hints,
          enable_language_identification: true,
          enable_endpoint_detection: true,
          client_reference_id: `g${s.guildId}-s${s.sid}`,
          ...(translation ? { translation } : {}),
        }));
        s.wsOpen = true;
        s.backoffMs = 500;
        for (const p of s.pending) ws.send(p);
        s.pending = [];
        s.pendingBytes = 0;
        s.keepalive = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN && performance.now() - s.lastAudioAt > KEEPALIVE_MS) ws.send(JSON.stringify({ type: 'keepalive' }));
        }, KEEPALIVE_MS);
        s.keepalive.unref();
      } catch (e) {
        this.log.error('soniox key error', { err: e });
        ws.close();
      }
    });
    ws.on('message', (data) => {
      if (s.ws !== ws) return;
      try {
        this.onSoniox(s, JSON.parse(String(data)));
      } catch (e) {
        this.log.warn('bad soniox message', { err: e });
      }
    });
    ws.on('error', (e) => this.log.warn('soniox socket error', { sid: s.sid, err: e }));
    ws.on('close', () => {
      if (s.ws !== ws) return;
      if (!s.wsOpen) {
        // never got going: back off instead of retrying on every audio frame
        s.retryAt = performance.now() + s.backoffMs;
        s.backoffMs = Math.min(s.backoffMs * 2, 15_000);
      }
      this.flushPhrases(s, true);
      if (s.keepalive) clearInterval(s.keepalive);
      s.keepalive = null;
      s.ws = null;
      s.wsOpen = false;
    });
  }

  private closeSession(s: Stream, graceful: boolean): void {
    const ws = s.ws;
    if (s.keepalive) clearInterval(s.keepalive);
    if (s.phraseTimer) clearTimeout(s.phraseTimer);
    s.keepalive = null;
    s.phraseTimer = null;
    s.pending = [];
    s.pendingBytes = 0;
    if (!ws) return;
    if (graceful && ws.readyState === WebSocket.OPEN) {
      // empty frame = end of audio; Soniox finalises remaining tokens, then closes
      ws.send('');
      const t = setTimeout(() => ws.terminate(), 3_000);
      t.unref();
    } else {
      s.ws = null;
      s.wsOpen = false;
      ws.terminate();
    }
  }

  private sweep(): void {
    const now = performance.now();
    for (const s of this.streams.values()) if (s.ws && now - s.lastAudioAt > IDLE_CLOSE_MS) this.closeSession(s, true);
  }

  // ------------------------------------------------------------------ tokens
  private onSoniox(s: Stream, d: Record<string, unknown>): void {
    if (d.error_code) {
      this.log.error('soniox error', { code: d.error_code, message: d.error_message });
      this.emit('event', { type: 'error', sid: s.sid, message: String(d.error_message), stage: 'stt' });
      if (!s.errorNotified) {
        s.errorNotified = true;
        this.emit('event', { type: 'notice', sid: s.sid, level: 'warn', code: 'stt_error', message: `Speech service error: ${String(d.error_message)}` });
      }
      return;
    }
    const tokens = (d.tokens as SonioxToken[] | undefined) ?? [];
    if (!tokens.length) return;
    const u = s.utt;
    let tentative = '';
    const tentativeTr = new Map<string, string>();
    const audio = new Set(this.guilds.get(s.guildId)?.audioTargets ?? []);
    const targets = new Set(this.targets(s.guildId));
    let ended = false;
    let gotFinalForAudio = false;

    for (const t of tokens) {
      if (!t.is_final) {
        if (t.translation_status === 'translation') tentativeTr.set(t.language ?? '', (tentativeTr.get(t.language ?? '') ?? '') + t.text);
        else tentative += t.text;
        continue;
      }
      if (t.text === '<end>' || t.text === '<fin>') {
        ended = true;
        continue;
      }
      if (!u.firstAt) u.firstAt = performance.now();
      const lang = t.language ?? '';
      const isTr = t.translation_status === 'translation';
      if (!isTr) {
        u.original += t.text;
        if (lang && t.text.trim()) u.langCount.set(lang, (u.langCount.get(lang) ?? 0) + 1);
        if (typeof t.confidence === 'number') {
          u.confSum += t.confidence;
          u.confN++;
        }
      }
      // target text = translations into L + original tokens already in L (Taglish passthrough)
      if (lang && targets.has(lang)) {
        u.text.set(lang, (u.text.get(lang) ?? '') + t.text);
        if (audio.has(lang)) {
          const p = u.phrase.get(lang) ?? { text: '', translated: false };
          p.text += t.text;
          if (isTr) {
            p.translated = true;
            u.translatedInto.add(lang);
          }
          u.phrase.set(lang, p);
          gotFinalForAudio = true;
        }
      }
    }

    // live captions
    const committed = u.original.trim();
    const key = committed + '|' + tentative;
    if (key !== s.lastPartial && (committed || tentative.trim())) {
      s.lastPartial = key;
      const lang = topLang(u) ?? '';
      this.emit('event', { type: 'partial', sid: s.sid, utt_id: u.id, lang, committed, tentative: tentative.trim() });
      const tr: Record<string, string> = {};
      for (const l of targets) {
        const txt = ((u.text.get(l) ?? '') + (tentativeTr.get(l) ?? '')).trim();
        if (txt && l !== lang) tr[l] = txt;
      }
      if (Object.keys(tr).length) this.emit('event', { type: 'partial_translation', sid: s.sid, utt_id: u.id, lang, translations: tr });
    }

    if (ended) {
      this.flushPhrases(s, true);
      this.finishUtt(s);
    } else if (gotFinalForAudio) {
      this.flushPhrases(s, false);
    }
  }

  /** Speak finished phrases now; hold short unfinished ones briefly. */
  private flushPhrases(s: Stream, force: boolean): void {
    if (s.phraseTimer) clearTimeout(s.phraseTimer);
    s.phraseTimer = null;
    let holding = false;
    const spoken = topLang(s.utt); // the language this person is mainly speaking right now
    for (const [lang, p] of s.utt.phrase) {
      const text = p.text.trim();
      if (!text) continue;
      const words = text.split(/\s+/).length;
      if (force || PHRASE_END.test(text) || words >= MIN_WORDS_TO_SPEAK) {
        // speak it if any part of this utterance needed translating into `lang`
        // (keeps the English words of a Taglish sentence in an English dub)
        // never dub into the language the person is mainly speaking (so Taglish gets one dub, not two)
        if ((p.translated || s.utt.translatedInto.has(lang)) && lang !== spoken) this.speak(s, lang, text);
        s.utt.phrase.set(lang, { text: '', translated: false });
      } else {
        holding = true;
      }
    }
    if (holding) {
      s.phraseTimer = setTimeout(() => this.flushPhrases(s, true), PHRASE_TIMEOUT_MS);
      s.phraseTimer.unref();
    }
  }

  private finishUtt(s: Stream): void {
    const u = s.utt;
    s.utt = newUtt(s.nextUtt++);
    s.lastPartial = '';
    const text = u.original.trim();
    if (!text) return;
    const lang = topLang(u) ?? 'und';
    const g = this.guilds.get(s.guildId);
    const audio = new Set(g?.audioTargets ?? []);
    const translations: Record<string, { text: string | null; provider: string | null; mode: string | null; note: string }> = {};
    const tiers: Record<string, number> = {};
    for (const l of this.targets(s.guildId)) {
      const t = (u.text.get(l) ?? '').trim();
      translations[l] = { text: t || (l === lang ? text : null), provider: 'soniox', mode: 'literal', note: '' };
      tiers[l] = audio.has(l) && ELEVEN_LANGS[l] ? 2 : 3;
    }
    const confidence = u.confN ? u.confSum / u.confN : 1;
    const sinceFirst = u.firstAt ? performance.now() - u.firstAt : 0;
    this.emit('event', {
      type: 'final', sid: s.sid, utt_id: u.id, user_id: s.userId, lang, lang_prob: 1, lid_reason: 'soniox',
      segments: [], text, confidence, flags: confidence < 0.5 ? ['low_confidence'] : [], translations, tiers,
      stt_provider: 'soniox', duration_s: sinceFirst / 1000, endpoint_reason: 'soniox',
      latency: {},
    });
  }

  // ------------------------------------------------------------------ TTS
  private speak(s: Stream, lang: string, text: string): void {
    const elLang = ELEVEN_LANGS[lang];
    if (!elLang) return;
    const dubId = dubSeq++;
    const ctrl = new AbortController();
    const startedAt = performance.now();
    this.dubs.set(dubId, { ctrl, sid: s.sid, startedAt });
    this.emit('event', {
      type: 'tts_start', dub_id: dubId, sid: s.sid, utt_id: s.utt.id, user_id: s.userId, lang, text,
      tier: 2, voice: 'house', provider: 'elevenlabs', incremental: true, sample_rate: 48000,
    });
    void this.synthesize(dubId, elLang, text, ctrl.signal, startedAt);
  }

  private async synthesize(dubId: number, elLang: string, text: string, signal: AbortSignal, startedAt: number): Promise<void> {
    let frames = 0;
    let firstAudio: number | undefined;
    let reason = 'done';
    let carry: Buffer | null = null;
    try {
      const url = `${this.o.elevenBaseUrl}/v1/text-to-speech/${encodeURIComponent(this.o.elevenVoiceId)}/stream?output_format=pcm_48000`;
      const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: { 'xi-api-key': this.o.elevenKey, 'Content-Type': 'application/json', Accept: 'audio/pcm' },
        body: JSON.stringify({ text, model_id: this.o.elevenModel, language_code: elLang }),
      });
      if (!res.ok || !res.body) throw new Error(`ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      let seq = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        let buf = Buffer.from(chunk);
        if (carry) {
          buf = Buffer.concat([carry, buf]);
          carry = null;
        }
        if (buf.length % 2) {
          carry = buf.subarray(buf.length - 1);
          buf = buf.subarray(0, buf.length - 1);
        }
        if (!buf.length) continue;
        if (firstAudio === undefined) {
          firstAudio = performance.now() - startedAt;
          this.emit('event', { type: 'metrics', tts_first_audio_ms: Math.round(firstAudio) });
        }
        frames++;
        this.emit('audio', dubId, seq++, buf);
      }
    } catch (e) {
      if (signal.aborted) reason = 'cancelled';
      else {
        reason = 'error';
        this.log.warn('tts failed', { err: e });
        this.emit('event', { type: 'error', message: String((e as Error).message), stage: 'tts' });
      }
    } finally {
      this.dubs.delete(dubId);
      this.emit('event', {
        type: 'tts_end', dub_id: dubId, cancelled: reason === 'cancelled', reason, truncated: null, frames,
        latency: firstAudio === undefined ? {} : { tts_first_audio: Math.round(firstAudio) },
      });
    }
  }

  private cancelDub(dubId: number, _reason: string): void {
    this.dubs.get(dubId)?.ctrl.abort();
  }

  // ------------------------------------------------------------------ misc
  private noticed = new Set<string>();
  private noticeOnce(guildId: string, code: string, message: string): void {
    const k = `${guildId}:${code}`;
    if (this.noticed.has(k)) return;
    this.noticed.add(k);
    for (const s of this.streams.values()) {
      if (s.guildId === guildId) {
        this.emit('event', { type: 'notice', sid: s.sid, level: 'info', code, message });
        return;
      }
    }
  }

  private helloAck(): HelloAck {
    const languages: Record<string, LanguageInfo> = {};
    for (const code of Object.keys(ELEVEN_LANGS)) {
      languages[code] = { tier: 2, stt: 'good', auto: true, name: languageName(code), reasons: [] };
    }
    return {
      type: 'hello_ack',
      protocol: 1,
      worker_version: 'cloud-1',
      hardware: { tier: 'cloud', device: 'cloud', gpu_name: '', vram_gb: 0, cpu_cores: 0 },
      plan: { stt: `soniox ${this.o.sonioxModel}`, tts: `elevenlabs ${this.o.elevenModel}` },
      policy: { mode: 'cloud', commercial: true, store_audio: false },
      providers: [
        { stage: 'stt+mt', name: 'soniox', status: 'ok' },
        { stage: 'tts', name: 'elevenlabs', status: 'ok' },
      ],
      registry_summary: { counts: { '2': Object.keys(languages).length }, targets_by_tier: { '2': Object.keys(languages) } },
      languages,
      voice_cloning: { enabled: false, reason: 'not available in fast (cloud) mode' },
    };
  }
}

interface SonioxToken {
  text: string;
  is_final?: boolean;
  language?: string;
  translation_status?: 'none' | 'original' | 'translation';
  confidence?: number;
  start_ms?: number;
  end_ms?: number;
}

function newUtt(id: number): Utt {
  return { id, original: '', langCount: new Map(), confSum: 0, confN: 0, text: new Map(), phrase: new Map(), translatedInto: new Set(), firstAt: 0 };
}

function topLang(u: Utt): string | null {
  let best: string | null = null;
  let n = 0;
  for (const [l, c] of u.langCount) if (c > n) [best, n] = [l, c];
  return best;
}
