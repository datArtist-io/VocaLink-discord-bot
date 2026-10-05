/** s16le PCM helpers. All functions are allocation-light and dependency-free. */

export const SAMPLES_20MS_16K = 320;
export const BYTES_20MS_16K_MONO = 640;
export const SAMPLES_20MS_48K = 960;
export const BYTES_20MS_48K_MONO = 1920;
export const BYTES_20MS_48K_STEREO = 3840;

export function silence(bytes: number): Buffer {
  return Buffer.alloc(bytes);
}

/** Mono -> interleaved stereo with a linear gain ramp from g0 to g1 across the buffer. */
export function monoToStereoGain(mono: Buffer, g0 = 1, g1 = g0): Buffer {
  const n = mono.length >> 1;
  const out = Buffer.allocUnsafe(n * 4);
  const step = n > 1 ? (g1 - g0) / (n - 1) : 0;
  for (let i = 0; i < n; i++) {
    const g = g0 + step * i;
    let v = Math.round(mono.readInt16LE(i * 2) * g);
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    out.writeInt16LE(v, i * 4);
    out.writeInt16LE(v, i * 4 + 2);
  }
  return out;
}

/** 48 kHz mono -> 24 kHz mono (pairwise average; adequate for speech to a browser). */
export function decimate2(mono48: Buffer): Buffer {
  const n = mono48.length >> 2;
  const out = Buffer.allocUnsafe(n * 2);
  for (let i = 0; i < n; i++) {
    out.writeInt16LE((mono48.readInt16LE(i * 4) + mono48.readInt16LE(i * 4 + 2)) >> 1, i * 2);
  }
  return out;
}

/**
 * 48 kHz interleaved stereo -> 16 kHz mono with a 3-tap box prefilter.
 * Only used when the Opus decoder could not be opened at 16 kHz mono.
 */
export function stereo48ToMono16(st: Buffer): Buffer {
  const frames = st.length >> 2;
  const n = Math.floor(frames / 3);
  const out = Buffer.allocUnsafe(n * 2);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < 3; k++) {
      const j = (i * 3 + k) * 4;
      acc += st.readInt16LE(j) + st.readInt16LE(j + 2);
    }
    out.writeInt16LE(Math.round(acc / 6), i * 2);
  }
  return out;
}

export function rmsDb(pcm: Buffer): number {
  const n = pcm.length >> 1;
  if (!n) return -120;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    acc += v * v;
  }
  return 10 * Math.log10(acc / n + 1e-12);
}
