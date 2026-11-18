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
 * Any language in, every server language out: each speaker has one Soniox lane per server
 * language (up to 3), each translating whatever is spoken into that language.
 */

import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

import { Agc } from '../audio/Agc.js';
import { PitchTracker } from '../audio/Pitch.js';
import type { VoiceBank } from './VoiceBank.js';
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
const MAX_LANGS = 3;
/** Everyday chat / gaming words that recognisers often get wrong. */
const CHAT_TERMS = ['Discord', 'ranked', 'GG', 'AFK', 'lag', 'carry', 'noob', 'pare', 'lods', 'bro', 'sis', 'bes', 'tol', 'petmalu', 'charot', 'sana all', 'Valorant', 'Mobile Legends', 'Minecraft', 'Roblox']; // server languages (one Soniox lane per language per speaker)
const IDLE_CLOSE_MS = 10 * 60_000; // keep each speaker's line open between turns so the next one starts instantly
const TTS_FIRST_BYTE_MS = 3_000; // a dub that hasn't started by now is retried once
const WARM_EVERY_MS = 45_000;

/** House voices (ElevenLabs default library), split by pitch so a dub matches its speaker. */
export const DEFAULT_VOICES = {
  low: ['JBFqnCBsd6RMkjVDRZzb', 'TX3LPaxmHKxFdv7VOQHJ', 'cjVigY5qzO86Huf0OWal'], // George, Liam, Eric
  high: ['EXAVITQu4vr4xnSDxMaL', 'FGY2WhTYpPnrIDTdsKH5', 'XrExE9yKIg1WjnnlVkGX', 'cgSgspJ2msm6clMCkdW9', 'pFZP5JQG7iQjIQuC4Bku'], // Sarah, Laura, Matilda, Jessica, Lily
};
const PITCH_SPLIT_HZ = 165;
const KEEPALIVE_MS = 8_000;
const MAX_PENDING_AUDIO_BYTES = 32_000 * 5; // 5 s at 16 kHz s16 while the socket opens

export interface CloudWorkerOptions {
  /** Returns the Soniox API key (or a temporary key) used in the WebSocket config. */
  sonioxKey: () => Promise<string>;
  sonioxUrl?: string;
  sonioxModel?: string;
  elevenKey: string;
  /** Force one voice for everyone (otherwise each speaker gets their own). */
  elevenVoiceId?: string;
  voices?: { low: string[]; high: string[] };
  elevenModel?: string;
  elevenBaseUrl?: string;
  defaultLangs?: string[];
  /** How many voices ElevenLabs lets this account generate at once (plan limit). Extra requests queue. */
  elevenConcurrency?: number;
  /** Per-person voice choice / own cloned voice. */
  voiceBank?: VoiceBank;
  /** Optional HTTP agent for the Soniox WebSocket (e.g. behind an HTTPS proxy). */
  wsAgent?: import('node:http').Agent;
  log?: Logger;
}

interface GuildCfg {
  textTargets: string[];
  audioTargets: string[];
  /** languages spoken into the voice channel itself (one per phrase, see chooseChannelDub) */
  channelDub: string[];
  expected: string[] | null;
}

interface Utt {
  id: number;
  original: string;
  langCount: Map<string, number>;
  confSum: number;
  confN: number;
  text: string; // this lane's target text: translations into it + words already in it
  phrase: { text: string; translated: boolean }; // not yet spoken
  translatedInto: boolean; // part of this utterance needed translating into the target
  lastWasTr: boolean;
  firstAt: number;
  /** wall-clock span of the spoken words (ms, performance.now() base), to match languages up */
  absStart: number;
  absEnd: number;
}

/**
 * One Soniox socket per (speaker, server language). Each lane translates ANY spoken language
 * into its own target (one-way), so every language is understood and every server language
 * is produced. The first lane is the primary: it drives captions and utterance boundaries.
 */
interface Lane {
  target: string | null;
  primary: boolean;
  ws: WebSocket | null;
  wsOpen: boolean;
  sig: string;
  pending: Buffer[];
  pendingBytes: number;
  keepalive: NodeJS.Timeout | null;
  phraseTimer: NodeJS.Timeout | null;
  retryAt: number;
  backoffMs: number;
  utt: Utt;
  nextUtt: number;
  /** finished sentences of a secondary lane, with when they were spoken */
  completed: { text: string; start: number; end: number; used: boolean }[];
  /** wall-clock time of this lane's first audio frame (Soniox times are relative to it) */
  t0: number;
}

interface Stream {
  sid: number;
  guildId: string;
  userId: string;
  name: string;
  speakLang: string;
  agc: Agc;
  pitch: PitchTracker;
  lastSaid: Map<string, string>; // per language: previous dubbed phrase, for smooth continuous delivery
  lastAudioAt: number;
  lanes: Map<string, Lane>;
  lastPartial: string;
  errorNotified: boolean;
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
  private readonly o: Required<Omit<CloudWorkerOptions, 'log' | 'wsAgent' | 'elevenVoiceId' | 'voiceBank'>> & { wsAgent?: import('node:http').Agent; elevenVoiceId?: string; voiceBank?: VoiceBank };
  /** guildId -> userId -> voice id (stable for the whole call) */
  private voiceOf = new Map<string, Map<string, string>>();
  private lastWarm = 0;
  /** Concurrency gate for ElevenLabs (requests beyond the plan limit would fail with 429). */
  private ttsActive = 0;
  private ttsWaiting: (() => void)[] = [];

  constructor(opts: CloudWorkerOptions) {
    super();
    this.o = {
      sonioxKey: opts.sonioxKey,
      sonioxUrl: opts.sonioxUrl ?? 'wss://stt-rt.soniox.com/transcribe-websocket',
      sonioxModel: opts.sonioxModel ?? 'stt-rt-v6',
      elevenKey: opts.elevenKey,
      elevenVoiceId: opts.elevenVoiceId,
      voices: opts.voices ?? DEFAULT_VOICES,
      elevenModel: opts.elevenModel ?? 'eleven_flash_v2_5',
      elevenBaseUrl: (opts.elevenBaseUrl ?? 'https://api.elevenlabs.io').replace(/\/$/, ''),
      defaultLangs: opts.defaultLangs ?? ['tl', 'en'],
      wsAgent: opts.wsAgent,
      elevenConcurrency: Math.max(1, opts.elevenConcurrency ?? 3),
      voiceBank: opts.voiceBank,
    };
    this.log = opts.log ?? createLogger('cloud');
  }

  get ready(): boolean {
    return this.status === 'ready';
  }

  // ------------------------------------------------------------------ lifecycle (WorkerClient API)
  start(): void {
    this.warm();
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
    for (const st of this.streams.values()) this.closeLanes(st, false);
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
          this.closeLanes(s, true); // reopen with new hints on next audio
        }
        break;
      }
      case 'stream_close': {
        const s = this.streams.get(Number(m.sid));
        if (s) {
          this.closeLanes(s, true);
          this.streams.delete(s.sid);
          // call over for this server: free its voices for the next call
          if (![...this.streams.values()].some((x) => x.guildId === s.guildId)) this.voiceOf.delete(s.guildId);
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
    s.pitch.push(pcm);
    this.o.voiceBank?.feed(s.userId, pcm); // learns their own voice, only if they chose "My own voice"
    s.lastAudioAt = performance.now();
    this.syncLanes(s);
    for (const lane of s.lanes.values()) {
      if (!lane.ws && s.lastAudioAt >= lane.retryAt) { this.openLane(s, lane); lane.t0 = 0; }
      if (!lane.t0) lane.t0 = s.lastAudioAt - pcm.length / 32; // this frame is the lane's time zero (16 kHz s16)
      if (lane.wsOpen && lane.ws?.readyState === WebSocket.OPEN) {
        lane.ws.send(pcm);
        continue;
      }
      if (lane.pendingBytes + pcm.length > MAX_PENDING_AUDIO_BYTES) {
        const drop = lane.pending.shift();
        if (drop) lane.pendingBytes -= drop.length;
        this.stats.audioDroppedCongested++;
      }
      lane.pending.push(pcm);
      lane.pendingBytes += pcm.length;
      this.stats.audioBuffered++;
    }
  }

  sendBlob(): boolean {
    return false; // voice-clone enrollment is not part of cloud mode
  }

  dropStream(sid: number): void {
    const s = this.streams.get(sid);
    if (s) for (const l of s.lanes.values()) { l.pending = []; l.pendingBytes = 0; }
  }

  async request<T extends Json = Json>(msg: Json, resultType: string): Promise<T> {
    if (msg.type === 'voice_status') return { type: resultType, enrolled: false } as unknown as T;
    if (msg.type === 'voice_delete') return { type: resultType, deleted: false } as unknown as T;
    throw new Error(`"${String(msg.type)}" is not available in fast (cloud) mode yet`);
  }

  // ------------------------------------------------------------------ config
  private onGuildConfig(m: Json): void {
    const audio = (m.audio_targets as string[] | undefined) ?? [];
    const cfg: GuildCfg = {
      textTargets: (m.text_targets as string[] | undefined) ?? [],
      audioTargets: audio,
      channelDub: (m.channel_dub_langs as string[] | undefined) ?? audio,
      expected: (m.expected_langs as string[] | null | undefined) ?? null,
    };
    this.guilds.set(String(m.guild_id), cfg);
    for (const s of this.streams.values()) if (s.guildId === String(m.guild_id)) this.syncLanes(s);
  }

  private onStreamOpen(m: Json): void {
    this.warm();
    const sid = Number(m.sid);
    const old = this.streams.get(sid);
    if (old) this.closeLanes(old, false);
    this.streams.set(sid, {
      sid,
      guildId: String(m.guild_id),
      userId: String(m.user_id),
      name: String(m.name ?? ''),
      speakLang: String(m.speak_lang ?? 'auto'),
      agc: new Agc(),
      pitch: new PitchTracker(),
      lastSaid: new Map(),
      lastAudioAt: performance.now(),
      lanes: new Map(),
      lastPartial: '',
      errorNotified: false,
    });
  }

  /** The server's languages, in order (first = main language). */
  targets(guildId: string): string[] {
    const g = this.guilds.get(guildId);
    const all = [...new Set([...(g?.channelDub ?? []), ...(g?.textTargets ?? []), ...(g?.audioTargets ?? [])])];
    if (all.length > MAX_LANGS) this.noticeOnce(guildId, 'too_many_langs', `VocaLink translates into up to ${MAX_LANGS} languages per server; using ${all.slice(0, MAX_LANGS).map(languageName).join(', ')}.`);
    return all.slice(0, MAX_LANGS);
  }

  /** What the conversation is, and the names / words to listen for: improves recognition and translation. */
  private context(s: Stream): Record<string, unknown> {
    const names = new Set<string>();
    for (const x of this.streams.values()) if (x.guildId === s.guildId && x.name && x.name !== '…') names.add(x.name);
    return {
      general: [
        { key: 'domain', value: 'Casual live voice chat between friends on Discord, often while gaming' },
        { key: 'style', value: 'Spoken, informal; people mix languages mid-sentence (e.g. Taglish)' },
      ],
      terms: [...names, ...CHAT_TERMS].slice(0, 100),
    };
  }

  private hints(s: Stream, targets: string[]): string[] {
    if (s.speakLang && s.speakLang !== 'auto') return [s.speakLang];
    const g = this.guilds.get(s.guildId);
    // soft hints only: any other language is still recognised and translated
    return [...new Set([...targets, ...(g?.expected ?? [])])];
  }

  /** Make the speaker's lanes match the server's languages (one lane per language). */
  private syncLanes(s: Stream): void {
    const targets = this.targets(s.guildId);
    const keys = targets.length ? targets : ['-'];
    for (const [k, lane] of s.lanes) {
      if (!keys.includes(k)) {
        this.closeLane(lane, true);
        s.lanes.delete(k);
      }
    }
    const hintsSig = JSON.stringify(this.hints(s, targets));
    keys.forEach((k, i) => {
      let lane = s.lanes.get(k);
      if (!lane) {
        lane = {
          target: k === '-' ? null : k, primary: false, ws: null, wsOpen: false, sig: hintsSig, pending: [], pendingBytes: 0,
          keepalive: null, phraseTimer: null, retryAt: 0, backoffMs: 500, utt: newUtt(1), nextUtt: 2, completed: [], t0: 0,
        };
        s.lanes.set(k, lane);
      } else if (lane.ws && lane.sig !== hintsSig) {
        this.closeLane(lane, true); // hints changed: reopen on next audio
      }
      lane.primary = i === 0;
    });
  }

  // ------------------------------------------------------------------ Soniox lanes
  private openLane(s: Stream, lane: Lane): void {
    const targets = this.targets(s.guildId);
    const hints = this.hints(s, targets);
    lane.sig = JSON.stringify(hints);
    const ws = new WebSocket(this.o.sonioxUrl, this.o.wsAgent ? { agent: this.o.wsAgent } : undefined);
    lane.ws = ws;
    lane.wsOpen = false;
    ws.on('open', async () => {
      try {
        const apiKey = await this.o.sonioxKey();
        if (lane.ws !== ws) return;
        ws.send(JSON.stringify({
          api_key: apiKey,
          model: this.o.sonioxModel,
          audio_format: 'pcm_s16le',
          sample_rate: 16000,
          num_channels: 1,
          language_hints: hints,
          enable_language_identification: true,
          enable_endpoint_detection: true,
          client_reference_id: `g${s.guildId}-s${s.sid}-${lane.target ?? 'stt'}`,
          context: this.context(s),
          ...(lane.target ? { translation: { type: 'one_way', target_language: lane.target } } : {}),
        }));
        lane.wsOpen = true;
        lane.backoffMs = 500;
        for (const p of lane.pending) ws.send(p);
        lane.pending = [];
        lane.pendingBytes = 0;
        lane.keepalive = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN && performance.now() - s.lastAudioAt > KEEPALIVE_MS) ws.send(JSON.stringify({ type: 'keepalive' }));
        }, KEEPALIVE_MS);
        lane.keepalive.unref();
      } catch (e) {
        this.log.error('soniox key error', { err: e });
        ws.close();
      }
    });
    ws.on('message', (data) => {
      if (lane.ws !== ws) return;
      try {
        this.onSoniox(s, lane, JSON.parse(String(data)));
      } catch (e) {
        this.log.warn('bad soniox message', { err: e });
      }
    });
    ws.on('error', (e) => this.log.warn('soniox socket error', { sid: s.sid, lane: lane.target, err: e }));
    ws.on('close', () => {
      if (lane.ws !== ws) return;
      if (!lane.wsOpen) {
        // never got going: back off instead of retrying on every audio frame
        lane.retryAt = performance.now() + lane.backoffMs;
        lane.backoffMs = Math.min(lane.backoffMs * 2, 15_000);
      }
      this.flushPhrase(s, lane, true);
      if (lane.keepalive) clearInterval(lane.keepalive);
      lane.keepalive = null;
      lane.ws = null;
      lane.wsOpen = false;
    });
  }

  private closeLane(lane: Lane, graceful: boolean): void {
    const ws = lane.ws;
    if (lane.keepalive) clearInterval(lane.keepalive);
    if (lane.phraseTimer) clearTimeout(lane.phraseTimer);
    lane.keepalive = null;
    lane.phraseTimer = null;
    lane.pending = [];
    lane.pendingBytes = 0;
    if (!ws) return;
    if (graceful && ws.readyState === WebSocket.OPEN) {
      // empty frame = end of audio; Soniox finalises remaining tokens, then closes
      ws.send('');
      const t = setTimeout(() => ws.terminate(), 3_000);
      t.unref();
    } else {
      lane.ws = null;
      lane.wsOpen = false;
      ws.terminate();
    }
  }

  private closeLanes(s: Stream, graceful: boolean): void {
    for (const lane of s.lanes.values()) this.closeLane(lane, graceful);
  }

  private sweep(): void {
    const now = performance.now();
    for (const s of this.streams.values()) if (now - s.lastAudioAt > IDLE_CLOSE_MS) for (const l of s.lanes.values()) if (l.ws) this.closeLane(l, true);
  }

  private primaryLane(s: Stream): Lane | undefined {
    for (const l of s.lanes.values()) if (l.primary) return l;
    return undefined;
  }

  // ------------------------------------------------------------------ tokens
  private onSoniox(s: Stream, lane: Lane, d: Record<string, unknown>): void {
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
    const u = lane.utt;
    let tentative = '';
    let tentativeTr = '';
    let ended = false;
    let gotFinal = false;

    for (const t of tokens) {
      const isTr = t.translation_status === 'translation';
      const inTarget = lane.target !== null && t.language === lane.target;
      if (!t.is_final) {
        if (isTr) { if (inTarget) tentativeTr += t.text; } else tentative += t.text;
        continue;
      }
      if (t.text === '<end>' || t.text === '<fin>') {
        ended = true;
        continue;
      }
      if (!u.firstAt) u.firstAt = performance.now();
      if (!isTr) {
        if (typeof t.start_ms === 'number' && typeof t.end_ms === 'number' && lane.t0) {
          if (!u.absStart) u.absStart = lane.t0 + t.start_ms;
          u.absEnd = Math.max(u.absEnd, lane.t0 + t.end_ms);
        }
        u.original += t.text;
        if (t.language && t.text.trim()) u.langCount.set(t.language, (u.langCount.get(t.language) ?? 0) + 1);
        if (typeof t.confidence === 'number') {
          u.confSum += t.confidence;
          u.confN++;
        }
      }
      // target text = translations into the target + original words already in it (Taglish passthrough)
      if (inTarget) {
        // where the text switches between original words and translated words, Soniox may not
        // put a space between them ("internet ko" + "sobrang" -> "internet kosobrang"): add one
        const piece = joinPiece(u.text, t.text, isTr !== u.lastWasTr && u.text.length > 0);
        u.lastWasTr = isTr;
        u.text += piece;
        u.phrase.text += joinPiece(u.phrase.text, t.text, piece !== t.text && u.phrase.text.length > 0);
        if (isTr) {
          u.phrase.translated = true;
          u.translatedInto = true;
        }
        gotFinal = true;
      }
    }

    // live captions: the primary lane owns the original text; every lane adds its translation
    const primary = this.primaryLane(s);
    if (lane.primary) {
      const committed = u.original.trim();
      const key = committed + '|' + tentative;
      if (key !== s.lastPartial && (committed || tentative.trim())) {
        s.lastPartial = key;
        this.emit('event', { type: 'partial', sid: s.sid, utt_id: u.id, lang: topLang(u) ?? '', committed, tentative: tentative.trim() });
      }
    }
    if (lane.primary && lane.target && (gotFinal || tentativeTr)) {
      const txt = (u.text + tentativeTr).trim();
      const src = topLang(u);
      if (txt && lane.target !== src && primary) {
        this.emit('event', { type: 'partial_translation', sid: s.sid, utt_id: primary.utt.id, lang: src ?? '', translations: { [lane.target]: txt } });
      }
    }

    // Soniox delivers each translated phrase complete in one message, so speak it right away:
    // waiting for more words only adds delay.
    if (gotFinal || ended) this.flushPhrase(s, lane, true);
    if (ended) this.finishLaneUtt(s, lane);
  }

  /**
   * Which language a phrase is spoken in, in the voice channel itself: the first server
   * language that is not the one this person is speaking. (English speech -> French voice,
   * French speech -> English voice, anything else -> the main language.) Listeners on the
   * web companion get every language they picked.
   */
  private shouldSpeak(s: Stream, target: string, spoken: string | null): boolean {
    const g = this.guilds.get(s.guildId);
    if (!g || !g.audioTargets.includes(target) || target === spoken) return false;
    if (!g.channelDub.includes(target)) return true; // companion / mirror language
    return g.channelDub.find((l) => l !== spoken) === target;
  }

  /** Speak a finished phrase now; hold a short unfinished one briefly. */
  private flushPhrase(s: Stream, lane: Lane, force: boolean): void {
    if (lane.phraseTimer) clearTimeout(lane.phraseTimer);
    lane.phraseTimer = null;
    const u = lane.utt;
    const p = u.phrase;
    const text = p.text.trim();
    if (!text || !lane.target) return;
    // speak if any part of this utterance needed translating (keeps the English words of a
    // Taglish sentence inside an English dub), into the right language for this speaker
    if (/[\p{L}\p{N}]/u.test(text) && (p.translated || u.translatedInto) && this.shouldSpeak(s, lane.target, topLang(u))) this.speak(s, lane.target, text);
    u.phrase = { text: '', translated: false };
    void force;
  }

  private finishLaneUtt(s: Stream, lane: Lane): void {
    const u = lane.utt;
    lane.utt = newUtt(lane.nextUtt++);
    if (!lane.primary) {
      // A secondary language finished a sentence. Lanes can split sentences differently, so it is
      // matched to the caption by WHEN it was spoken (overlap), never by counting sentences.
      if (lane.target && u.text.trim()) {
        lane.completed.push({ text: u.text.trim(), start: u.absStart, end: u.absEnd, used: false });
        if (lane.completed.length > 20) lane.completed.shift();
        this.emit('event', { type: 'final_translation', sid: s.sid, lang: lane.target, text: u.text.trim(), abs_start: u.absStart, abs_end: u.absEnd });
      }
      return;
    }
    s.lastPartial = '';
    const text = u.original.trim();
    if (!text) return;
    const lang = topLang(u) ?? 'und';
    const g = this.guilds.get(s.guildId);
    const audio = new Set(g?.audioTargets ?? []);
    const translations: Record<string, { text: string | null; provider: string | null; mode: string | null; note: string }> = {};
    const tiers: Record<string, number> = {};
    for (const [k, l] of s.lanes) {
      if (!l.target) continue;
      let t = l === lane ? u.text.trim() : '';
      if (l !== lane) {
        // already finished in that language? take the sentence that overlaps this one in time
        const hit = bestOverlap(l.completed, u.absStart, u.absEnd);
        if (hit) { hit.used = true; t = hit.text; }
      }
      translations[k] = { text: t || (k === lang ? text : null), provider: 'soniox', mode: 'literal', note: '' };
      tiers[k] = audio.has(k) && ELEVEN_LANGS[k] ? 2 : 3;
    }
    const confidence = u.confN ? u.confSum / u.confN : 1;
    const sinceFirst = u.firstAt ? performance.now() - u.firstAt : 0;
    this.emit('event', {
      type: 'final', sid: s.sid, utt_id: u.id, user_id: s.userId, lang, lang_prob: 1, lid_reason: 'soniox',
      segments: [], text, confidence, flags: confidence < 0.5 ? ['low_confidence'] : [], translations, tiers,
      stt_provider: 'soniox', duration_s: sinceFirst / 1000, endpoint_reason: 'soniox',
      abs_start: u.absStart, abs_end: u.absEnd, latency: {},
    });
  }

  // ------------------------------------------------------------------ TTS
  private speak(s: Stream, lang: string, text: string): void {
    const elLang = ELEVEN_LANGS[lang];
    if (!elLang) return;
    const dubId = dubSeq++;
    const ctrl = new AbortController();
    const startedAt = performance.now();
    const voiceId = this.voiceFor(s);
    const previous = s.lastSaid.get(lang) ?? '';
    s.lastSaid.set(lang, text);
    this.dubs.set(dubId, { ctrl, sid: s.sid, startedAt });
    this.emit('event', {
      type: 'tts_start', dub_id: dubId, sid: s.sid, utt_id: this.primaryLane(s)?.utt.id ?? 0, user_id: s.userId, lang, text,
      tier: 2, voice: 'house', provider: 'elevenlabs', incremental: true, sample_rate: 48000,
    });
    void this.synthesize(dubId, { voiceId, elLang, text, previous }, ctrl.signal, startedAt);
  }

  /**
   * Each speaker keeps one voice for the whole call. Lower-pitched speakers get a lower voice,
   * higher-pitched a higher one, and two people in the same call never share a voice while
   * the pool has a free one.
   */
  voiceFor(s: Stream): string {
    if (this.o.elevenVoiceId) return this.o.elevenVoiceId;
    const chosen = this.o.voiceBank?.voiceFor(s.userId); // their own voice, or the one they picked
    if (chosen) return chosen;
    let g = this.voiceOf.get(s.guildId);
    if (!g) this.voiceOf.set(s.guildId, (g = new Map()));
    const have = g.get(s.userId);
    if (have) return have;
    const hz = s.pitch.hz;
    const pool = hz !== null && hz < PITCH_SPLIT_HZ ? this.o.voices.low : this.o.voices.high;
    // pitch not measured yet (first phrase): use a voice for now, but don't keep it for the call
    const keep = hz !== null;
    const other = pool === this.o.voices.low ? this.o.voices.high : this.o.voices.low;
    const used = new Set(g.values());
    // stable per user (same person, same voice next time), but skip voices taken in this call
    const start = hashStr(s.userId) % pool.length;
    let pick: string | undefined;
    for (let k = 0; k < pool.length && !pick; k++) if (!used.has(pool[(start + k) % pool.length]!)) pick = pool[(start + k) % pool.length];
    if (!pick && hz === null) pick = other.find((v) => !used.has(v)); // pitch unknown: any free voice
    pick ??= pool[start]!;
    if (keep) g.set(s.userId, pick);
    return pick;
  }

  private async synthesize(
    dubId: number,
    req: { voiceId: string; elLang: string; text: string; previous: string },
    signal: AbortSignal,
    startedAt: number,
  ): Promise<void> {
    let frames = 0;
    let firstAudio: number | undefined;
    let reason = 'done';
    let carry: Buffer | null = null;
    let release: (() => void) | null = null;
    try {
      const url = `${this.o.elevenBaseUrl}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}/stream?output_format=pcm_48000`;
      const body = JSON.stringify({
        text: req.text,
        model_id: this.o.elevenModel,
        language_code: req.elLang,
        // the previous phrase lets the voice carry its intonation across phrase boundaries
        ...(req.previous ? { previous_text: req.previous } : {}),
        voice_settings: { stability: 0.45, similarity_boost: 0.8, use_speaker_boost: true, speed: 1.05 },
      });
      release = await this.ttsSlot(signal); // stay within the ElevenLabs plan's concurrency (else requests fail)
      const res = await this.fetchWithFirstByteTimeout(url, body, signal);
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
      release?.();
      this.dubs.delete(dubId);
      this.emit('event', {
        type: 'tts_end', dub_id: dubId, cancelled: reason === 'cancelled', reason, truncated: null, frames,
        latency: firstAudio === undefined ? {} : { tts_first_audio: Math.round(firstAudio) },
      });
    }
  }

  private async ttsSlot(signal: AbortSignal): Promise<() => void> {
    if (this.ttsActive >= this.o.elevenConcurrency) {
      await new Promise<void>((res, rej) => {
        const go = () => res();
        this.ttsWaiting.push(go);
        signal.addEventListener('abort', () => {
          const i = this.ttsWaiting.indexOf(go);
          if (i >= 0) this.ttsWaiting.splice(i, 1);
          rej(new Error('cancelled while queued'));
        }, { once: true });
      });
    }
    this.ttsActive++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.ttsActive--;
      this.ttsWaiting.shift()?.();
    };
  }

  /** POST to ElevenLabs; if no response headers arrive within TTS_FIRST_BYTE_MS, retry once. */
  private async fetchWithFirstByteTimeout(url: string, body: string, signal: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), TTS_FIRST_BYTE_MS);
      try {
        const res = await fetch(url, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'xi-api-key': this.o.elevenKey, 'Content-Type': 'application/json', Accept: 'audio/pcm' },
          body,
        });
        clearTimeout(timer);
        if (!res.ok || !res.body) {
          const msg = `ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
          if (attempt < 3 && res.status === 429) { await new Promise((r) => setTimeout(r, 120 * (attempt + 1))); continue; } // plan busy: brief wait
          if (attempt === 0 && res.status >= 500) continue;
          throw new Error(msg);
        }
        return res;
      } catch (e) {
        clearTimeout(timer);
        if (signal.aborted || attempt >= 1) throw e;
        this.log.info('tts slow to start, retrying');
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  /** Keep a TLS connection to ElevenLabs open so the first dub of a turn doesn't pay for the handshake. */
  private warm(): void {
    const now = Date.now();
    if (now - this.lastWarm < WARM_EVERY_MS) return;
    this.lastWarm = now;
    fetch(`${this.o.elevenBaseUrl}/`, { method: 'HEAD', signal: AbortSignal.timeout(5_000) }).then((r) => r.body?.cancel(), () => {});
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
  return { id, original: '', langCount: new Map(), confSum: 0, confN: 0, text: '', phrase: { text: '', translated: false }, translatedInto: false, lastWasTr: false, firstAt: 0, absStart: 0, absEnd: 0 };
}

function topLang(u: Utt): string | null {
  let best: string | null = null;
  let n = 0;
  for (const [l, c] of u.langCount) if (c > n) [best, n] = [l, c];
  return best;
}

function hashStr(x: string): number {
  let h = 2166136261;
  for (let i = 0; i < x.length; i++) h = Math.imul(h ^ x.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Text to append so that two runs of words never fuse (adds a space only where one is missing). */
export function joinPiece(prev: string, next: string, boundary: boolean): string {
  if (!boundary || !prev || !next) return next;
  if (/\s$/.test(prev) || /^[\s.,!?;:)\]}'’"…-]/.test(next)) return next;
  return ' ' + next;
}

/** The finished sentence that overlaps [start, end] the most (null if none overlap). */
export function bestOverlap<T extends { start: number; end: number; used?: boolean }>(items: T[], start: number, end: number): T | null {
  let best: T | null = null;
  let bestOv = 0;
  for (const it of items) {
    if (it.used) continue;
    const ov = Math.min(end, it.end) - Math.max(start, it.start);
    if (ov > bestOv) { bestOv = ov; best = it; }
  }
  return best;
}
