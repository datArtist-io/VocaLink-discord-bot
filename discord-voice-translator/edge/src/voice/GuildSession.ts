/**
 * One live translation session in one guild voice channel.
 *
 * Owns: per-speaker uplinks (UserStream), dub playout (PlayoutScheduler) for
 * the main channel + mirror channels, caption rendering, web companion
 * fan-out, whisper DMs, analytics. Talks to Discord only through
 * VoiceLinkLike / CaptionSink / callbacks, so it runs unchanged in tests.
 */

import { EventEmitter } from 'node:events';

import { PlayoutScheduler, type DubMeta } from '../audio/PlayoutScheduler.js';
import { UserStream } from '../audio/UserStream.js';
import type { PcmDecoder } from '../audio/opus.js';
import { CaptionSink, formatCaption, formatTierNotice, type CaptionData } from '../discord/captions.js';
import type { Metrics } from '../metrics/Metrics.js';
import type { Json } from '../protocol/frames.js';
import type {
  FinalEvent,
  GuildConfigMsg,
  NoticeEvent,
  PartialEvent,
  PartialTranslationEvent,
  TtsEndEvent,
  TtsStartEvent,
} from '../protocol/messages.js';
import type { GuildSettings, Store } from '../store/Store.js';
import type { Logger } from '../util/log.js';
import type { WorkerClient } from '../worker/WorkerClient.js';
import type { WebHub } from '../web/hub.js';
import type { MemberInfo, VoiceLinkLike } from './types.js';

let globalSid = 1;

interface Speaker {
  userId: string;
  sid: number;
  name: string;
  stream: UserStream;
  decoder: PcmDecoder;
  opened: boolean;
  speechEndAt: number;
}

interface DubRoute {
  lang: string;
  userId: string;
  consumers: number;
  ended: boolean;
  startAt: number;
  uttKey: string;
}

interface UttState {
  key: string;
  userId: string;
  name: string;
  srcLang: string;
  original: string;
  translations: Record<string, string | null>;
  final: boolean;
  flags: string[];
  notes: string[];
  prob?: number;
  tiers?: Record<string, number>;
  endedAt: number;
  statTs?: number;
  firstAudioLogged?: boolean;
}

export interface WorkerSource extends EventEmitter {
  clientFor(guildId: string): WorkerClient;
}

export interface GuildSessionDeps {
  guildId: string;
  voice: VoiceLinkLike;
  workers: WorkerSource;
  store: Store;
  metrics: Metrics;
  captions: CaptionSink | null;
  resolveMember: (userId: string) => MemberInfo | null;
  decoderFactory: () => PcmDecoder;
  log: Logger;
  botUserId: string;
  hub?: WebHub;
  dm?: (userId: string, content: string) => Promise<void>;
  /** user ids currently in the voice channel (for whisper DMs) */
  listMembers?: () => string[];
  playout?: ConstructorParameters<typeof PlayoutScheduler>[0];
  tickMs?: number;
}

export class GuildSession extends EventEmitter {
  readonly guildId: string;
  readonly startedAt = Date.now();
  settings: GuildSettings;
  readonly main: PlayoutScheduler;
  readonly mirrors = new Map<string, { link: VoiceLinkLike; sched: PlayoutScheduler }>();
  private speakers = new Map<string, Speaker>();
  private sidToUser = new Map<number, string>();
  private dubs = new Map<number, DubRoute>();
  private utts = new Map<string, UttState>();
  private webLangs: string[] = [];
  private client: WorkerClient;
  private unbind: (() => void) | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private sessionRow = 0;
  private stopped = false;
  private sayAgainAt = new Map<string, number>();
  private tierNoticeShown = new Set<string>();
  private dmQueue = new Map<string, string[]>();
  private dmTimer: NodeJS.Timeout | null = null;
  private enrollTaps = new Map<string, { chunks: Buffer[]; resolve: (b: Buffer) => void; timer: NodeJS.Timeout; bytes: number; maxBytes: number }>();
  private lastNoticeAt = 0;
  readonly counts = { utterances: 0, speakers: new Set<string>(), dubsPlayed: 0, framesUp: 0 };

  constructor(private readonly d: GuildSessionDeps) {
    super();
    this.guildId = d.guildId;
    this.settings = d.store.getSettings(d.guildId);
    this.main = this.makeScheduler(this.settings.dubLang ?? '', d.voice);
    this.client = d.workers.clientFor(d.guildId);
  }

  // ------------------------------------------------------------------ lifecycle
  start(): void {
    this.sessionRow = this.d.store.startSession(this.guildId, this.d.voice.channelId);
    this.bindWorker(this.client);
    this.d.workers.on('reassign', this.onReassign);
    const v = this.d.voice;
    v.on('speaking', this.onSpeaking);
    v.on('packet', this.onPacket);
    v.on('idle', this.kickPlayout);
    this.ticker = setInterval(() => this.tick(), this.d.tickMs ?? 20);
    this.d.hub?.registerSession(this.guildId, this);
    this.pushConfig();
  }

  async stop(opts: { summary?: boolean } = {}): Promise<Record<string, unknown> | null> {
    if (this.stopped) return null;
    this.stopped = true;
    if (this.ticker) clearInterval(this.ticker);
    for (const sp of this.speakers.values()) {
      if (sp.opened) this.client.sendJson({ type: 'stream_close', sid: sp.sid });
      sp.decoder.destroy();
      this.client.dropStream(sp.sid);
    }
    let summary: Record<string, unknown> | null = null;
    if (opts.summary !== false && this.settings.summaries && this.counts.utterances > 0) {
      summary = await this.summarize(this.summaryLangs()).catch(() => null);
    }
    this.main.clear();
    for (const m of this.mirrors.values()) {
      m.sched.clear();
      m.link.destroy();
    }
    this.mirrors.clear();
    this.d.workers.off('reassign', this.onReassign);
    this.unbind?.();
    this.d.hub?.unregisterSession(this.guildId);
    if (this.dmTimer) clearTimeout(this.dmTimer);
    await this.flushDms();
    await this.d.captions?.flush(5000);
    this.d.captions?.stop();
    this.d.store.endSession(this.sessionRow, this.counts.utterances, this.counts.speakers.size);
    this.d.voice.destroy();
    this.emit('stopped');
    return summary;
  }

  describe(): Record<string, unknown> {
    const info = this.client.info;
    return {
      guild_id: this.guildId,
      channel_id: this.d.voice.channelId,
      settings: this.settings,
      speakers: [...this.speakers.values()].map((s) => ({ user_id: s.userId, name: s.name, sid: s.sid, active: s.stream.active })),
      worker: { name: this.client.name, status: this.client.status, tier: info?.hardware?.tier, mode: info?.policy?.mode },
      dub_queue: this.main.length,
      mirrors: [...this.mirrors.keys()],
      web_langs: this.webLangs,
      utterances: this.counts.utterances,
    };
  }

  // ------------------------------------------------------------------ settings / config
  updateSettings(patch: Partial<GuildSettings>): GuildSettings {
    this.settings = this.d.store.updateSettings(this.guildId, patch);
    this.pushConfig();
    return this.settings;
  }

  reloadSettings(): void {
    this.settings = this.d.store.getSettings(this.guildId);
    this.pushConfig();
  }

  setWebLangs(langs: string[]): void {
    this.webLangs = langs;
    this.pushConfig();
  }

  setSpeakLang(userId: string, lang: string | null): void {
    const sp = this.speakers.get(userId);
    if (sp?.opened) this.client.sendJson({ type: 'stream_update', sid: sp.sid, speak_lang: lang ?? 'auto' });
  }

  /** Forget a user immediately (e.g. /optout during a session). */
  dropUser(userId: string): void {
    const sp = this.speakers.get(userId);
    if (!sp) return;
    this.d.voice.unsubscribe(userId);
    if (sp.opened) this.client.sendJson({ type: 'stream_close', sid: sp.sid });
    this.client.dropStream(sp.sid);
    sp.decoder.destroy();
    this.speakers.delete(userId);
    this.sidToUser.delete(sp.sid);
  }

  attachMirror(lang: string, link: VoiceLinkLike): void {
    const sched = this.makeScheduler(lang, link);
    link.on('idle', () => this.kick(sched, link));
    this.mirrors.set(lang, { link, sched });
    this.pushConfig();
  }

  private makeScheduler(lang: string, link: VoiceLinkLike): PlayoutScheduler {
    const s = new PlayoutScheduler(this.d.playout);
    s.on('available', () => this.kick(s, link));
    s.on('drop', (it: DubMeta, reason: string) => {
      this.d.metrics.inc(`dub_dropped_${reason}`);
      this.releaseDub(it.dubId);
    });
    s.on('finish', (it: DubMeta) => {
      this.counts.dubsPlayed++;
      this.releaseDub(it.dubId);
    });
    s.on('start', (it: DubMeta) => this.onPlayStart(it, lang));
    return s;
  }

  private audioTargets(): string[] {
    const set = new Set<string>();
    if (this.settings.dubLang) set.add(this.settings.dubLang);
    for (const l of this.mirrors.keys()) set.add(l);
    for (const l of this.webLangs) set.add(l);
    return [...set];
  }

  private textTargets(): string[] {
    const set = new Set<string>(this.settings.textTargets);
    for (const l of this.webLangs) set.add(l);
    for (const u of this.d.store.whisperUsers([...this.speakers.keys(), ...this.listenerIds()])) if (u.hearLang) set.add(u.hearLang);
    return [...set];
  }

  private listenerIds(): string[] {
    return this.d.listMembers?.() ?? [];
  }

  guildConfig(): GuildConfigMsg {
    const s = this.settings;
    return {
      type: 'guild_config',
      guild_id: this.guildId,
      text_targets: this.textTargets(),
      audio_targets: this.audioTargets(),
      mode: s.mode,
      voice_mode: s.voiceMode,
      expected_langs: s.expectedLangs,
      glossary: this.d.store.glossary(this.guildId).map((g) => ({ source: g.source, target: g.target, src_lang: g.srcLang, tgt_lang: g.tgtLang, kind: g.kind })),
      clone_users: s.voiceMode === 'clone' ? this.d.store.enrolledUsers([...this.speakers.keys()]) : [],
      summaries: s.summaries,
    };
  }

  pushConfig(): void {
    if (!this.stopped) this.client.sendJson(this.guildConfig() as unknown as Json);
  }

  // ------------------------------------------------------------------ worker binding
  private replay = (): Json[] => {
    const msgs: Json[] = [this.guildConfig() as unknown as Json];
    for (const sp of this.speakers.values()) if (sp.opened) msgs.push(this.streamOpen(sp));
    return msgs;
  };

  private bindWorker(c: WorkerClient): void {
    this.unbind?.();
    this.client = c;
    const onEvent = (e: Json) => this.onWorkerEvent(e);
    const onAudio = (dubId: number, seq: number, pcm: Buffer) => this.onDubAudio(dubId, seq, pcm);
    const onStatus = (s: string) => {
      if (s === 'down') {
        // in-flight dubs will never finish, and dub ids restart on the new connection
        this.dubs.clear();
        this.main.clear();
        for (const m of this.mirrors.values()) m.sched.clear();
        this.notice('⏸️ Translation paused — reconnecting to the translation worker (audio is buffered).', 'worker');
      }
      if (s === 'ready') this.notice('▶️ Translation resumed.', 'worker');
    };
    c.on('event', onEvent);
    c.on('audio', onAudio);
    c.on('status', onStatus);
    const removeReplayer = c.addReplayer(this.replay);
    this.unbind = () => {
      c.off('event', onEvent);
      c.off('audio', onAudio);
      c.off('status', onStatus);
      removeReplayer();
    };
  }

  private onReassign = (guildId: string, next: WorkerClient): void => {
    if (guildId !== this.guildId || this.stopped) return;
    this.d.log.warn('moving guild to another worker', { worker: next.name });
    this.bindWorker(next);
    for (const m of this.replay()) next.sendJson(m);
  };

  private streamOpen(sp: Speaker): Json {
    const u = this.d.store.getUser(sp.userId);
    return { type: 'stream_open', sid: sp.sid, guild_id: this.guildId, user_id: sp.userId, name: sp.name, speak_lang: u.speakLang ?? 'auto' };
  }

  // ------------------------------------------------------------------ uplink
  private onSpeaking = (userId: string, speaking: boolean): void => {
    if (userId === this.d.botUserId) return;
    const m = this.d.resolveMember(userId);
    if (!m || m.bot) return;
    this.main.humanSpeaking(userId, speaking);
    if (speaking) {
      if (this.d.store.optedOut(userId) && !this.enrollTaps.has(userId)) return;
      this.ensureSpeaker(userId, m);
    } else {
      const sp = this.speakers.get(userId);
      if (sp) sp.speechEndAt = performance.now();
    }
  };

  private ensureSpeaker(userId: string, m: MemberInfo): Speaker {
    let sp = this.speakers.get(userId);
    if (sp) return sp;
    const sid = globalSid++;
    sp = {
      userId,
      sid,
      name: m.name,
      decoder: this.d.decoderFactory(),
      opened: false,
      speechEndAt: 0,
      stream: new UserStream(sid, (s, seq, pcm) => {
        this.counts.framesUp++;
        this.client.sendAudio(s, seq, pcm);
      }),
    };
    this.speakers.set(userId, sp);
    this.sidToUser.set(sid, userId);
    this.d.voice.subscribe(userId);
    return sp;
  }

  private onPacket = (userId: string, opus: Buffer): void => {
    const sp = this.speakers.get(userId);
    if (!sp) return;
    let pcm: Buffer;
    try {
      pcm = sp.decoder.decode(opus);
    } catch (e) {
      this.d.metrics.inc('opus_decode_errors');
      return;
    }
    const tap = this.enrollTaps.get(userId);
    if (tap) {
      tap.chunks.push(pcm);
      tap.bytes += pcm.length;
      if (tap.bytes >= tap.maxBytes) this.finishEnroll(userId);
      return; // enrollment audio is not translated
    }
    if (!sp.opened) {
      sp.opened = true;
      this.counts.speakers.add(userId);
      this.client.sendJson(this.streamOpen(sp));
      if (this.settings.voiceMode === 'clone') this.pushConfig();
    }
    sp.stream.onFrame(pcm);
  };

  private tick(): void {
    for (const sp of this.speakers.values()) sp.stream.tick();
  }

  // ------------------------------------------------------------------ enrollment capture
  /** Capture up to maxMs of one user's audio (for /voice enroll). */
  captureEnrollment(userId: string, maxMs = 20_000): Promise<Buffer> {
    const m = this.d.resolveMember(userId);
    if (m) this.ensureSpeaker(userId, m);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finishEnroll(userId), maxMs + 500);
      this.enrollTaps.set(userId, { chunks: [], resolve, timer, bytes: 0, maxBytes: Math.round((maxMs / 1000) * 32000) });
    });
  }

  private finishEnroll(userId: string): void {
    const tap = this.enrollTaps.get(userId);
    if (!tap) return;
    clearTimeout(tap.timer);
    this.enrollTaps.delete(userId);
    tap.resolve(Buffer.concat(tap.chunks));
  }

  enroll(userId: string, phrase: string, pcm: Buffer, lang: string | null, consentVersion: string): Promise<Json> {
    const header = { type: 'voice_enroll', user_id: userId, guild_id: this.guildId, phrase, lang, consent_version: consentVersion };
    return new Promise((resolve, reject) => {
      const reqId = `enroll-${userId}-${Date.now()}`;
      const timer = setTimeout(() => {
        this.client.off('event', on);
        reject(new Error('enrollment timed out'));
      }, 60_000);
      const on = (e: Json) => {
        if (e.type === 'voice_enroll_result' && e.req_id === reqId) {
          clearTimeout(timer);
          this.client.off('event', on);
          resolve(e);
        }
      };
      this.client.on('event', on);
      if (!this.client.sendBlob({ ...header, req_id: reqId }, pcm)) {
        clearTimeout(timer);
        this.client.off('event', on);
        reject(new Error('translation worker is not connected'));
      }
    });
  }

  // ------------------------------------------------------------------ worker events
  private onWorkerEvent(e: Json): void {
    const sid = typeof e.sid === 'number' ? e.sid : undefined;
    if (e.type === 'tts_end' || (sid !== undefined && this.sidToUser.has(sid))) {
      switch (e.type) {
        case 'partial':
          return this.onPartial(e as unknown as PartialEvent);
        case 'partial_translation':
          return this.onPartialTranslation(e as unknown as PartialTranslationEvent);
        case 'final':
          return this.onFinal(e as unknown as FinalEvent);
        case 'tts_start':
          return this.onTtsStart(e as unknown as TtsStartEvent);
        case 'tts_end':
          return this.onTtsEnd(e as unknown as TtsEndEvent);
        case 'notice':
          return this.onNotice(e as unknown as NoticeEvent);
        case 'lang_switch':
          this.d.metrics.inc('lang_switches');
          return;
        case 'error':
          this.d.log.warn('worker pipeline error', { message: e.message, stage: e.stage });
          return;
        default:
          return;
      }
    }
  }

  private uttKey(sid: number, utt: number): string {
    return `${sid}:${utt}`;
  }

  private nameOf(sid: number): { userId: string; name: string } {
    const userId = this.sidToUser.get(sid) ?? '?';
    return { userId, name: this.speakers.get(userId)?.name ?? 'speaker' };
  }

  private onPartial(e: PartialEvent): void {
    const key = this.uttKey(e.sid, e.utt_id);
    const { userId, name } = this.nameOf(e.sid);
    const u = this.utts.get(key) ?? { key, userId, name, srcLang: e.lang, original: '', translations: {}, final: false, flags: [], notes: [], endedAt: 0 };
    if (u.final) return;
    u.original = `${e.committed} ${e.tentative}`.trim();
    u.srcLang = e.lang;
    this.utts.set(key, u);
    this.render(u);
  }

  private onPartialTranslation(e: PartialTranslationEvent): void {
    const u = this.utts.get(this.uttKey(e.sid, e.utt_id));
    if (!u || u.final) return;
    u.translations = { ...u.translations, ...e.translations };
    this.render(u);
  }

  private onFinal(e: FinalEvent): void {
    const key = this.uttKey(e.sid, e.utt_id);
    const { userId, name } = this.nameOf(e.sid);
    const translations: Record<string, string | null> = {};
    const notes: string[] = [];
    for (const [lang, t] of Object.entries(e.translations)) {
      translations[lang] = t.text;
      if (t.note) notes.push(`${lang.toUpperCase()}: ${t.note}`);
    }
    const flags = [...e.flags];
    if (flags.includes('low_confidence')) {
      const last = this.sayAgainAt.get(userId) ?? 0;
      if (Date.now() - last < 30_000) flags.splice(flags.indexOf('low_confidence'), 1);
      else this.sayAgainAt.set(userId, Date.now());
    }
    const sp = this.speakers.get(userId);
    const u: UttState = {
      key, userId, name, srcLang: e.lang, original: e.text, translations, final: true, flags, notes,
      prob: e.lang_prob, tiers: e.tiers, endedAt: sp?.speechEndAt ?? performance.now(),
    };
    this.utts.set(key, u);
    this.counts.utterances++;
    this.render(u);
    this.whisper(u);
    // tier notices (once per language per session)
    for (const [lang, tier] of Object.entries(e.tiers)) {
      const k = `${lang}:${tier}`;
      if (tier >= 2 || this.tierNoticeShown.has(k)) continue;
      this.tierNoticeShown.add(k);
      const reasons = this.client.info?.languages?.[lang]?.reasons ?? [];
      this.d.captions?.notice(formatTierNotice(lang, tier, reasons));
      this.d.hub?.notice(this.guildId, formatTierNotice(lang, tier, reasons));
    }
    // analytics (no text)
    const lat = e.latency;
    const ts = Date.now();
    u.statTs = ts;
    const tiers = Object.values(e.tiers);
    this.d.store.recordUtterance({
      guildId: this.guildId, ts, srcLang: e.lang, targets: Object.keys(e.translations), tierMin: tiers.length ? Math.min(...tiers) : null,
      sttMs: lat.stt ?? null, mtMs: lat.mt !== undefined && lat.stt !== undefined ? lat.mt - lat.stt : null,
      endpointMs: lat.vad_endpoint ?? null, captionMs: lat.mt !== undefined ? (lat.vad_endpoint ?? 0) + lat.mt : null,
      firstAudioMs: null, flags: e.flags, sttProvider: e.stt_provider,
    });
    if (lat.vad_endpoint !== undefined) this.d.metrics.observe('vad_endpoint', lat.vad_endpoint);
    if (lat.stt !== undefined) this.d.metrics.observe('stt', lat.stt);
    if (lat.mt !== undefined && lat.stt !== undefined) this.d.metrics.observe('mt', lat.mt - lat.stt);
    if (lat.mt !== undefined) this.d.metrics.observe('end_to_caption', (lat.vad_endpoint ?? 0) + lat.mt);
    this.d.metrics.inc('utterances');
    this.d.metrics.inc(`src_${e.lang}`);
    this.emit('final', e);
    if (this.utts.size > 300) {
      const keys = [...this.utts.keys()];
      for (const k of keys.slice(0, 100)) this.utts.delete(k);
    }
  }

  private render(u: UttState): void {
    const shown: Record<string, string | null> = {};
    for (const l of this.settings.textTargets) if (l !== u.srcLang && l in u.translations) shown[l] = u.translations[l] ?? null;
    const data: CaptionData = {
      name: u.name, srcLang: u.srcLang, prob: u.final ? u.prob : undefined, original: u.original, translations: shown,
      partial: !u.final, flags: u.flags, notes: u.final ? u.notes : [], voiceTier: u.tiers,
    };
    this.d.captions?.upsert(u.key, formatCaption(data), u.final);
    this.d.hub?.caption(this.guildId, { name: u.name, userId: u.userId, srcLang: u.srcLang, original: u.original, translations: u.translations, final: u.final, uttKey: u.key });
  }

  /** Called by the caption sink once a caption message exists (for /correct). */
  indexCaption(key: string, messageId: string): void {
    const u = this.utts.get(key);
    if (u?.final) this.d.store.indexCaption(messageId, this.guildId, u.userId, u.srcLang, u.original, u.translations);
  }

  private onNotice(e: NoticeEvent): void {
    this.d.metrics.inc(`notice_${e.code}`);
    if (e.code === 'stt_unavailable' || e.code === 'tts_unavailable') this.notice(`ℹ️ ${e.message}`, e.code);
  }

  private notice(text: string, _kind: string): void {
    this.d.captions?.notice(text);
    this.d.hub?.notice(this.guildId, text);
  }

  // ------------------------------------------------------------------ dubs
  private onTtsStart(e: TtsStartEvent): void {
    const meta: DubMeta = { dubId: e.dub_id, userId: e.user_id, lang: e.lang, text: e.text, incremental: e.incremental };
    const route: DubRoute = { lang: e.lang, userId: e.user_id, consumers: 0, ended: false, startAt: performance.now(), uttKey: this.uttKey(e.sid, e.utt_id) };
    this.dubs.set(e.dub_id, route);
    if (this.settings.dubLang === e.lang) {
      route.consumers++;
      this.main.enqueue(meta);
    }
    const mirror = this.mirrors.get(e.lang);
    if (mirror) {
      route.consumers++;
      mirror.sched.enqueue(meta);
    }
    if (this.webLangs.includes(e.lang)) {
      route.consumers++; // web listeners never cancel
      this.d.hub?.dubStart(this.guildId, e.lang, { dub_id: e.dub_id, user_id: e.user_id, text: e.text, voice: e.voice });
    }
    if (route.consumers === 0) {
      // nobody needs this audio any more (e.g. settings changed) - stop the worker
      this.client.sendJson({ type: 'cancel_dub', dub_id: e.dub_id, reason: 'no_consumer' });
      this.dubs.delete(e.dub_id);
    }
  }

  private onDubAudio(dubId: number, seq: number, pcm: Buffer): void {
    const r = this.dubs.get(dubId);
    if (!r) return;
    if (this.settings.dubLang === r.lang) this.main.push(dubId, pcm);
    this.mirrors.get(r.lang)?.sched.push(dubId, pcm);
    if (this.webLangs.includes(r.lang)) this.d.hub?.dubAudio(this.guildId, r.lang, dubId, seq, pcm);
  }

  private onTtsEnd(e: TtsEndEvent): void {
    const r = this.dubs.get(e.dub_id);
    if (!r) return;
    r.ended = true;
    this.main.end(e.dub_id);
    this.mirrors.get(r.lang)?.sched.end(e.dub_id);
    if (this.webLangs.includes(r.lang)) {
      this.d.hub?.dubEnd(this.guildId, r.lang, e.dub_id);
      this.releaseDub(e.dub_id);
    }
  }

  private releaseDub(dubId: number): void {
    const r = this.dubs.get(dubId);
    if (!r) return;
    r.consumers--;
    if (r.consumers <= 0) {
      if (!r.ended) this.client.sendJson({ type: 'cancel_dub', dub_id: dubId, reason: 'dropped' });
      this.dubs.delete(dubId);
    }
  }

  private onPlayStart(it: DubMeta, lang: string): void {
    const r = this.dubs.get(it.dubId);
    if (!r) return;
    const u = this.utts.get(r.uttKey);
    if (u && !u.firstAudioLogged && lang === this.settings.dubLang) {
      u.firstAudioLogged = true;
      const ms = performance.now() - u.endedAt;
      if (ms > 0 && ms < 30_000) {
        this.d.metrics.observe('end_to_first_audio_edge', ms);
        if (u.statTs) this.d.store.updateFirstAudio(this.guildId, u.statTs, ms);
      }
    }
  }

  private kickPlayout = (): void => this.kick(this.main, this.d.voice);

  private kick(sched: PlayoutScheduler, link: VoiceLinkLike): void {
    if (this.stopped || link.isPlaying() || !sched.hasPlayable()) return;
    link.play(sched);
  }

  // ------------------------------------------------------------------ whisper DMs
  private whisper(u: UttState): void {
    if (!this.d.dm) return;
    for (const p of this.d.store.whisperUsers(this.memberIdsForWhisper())) {
      if (p.userId === u.userId || !p.hearLang || p.hearLang === u.srcLang) continue;
      const text = u.translations[p.hearLang];
      if (!text) continue;
      const q = this.dmQueue.get(p.userId) ?? [];
      q.push(`**${u.name}**: ${text}`);
      this.dmQueue.set(p.userId, q);
    }
    if (this.dmQueue.size && !this.dmTimer) this.dmTimer = setTimeout(() => void this.flushDms(), 3000);
  }

  private memberIdsForWhisper(): string[] {
    return [...new Set([...this.speakers.keys(), ...this.listenerIds()])];
  }

  private async flushDms(): Promise<void> {
    this.dmTimer = null;
    const batch = [...this.dmQueue.entries()];
    this.dmQueue.clear();
    for (const [userId, lines] of batch) {
      const content = lines.join('\n').slice(0, 1900);
      await this.d.dm?.(userId, content).catch(() => this.d.metrics.inc('dm_errors'));
    }
  }

  // ------------------------------------------------------------------ summaries / text
  summaryLangs(): string[] {
    return [...new Set(['en', ...this.settings.textTargets])];
  }

  /** Post-call (clear=true) or mid-call (clear=false) multilingual summary. */
  async summarize(langs: string[], clear = true): Promise<Record<string, unknown>> {
    return this.client.request({ type: 'summarize', guild_id: this.guildId, langs, clear }, 'summary_result', 60_000);
  }
}
