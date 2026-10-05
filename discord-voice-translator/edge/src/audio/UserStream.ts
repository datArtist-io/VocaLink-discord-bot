/**
 * Per-speaker uplink to the worker.
 *
 * Discord clients stop sending packets when a user stops talking, so the
 * worker would never "hear" the silence that ends an utterance. UserStream
 * keeps the worker's timeline real-time: after `fillAfterMs` without packets
 * it emits silence frames (driven by tick() every 20 ms) for up to
 * `idleSilenceMs`, then goes idle. Gaps longer than jitter are also filled
 * when packets resume, so packet loss (e.g. during DAVE key transitions)
 * shows up as short silences instead of compressing time.
 */

import { BYTES_20MS_16K_MONO, silence } from './pcm.js';

export type FrameSink = (sid: number, seq: number, pcm: Buffer) => void;

export interface UserStreamOptions {
  fillAfterMs?: number;
  idleSilenceMs?: number;
  now?: () => number;
}

const SILENCE = silence(BYTES_20MS_16K_MONO);

export class UserStream {
  seq = 0;
  active = false;
  lastPacketAt = 0;
  framesReal = 0;
  framesFilled = 0;
  private lastSlotAt = 0;
  private silentMs = 0;
  private readonly fillAfterMs: number;
  private readonly idleSilenceMs: number;
  private readonly now: () => number;

  constructor(readonly sid: number, private readonly sink: FrameSink, opts: UserStreamOptions = {}) {
    this.fillAfterMs = opts.fillAfterMs ?? 100;
    this.idleSilenceMs = opts.idleSilenceMs ?? 1500;
    this.now = opts.now ?? (() => performance.now());
  }

  private emit(pcm: Buffer): void {
    this.sink(this.sid, this.seq, pcm);
    this.seq = (this.seq + 1) >>> 0;
  }

  /** One decoded 20 ms frame (640 bytes) from Discord. */
  onFrame(pcm: Buffer): void {
    const now = this.now();
    if (this.active && now - this.lastSlotAt > this.fillAfterMs) this.fillUntil(now - 20);
    // larger decoded buffers (e.g. 40/60 ms Opus frames) are split
    for (let off = 0; off < pcm.length; off += BYTES_20MS_16K_MONO) {
      let f = pcm.subarray(off, off + BYTES_20MS_16K_MONO);
      if (f.length < BYTES_20MS_16K_MONO) f = Buffer.concat([f, silence(BYTES_20MS_16K_MONO - f.length)]);
      this.emit(f);
      this.framesReal++;
    }
    this.active = true;
    this.silentMs = 0;
    this.lastPacketAt = now;
    this.lastSlotAt = now;
  }

  /** Call every ~20 ms. */
  tick(): void {
    if (!this.active) return;
    const now = this.now();
    if (now - this.lastPacketAt < this.fillAfterMs) return;
    this.fillUntil(now);
  }

  private fillUntil(t: number): void {
    let n = 0;
    while (this.lastSlotAt + 20 <= t && n < 50) {
      this.emit(SILENCE);
      this.framesFilled++;
      this.lastSlotAt += 20;
      this.silentMs += 20;
      n++;
      if (this.silentMs >= this.idleSilenceMs) {
        this.active = false;
        return;
      }
    }
    if (n >= 50) this.lastSlotAt = t; // cap catch-up after a long stall
  }
}
