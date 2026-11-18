/**
 * Automatic gain control for one speaker's 16 kHz s16 mono audio, so faint speech
 * reaches speech recognition at a healthy level.
 *
 * - Measures loudness per 20 ms frame (RMS) and moves the gain smoothly toward the gain
 *   that brings speech to `targetRms`.
 * - Only adapts on frames above `noiseFloorRms`, so silence and room hiss are not pumped
 *   up into fake speech; gain is capped at `maxGain`.
 * - A soft limiter keeps boosted peaks from clipping.
 * - Zero-latency: works frame by frame, no look-ahead buffer.
 */

export interface AgcOptions {
  targetRms?: number; // ~ -18 dBFS
  noiseFloorRms?: number; // ~ -60 dBFS
  maxGain?: number;
  minGain?: number;
  attack?: number; // smoothing when gain must go down (fast)
  release?: number; // smoothing when gain may go up (slow)
}

export class Agc {
  gain = 1;
  private readonly o: Required<AgcOptions>;

  constructor(opts: AgcOptions = {}) {
    this.o = {
      targetRms: opts.targetRms ?? 4100,
      noiseFloorRms: opts.noiseFloorRms ?? 33,
      maxGain: opts.maxGain ?? 6,
      minGain: opts.minGain ?? 0.5,
      attack: opts.attack ?? 0.5,
      release: opts.release ?? 0.08,
    };
  }

  /** Returns a new buffer with gain applied (input is not modified). */
  process(pcm: Buffer): Buffer {
    const n = pcm.length >> 1;
    if (!n) return pcm;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = pcm.readInt16LE(i * 2);
      sum += v * v;
    }
    const rms = Math.sqrt(sum / n);
    if (rms > this.o.noiseFloorRms) {
      const want = Math.min(this.o.maxGain, Math.max(this.o.minGain, this.o.targetRms / rms));
      const k = want < this.gain ? this.o.attack : this.o.release;
      this.gain += (want - this.gain) * k;
    }
    if (Math.abs(this.gain - 1) < 0.01) return pcm;
    const out = Buffer.alloc(pcm.length);
    for (let i = 0; i < n; i++) out.writeInt16LE(softClip(pcm.readInt16LE(i * 2) * this.gain), i * 2);
    return out;
  }
}

/** Linear below ~75 % of full scale, then a smooth knee up to the int16 limit. */
function softClip(x: number): number {
  const knee = 24576;
  const ax = Math.abs(x);
  if (ax <= knee) return Math.round(x);
  const room = 32767 - knee;
  const y = knee + room * Math.tanh((ax - knee) / room);
  return Math.round(Math.sign(x) * y);
}
