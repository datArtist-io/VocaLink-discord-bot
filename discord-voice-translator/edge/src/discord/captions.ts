/**
 * Caption formatting and a rate-limit-aware writer for a caption thread.
 *
 * Discord allows roughly 5 messages per 5 s per channel. The sink:
 *  - keeps one message per utterance, editing it from partial -> final;
 *  - debounces partial edits (>= editIntervalMs apart per message);
 *  - coalesces: only the newest content per utterance is ever written;
 *  - when finals pile up (heavy cross-talk) it posts them as one digest
 *    message instead of falling behind.
 */

import { languageName } from '../languages.js';

export interface CaptionMessage {
  id: string;
  edit(content: string): Promise<unknown>;
}

export interface CaptionTarget {
  send(content: string): Promise<CaptionMessage>;
}

export interface CaptionData {
  name: string;
  srcLang: string;
  prob?: number;
  original: string;
  translations: Record<string, string | null>;
  partial?: boolean;
  flags?: string[];
  notes?: string[];
  voiceTier?: Record<string, number>;
}

const MAX_LEN = 1900;

export function escapeMd(s: string): string {
  return s.replace(/([\\*_~`|>])/g, '\\$1').replace(/@(everyone|here)/g, '@\u200b$1').replace(/<@/g, '<@\u200b');
}

const TIER_ICON: Record<number, string> = { 1: '🗣️', 2: '🔊', 3: '💬', 0: '⛔' };

export function formatCaption(c: CaptionData): string {
  const head = `**${escapeMd(c.name)}** · ${c.srcLang.toUpperCase()}${c.prob ? ` ${Math.round(c.prob * 100)}%` : ''}`;
  const lines = [head];
  if (c.partial) {
    lines.push(`*${escapeMd(c.original)}* ✍️`);
  } else {
    lines.push(`> ${escapeMd(c.original)}`);
  }
  for (const [lang, text] of Object.entries(c.translations)) {
    if (!text) continue;
    const icon = c.voiceTier?.[lang] !== undefined ? ` ${TIER_ICON[c.voiceTier[lang]!] ?? ''}` : '';
    lines.push(`→ **${lang.toUpperCase()}**${icon} ${c.partial ? '*' : ''}${escapeMd(text)}${c.partial ? '…*' : ''}`);
  }
  if (c.flags?.includes('low_confidence')) lines.push('⚠️ *Low confidence — could you say that again?*');
  for (const n of c.notes ?? []) if (n) lines.push(`-# ${escapeMd(n)}`);
  let out = lines.join('\n');
  if (out.length > MAX_LEN) out = out.slice(0, MAX_LEN - 1) + '…';
  return out;
}

export function formatTierNotice(lang: string, tier: number, reasons: string[]): string {
  const label = { 1: 'cloned-voice speech', 2: 'standard-voice speech', 3: 'captions only', 0: 'not available' }[tier] ?? '?';
  return `ℹ️ **${languageName(lang)}**: ${label}${reasons.length ? ` — ${reasons.join('; ')}` : ''}`;
}

interface Entry {
  key: string;
  content: string;
  final: boolean;
  msg: CaptionMessage | null;
  lastWrite: number;
  written: string;
  inflight: boolean;
  digest: boolean;
}

export interface CaptionSinkOptions {
  editIntervalMs?: number;
  burst?: number;
  refillMs?: number;
  digestThreshold?: number;
  now?: () => number;
  onError?: (e: unknown) => void;
  onWritten?: (key: string, messageId: string) => void;
}

export class CaptionSink {
  private entries = new Map<string, Entry>();
  private order: string[] = [];
  private tokens: number;
  private lastRefill: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private recentNotices = new Map<string, number>();
  private readonly o: Required<Omit<CaptionSinkOptions, 'now' | 'onError' | 'onWritten'>>;
  private readonly onWritten: (key: string, messageId: string) => void;
  private readonly now: () => number;
  stats = { sends: 0, edits: 0, digests: 0, errors: 0 };

  constructor(private readonly target: CaptionTarget, opts: CaptionSinkOptions = {}) {
    this.o = {
      editIntervalMs: opts.editIntervalMs ?? 1200,
      burst: opts.burst ?? 5,
      refillMs: opts.refillMs ?? 1000,
      digestThreshold: opts.digestThreshold ?? 3,
    };
    this.now = opts.now ?? (() => Date.now());
    this.tokens = this.o.burst;
    this.lastRefill = this.now();
    this.onError = opts.onError ?? (() => {});
    this.onWritten = opts.onWritten ?? (() => {});
  }

  private onError: (e: unknown) => void;

  messageIdFor(key: string): string | undefined {
    return this.entries.get(key)?.msg?.id;
  }

  upsert(key: string, content: string, final: boolean): void {
    let e = this.entries.get(key);
    if (!e) {
      e = { key, content, final, msg: null, lastWrite: 0, written: '', inflight: false, digest: false };
      this.entries.set(key, e);
      this.order.push(key);
      if (this.entries.size > 500) this.gc();
    } else {
      if (e.digest) return; // digested messages are not edited further
      if (e.final && !final) return; // never regress a final to a partial
      e.content = content;
      e.final = final;
    }
    if (!this.order.includes(key)) this.order.push(key);
    this.schedule(0);
  }

  notice(content: string, dedupeMs = 60_000): void {
    const t = this.now();
    const last = this.recentNotices.get(content);
    if (last !== undefined && t - last < dedupeMs) return;
    this.recentNotices.set(content, t);
    this.upsert(`notice:${t}:${Math.random()}`, content, true);
  }

  /** Resolve once everything pending has been written (or failed). */
  async flush(timeoutMs = 10_000): Promise<void> {
    const end = this.now() + timeoutMs;
    while (this.order.length && this.now() < end) {
      this.schedule(0);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------------
  private refill(): void {
    const t = this.now();
    const add = Math.floor((t - this.lastRefill) / this.o.refillMs);
    if (add > 0) {
      this.tokens = Math.min(this.o.burst, this.tokens + add);
      this.lastRefill += add * this.o.refillMs;
    }
  }

  private schedule(ms: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, ms);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.refill();
      const t = this.now();
      // digest when many finals are waiting for a first send
      const unsentFinals = this.order.map((k) => this.entries.get(k)!).filter((e) => e && !e.msg && e.final && !e.inflight);
      if (unsentFinals.length > this.o.digestThreshold && this.tokens >= 1) {
        const batch: Entry[] = [];
        let len = 0;
        for (const e of unsentFinals) {
          if (len + e.content.length + 2 > MAX_LEN) break;
          batch.push(e);
          len += e.content.length + 2;
        }
        if (batch.length > 1) {
          this.tokens--;
          await this.write(batch, batch.map((b) => b.content).join('\n\n'));
          this.stats.digests++;
        }
      }
      let nextDelay = Infinity;
      for (const key of [...this.order]) {
        const e = this.entries.get(key);
        if (!e || e.inflight) continue;
        if (e.written === e.content) {
          this.order = this.order.filter((k) => k !== key);
          continue;
        }
        if (e.msg && !e.final) {
          const wait = e.lastWrite + this.o.editIntervalMs - t;
          if (wait > 0) {
            nextDelay = Math.min(nextDelay, wait);
            continue;
          }
        }
        if (this.tokens < 1) {
          nextDelay = Math.min(nextDelay, this.o.refillMs - (t - this.lastRefill));
          break;
        }
        this.tokens--;
        await this.write([e], e.content);
      }
      if (this.order.length) this.schedule(Number.isFinite(nextDelay) ? Math.max(20, nextDelay) : 50);
    } finally {
      this.running = false;
    }
  }

  private async write(es: Entry[], content: string): Promise<void> {
    const content0 = es.map((e) => e.content);
    for (const e of es) e.inflight = true;
    try {
      const head = es[0]!;
      if (es.length === 1 && head.msg) {
        await head.msg.edit(content);
        this.stats.edits++;
      } else {
        const msg = await this.target.send(content);
        this.stats.sends++;
        for (const e of es) {
          e.msg = msg;
          if (es.length > 1) e.digest = true;
          this.onWritten(e.key, msg.id);
        }
      }
      es.forEach((e, i) => {
        e.written = es.length > 1 ? e.content : content0[i]!;
        e.lastWrite = this.now();
      });
    } catch (err) {
      this.stats.errors++;
      this.onError(err);
      for (const e of es) e.written = e.content; // give up on this version; a newer upsert retries
    } finally {
      for (const e of es) e.inflight = false;
    }
  }

  private gc(): void {
    const keep = new Set(this.order);
    const keys = [...this.entries.keys()];
    for (const k of keys.slice(0, keys.length - 300)) if (!keep.has(k)) this.entries.delete(k);
  }
}
