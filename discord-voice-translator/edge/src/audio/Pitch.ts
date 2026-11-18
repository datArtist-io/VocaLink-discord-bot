/**
 * Running estimate of a speaker's typical voice pitch (fundamental frequency), used to pick
 * a dub voice that matches them (lower voices -> lower dub voices).
 *
 * Autocorrelation on 16 kHz mono frames, searching 70-350 Hz, only on frames that are clearly
 * voiced. Cheap: it analyses at most `maxFrames` frames per speaker, then stops.
 */

const SR = 16000;
const MIN_LAG = Math.floor(SR / 350);
const MAX_LAG = Math.ceil(SR / 70);

export class PitchTracker {
  private samples: number[] = [];
  private frames = 0;

  constructor(private readonly maxFrames = 150) {}

  private prev: Buffer | null = null;

  /** Feed one PCM16 frame (after gain control). Frames are 20 ms; analysis uses 40 ms windows. */
  push(frame: Buffer): void {
    if (this.frames >= this.maxFrames) return;
    // a 20 ms frame (320 samples) is too short to measure a deep voice (period up to 229
    // samples needs ~2 periods), so analyse the previous + current frame together
    const pcm = this.prev ? Buffer.concat([this.prev, frame]) : null;
    this.prev = Buffer.from(frame);
    if (!pcm) return;
    const n = pcm.length >> 1;
    if (n < MAX_LAG * 2) return;
    const x = new Float32Array(n);
    let energy = 0;
    for (let i = 0; i < n; i++) {
      x[i] = pcm.readInt16LE(i * 2);
      energy += x[i]! * x[i]!;
    }
    if (energy / n < 400 * 400) return; // too quiet to be voiced speech
    let best = 0;
    let bestLag = 0;
    for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
      let c = 0;
      for (let i = 0; i + lag < n; i++) c += x[i]! * x[i + lag]!;
      if (c > best) {
        best = c;
        bestLag = lag;
      }
    }
    if (!bestLag || best / energy < 0.45) return; // not periodic enough (unvoiced / noise)
    this.frames++;
    this.samples.push(SR / bestLag);
  }

  /** Median pitch in Hz, or null until enough voiced frames were seen. */
  get hz(): number | null {
    if (this.samples.length < 8) return null;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[s.length >> 1]!;
  }
}
