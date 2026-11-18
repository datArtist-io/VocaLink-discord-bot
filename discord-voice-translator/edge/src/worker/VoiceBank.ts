/**
 * How each person sounds to others: their own cloned voice, or a voice they picked.
 *
 * "My own voice" (one-tap consent in Discord): VocaLink keeps ~45 s of that person's clear
 * speech IN MEMORY ONLY, sends it once to ElevenLabs Instant Voice Cloning, then discards it.
 * From then on their translations are spoken in their own voice. "Delete my voice" (or
 * /optout) deletes the clone at ElevenLabs immediately.
 */

import type { Store } from '../store/Store.js';
import type { Logger } from '../util/log.js';

export interface HouseVoice {
  id: string;
  name: string;
  desc: string;
  low: boolean; // lower-pitched voice
}

/** ElevenLabs default-library voices offered in the picker. */
export const HOUSE_VOICES: HouseVoice[] = [
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', desc: 'Warm, clear', low: false },
  { id: 'FGY2WhTYpPnrIDTdsKH5', name: 'Laura', desc: 'Bright, upbeat', low: false },
  { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda', desc: 'Friendly, calm', low: false },
  { id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica', desc: 'Playful, young', low: false },
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', desc: 'Soft, gentle', low: false },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', desc: 'Deep, warm', low: true },
  { id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam', desc: 'Young, energetic', low: true },
  { id: 'cjVigY5qzO86Huf0OWal', name: 'Eric', desc: 'Smooth, relaxed', low: true },
];

export type CloneStatus = 'off' | 'learning' | 'creating' | 'ready' | 'unavailable';

const SR = 16000;
const NEED_S = 45; // seconds of clear speech used to learn a voice
const VOICED_RMS = 600; // frames quieter than this (after gain control) are not used

export class VoiceBank {
  private samples = new Map<string, { chunks: Buffer[]; bytes: number }>();
  private creating = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly o: { elevenKey: string; baseUrl?: string; log: Logger },
  ) {}

  private kv(k: string): string | null {
    const v = this.store.getKv(k);
    return v ? v : null;
  }

  /** 'clone' = their own voice; a voice id = a picked voice; null = automatic. */
  pref(userId: string): string | null {
    return this.kv(`voicepref:${userId}`);
  }

  setPref(userId: string, pref: string | null): void {
    this.store.setKv(`voicepref:${userId}`, pref ?? '');
    if (pref === 'clone') this.store.setKv(`voiceconsent:${userId}`, String(Date.now()));
  }

  cloneId(userId: string): string | null {
    return this.kv(`clone:${userId}`);
  }

  status(userId: string): { status: CloneStatus; detail?: string; learnedPct?: number } {
    if (this.pref(userId) !== 'clone') return { status: 'off' };
    if (this.cloneId(userId)) return { status: 'ready' };
    const why = this.kv(`cloneerr:${userId}`);
    if (why) return { status: 'unavailable', detail: why };
    if (this.creating.has(userId)) return { status: 'creating' };
    const s = this.samples.get(userId);
    return { status: 'learning', learnedPct: Math.min(99, Math.round(((s?.bytes ?? 0) / (SR * 2 * NEED_S)) * 100)) };
  }

  /** The voice to speak this person's translations in, or null for the automatic choice. */
  voiceFor(userId: string): string | null {
    const p = this.pref(userId);
    if (p === 'clone') return this.cloneId(userId); // null until learned -> automatic meanwhile
    return p;
  }

  /** Called with each 16 kHz frame of a speaker (after gain control). */
  feed(userId: string, pcm: Buffer): void {
    if (this.pref(userId) !== 'clone' || this.cloneId(userId) || this.creating.has(userId) || this.kv(`cloneerr:${userId}`)) return;
    let sum = 0;
    const n = pcm.length >> 1;
    for (let i = 0; i < n; i++) {
      const v = pcm.readInt16LE(i * 2);
      sum += v * v;
    }
    if (!n || Math.sqrt(sum / n) < VOICED_RMS) return; // keep only clear speech
    let s = this.samples.get(userId);
    if (!s) this.samples.set(userId, (s = { chunks: [], bytes: 0 }));
    s.chunks.push(Buffer.from(pcm));
    s.bytes += pcm.length;
    if (s.bytes >= SR * 2 * NEED_S) {
      const audio = Buffer.concat(s.chunks);
      this.samples.delete(userId);
      void this.create(userId, audio);
    }
  }

  private async create(userId: string, pcm: Buffer): Promise<void> {
    this.creating.add(userId);
    try {
      const form = new FormData();
      form.append('name', `VocaLink ${userId}`);
      form.append('description', 'Created with consent in VocaLink; deletable anytime.');
      form.append('remove_background_noise', 'true');
      form.append('files', new Blob([wav(pcm)], { type: 'audio/wav' }), 'speech.wav');
      const r = await fetch(`${this.base}/v1/voices/add`, { method: 'POST', headers: { 'xi-api-key': this.o.elevenKey }, body: form, signal: AbortSignal.timeout(60_000) });
      const body = (await r.json().catch(() => ({}))) as { voice_id?: string; detail?: { message?: string; status?: string } | string };
      if (!r.ok || !body.voice_id) {
        const msg = typeof body.detail === 'string' ? body.detail : body.detail?.message ?? `HTTP ${r.status}`;
        const planIssue = r.status === 401 || r.status === 403 || /subscription|plan|upgrade|permission|limit/i.test(msg);
        this.store.setKv(`cloneerr:${userId}`, planIssue ? 'Needs a paid ElevenLabs plan with voice cloning' : msg.slice(0, 120));
        this.o.log.warn('voice clone failed', { status: r.status, msg: msg.slice(0, 200) });
        return;
      }
      this.store.setKv(`clone:${userId}`, body.voice_id);
      this.o.log.info('voice clone ready');
    } catch (e) {
      this.o.log.warn('voice clone error', { err: e });
    } finally {
      this.creating.delete(userId); // the recorded speech is not kept anywhere
    }
  }

  /** Delete the person's cloned voice everywhere and stop learning. */
  async remove(userId: string): Promise<void> {
    this.samples.delete(userId);
    const id = this.cloneId(userId);
    this.store.setKv(`clone:${userId}`, '');
    this.store.setKv(`cloneerr:${userId}`, '');
    if (this.pref(userId) === 'clone') this.setPref(userId, null);
    if (id) {
      await fetch(`${this.base}/v1/voices/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'xi-api-key': this.o.elevenKey }, signal: AbortSignal.timeout(15_000) })
        .catch((e) => this.o.log.warn('voice delete failed', { err: e }));
    }
  }

  /** Try again after a plan upgrade. */
  retry(userId: string): void {
    this.store.setKv(`cloneerr:${userId}`, '');
  }

  private get base(): string {
    return (this.o.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/$/, '');
  }
}

function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
