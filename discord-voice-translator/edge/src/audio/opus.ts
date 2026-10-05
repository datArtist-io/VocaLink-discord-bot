/**
 * Opus decoding for received Discord audio.
 *
 * libopus can decode any Opus stream directly at 16 kHz mono, so the edge
 * never resamples: Discord's 48 kHz stereo packets come out as exactly the
 * 320-sample frames the worker wants. Prefers native @discordjs/opus, falls
 * back to the pure-JS/WASM opusscript.
 */

import { createRequire } from 'node:module';

import { stereo48ToMono16 } from './pcm.js';

export interface PcmDecoder {
  /** Decode one Opus packet to s16le 16 kHz mono PCM. */
  decode(packet: Buffer): Buffer;
  destroy(): void;
  readonly backend: string;
}

const require = createRequire(import.meta.url);

type Factory = () => PcmDecoder;
let cached: Factory | null = null;

export function opusBackend(): string {
  try {
    return getFactory()().backend;
  } catch (e) {
    return `unavailable: ${(e as Error).message}`;
  }
}

function getFactory(): Factory {
  if (cached) return cached;
  try {
    const mod = require('@discordjs/opus') as { OpusEncoder: new (rate: number, ch: number) => { decode(b: Buffer): Buffer } };
    cached = () => {
      const enc = new mod.OpusEncoder(16000, 1);
      return { backend: '@discordjs/opus', decode: (p) => enc.decode(p), destroy: () => {} };
    };
    return cached;
  } catch {
    /* fall through */
  }
  try {
    const OpusScript = require('opusscript') as {
      new (rate: number, ch: number, app?: number): { decode(b: Buffer): Buffer; delete(): void };
      Application: { VOIP: number };
    };
    cached = () => {
      // opusscript supports 16 kHz decoding as well
      const d = new OpusScript(16000, 1, OpusScript.Application.VOIP);
      return { backend: 'opusscript', decode: (p) => Buffer.from(d.decode(p)), destroy: () => d.delete() };
    };
    return cached;
  } catch {
    /* fall through */
  }
  throw new Error('no Opus decoder available: install @discordjs/opus or opusscript');
}

export function createDecoder(): PcmDecoder {
  return getFactory()();
}

/** Wrap a 48 kHz stereo decoder (if a backend only supports 48k) into a 16k mono one. */
export function wrap48kStereo(dec: { decode(b: Buffer): Buffer; destroy(): void }, backend: string): PcmDecoder {
  return { backend, decode: (p) => stereo48ToMono16(dec.decode(p)), destroy: () => dec.destroy() };
}

/** For tests and the dry-run voice link: "packets" are already 16 kHz mono PCM. */
export const passthroughDecoder = (): PcmDecoder => ({ backend: 'passthrough', decode: (p) => p, destroy: () => {} });
