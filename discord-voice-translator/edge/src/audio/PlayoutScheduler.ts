/**
 * Dub playout policy for ONE output (the main voice channel, a mirror
 * channel, or a web listener). A Discord bot has a single output stream per
 * channel, so dubs are played one at a time:
 *
 *  - FIFO by arrival; at most `maxQueue` waiting (oldest waiting dropped);
 *  - stale drop: a dub that cannot start within `staleMs` is dropped
 *    (captions still show it);
 *  - prebuffer `prebufferMs` before starting to avoid an immediate underrun;
 *  - ducking: while any human is talking, dubs play at `duckGain`;
 *  - barge-in: if the dub's own speaker starts a new utterance and more than
 *    `cutRemainingMs` of the old dub remains, it fades out and is cut.
 *
 * Pure logic (no Discord imports) so it is unit-testable.
 */

import { EventEmitter } from 'node:events';

import { BYTES_20MS_48K_MONO, monoToStereoGain } from './pcm.js';

export interface DubMeta {
  dubId: number;
  userId: string;
  lang: string;
  text?: string;
  incremental?: boolean;
}

interface Item extends DubMeta {
  chunks: Buffer[];
  buffered: number;
  ended: boolean;
  receivedAt: number;
  startedAt: number | null;
  fading: boolean;
}

export interface PlayoutOptions {
  staleMs?: number;
  maxQueue?: number;
  duckGain?: number;
  rampMs?: number;
  cutRemainingMs?: number;
  prebufferMs?: number;
  now?: () => number;
}

export type PullResult = { frame: Buffer } | { wait: true } | { end: number } | { idle: true };

const BYTES_PER_MS = 96; // 48 kHz mono s16

export class PlayoutScheduler extends EventEmitter {
  private queue: Item[] = [];
  private speaking = new Set<string>();
  private gain = 1;
  private readonly o: Required<Omit<PlayoutOptions, 'now'>>;
  private readonly now: () => number;
  stats = { played: 0, droppedStale: 0, droppedQueue: 0, bargeIns: 0, underruns: 0 };

  constructor(opts: PlayoutOptions = {}) {
    super();
    this.o = {
      staleMs: opts.staleMs ?? 3000,
      maxQueue: opts.maxQueue ?? 3,
      duckGain: opts.duckGain ?? 0.35,
      rampMs: opts.rampMs ?? 60,
      cutRemainingMs: opts.cutRemainingMs ?? 1500,
      prebufferMs: opts.prebufferMs ?? 60,
    };
    this.now = opts.now ?? (() => performance.now());
  }

  get length(): number {
    return this.queue.length;
  }

  current(): (DubMeta & { startedAt: number | null }) | null {
    return this.queue[0] ?? null;
  }

  enqueue(meta: DubMeta): void {
    this.queue.push({ ...meta, chunks: [], buffered: 0, ended: false, receivedAt: this.now(), startedAt: null, fading: false });
    const waiting = this.queue.filter((i) => i.startedAt === null);
    while (waiting.length > this.o.maxQueue) {
      const victim = waiting.shift()!;
      this.drop(victim, 'queue_full');
      this.stats.droppedQueue++;
    }
    this.emit('available');
  }

  push(dubId: number, pcm: Buffer): void {
    const it = this.queue.find((i) => i.dubId === dubId);
    if (!it) return;
    it.chunks.push(pcm);
    it.buffered += pcm.length;
    this.emit('available');
  }

  end(dubId: number): void {
    const it = this.queue.find((i) => i.dubId === dubId);
    if (it) {
      it.ended = true;
      this.emit('available');
    }
  }

  cancel(dubId: number, reason = 'cancelled'): void {
    const it = this.queue.find((i) => i.dubId === dubId);
    if (it) this.drop(it, reason);
  }

  clear(): void {
    for (const it of [...this.queue]) this.drop(it, 'cleared');
  }

  /** A human started/stopped talking in the channel. */
  humanSpeaking(userId: string, speaking: boolean): void {
    if (speaking) {
      this.speaking.add(userId);
      const cur = this.queue[0];
      if (cur && cur.startedAt !== null && cur.userId === userId && !cur.fading) {
        const remainingMs = cur.ended ? cur.buffered / BYTES_PER_MS : Infinity;
        if (remainingMs > this.o.cutRemainingMs) {
          cur.fading = true;
          this.stats.bargeIns++;
        }
      }
    } else {
      this.speaking.delete(userId);
    }
  }

  hasPlayable(): boolean {
    this.dropStale();
    const it = this.queue[0];
    if (!it) return false;
    return it.ended || it.buffered >= this.o.prebufferMs * BYTES_PER_MS;
  }

  /** Next 20 ms stereo 48 kHz frame of the current dub. */
  pull(): PullResult {
    this.dropStale();
    const it = this.queue[0];
    if (!it) return { idle: true };
    if (it.startedAt === null) {
      if (!it.ended && it.buffered < this.o.prebufferMs * BYTES_PER_MS) return { wait: true };
      it.startedAt = this.now();
      this.emit('start', it);
    }
    if (it.buffered < BYTES_20MS_48K_MONO && !it.ended) {
      this.stats.underruns++;
      return { wait: true };
    }
    if (it.buffered === 0 && it.ended) {
      this.finish(it);
      return { end: it.dubId };
    }
    const mono = this.take(it, BYTES_20MS_48K_MONO);
    const target = it.fading ? 0 : this.speaking.size > 0 && !this.onlySpeaker(it.userId) ? this.o.duckGain : 1;
    const step = 20 / this.o.rampMs;
    const g0 = this.gain;
    const g1 = target > g0 ? Math.min(target, g0 + step) : Math.max(target, g0 - step);
    this.gain = g1;
    const frame = monoToStereoGain(mono, g0, g1);
    if (it.fading && g1 <= 0) {
      this.drop(it, 'barge_in');
      this.gain = 1;
    }
    return { frame };
  }

  private onlySpeaker(userId: string): boolean {
    // the dub's own speaker talking again is handled by barge-in, not ducking
    return this.speaking.size === 1 && this.speaking.has(userId);
  }

  private take(it: Item, n: number): Buffer {
    const out = Buffer.alloc(n);
    let off = 0;
    while (off < n && it.chunks.length) {
      const c = it.chunks[0]!;
      const k = Math.min(n - off, c.length);
      c.copy(out, off, 0, k);
      off += k;
      if (k === c.length) it.chunks.shift();
      else it.chunks[0] = c.subarray(k);
    }
    it.buffered -= off;
    return out;
  }

  private dropStale(): void {
    const now = this.now();
    for (const it of [...this.queue]) {
      if (it.startedAt === null && now - it.receivedAt > this.o.staleMs) {
        this.drop(it, 'stale');
        this.stats.droppedStale++;
      }
    }
  }

  private finish(it: Item): void {
    this.queue = this.queue.filter((x) => x !== it);
    this.stats.played++;
    this.gain = 1;
    this.emit('finish', it);
  }

  private drop(it: Item, reason: string): void {
    const wasPlaying = it.startedAt !== null;
    this.queue = this.queue.filter((x) => x !== it);
    this.emit('drop', it, reason, wasPlaying);
    this.emit('available'); // wake a waiting reader so it can move on (next dub or end)
  }
}
