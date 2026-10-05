/** Test helpers: FSK "speech" (matches worker/providers/fake.py), fake voice link, worker process. */

import { EventEmitter } from 'node:events';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { PullSource, VoiceLinkLike } from '../src/voice/types.js';

export const WORKER_DIR = resolve(import.meta.dirname, '../../worker');

/** Encode "lang|text" exactly like translator_worker.providers.fake.modem_encode (16 kHz). */
export function modemPcm16(text: string, lang: string, leadMs = 200): Buffer {
  const sr = 16000;
  const data = Buffer.from(`${lang}|${text}`, 'utf8');
  const n = Math.round(sr * 0.04);
  const ramp = Math.max(1, Math.round(0.004 * sr));
  const lead = Math.round((leadMs / 1000) * sr);
  const total = lead + data.length * 2 * n;
  const out = Buffer.alloc(total * 2);
  let k = lead;
  for (const b of data) {
    for (const nib of [b >> 4, b & 0xf]) {
      const f = 500 + 100 * nib;
      for (let i = 0; i < n; i++) {
        let env = 1;
        if (i < ramp) env = i / (ramp - 1);
        else if (i >= n - ramp) env = (n - 1 - i) / (ramp - 1);
        const v = 0.3 * Math.sin((2 * Math.PI * f * i) / sr) * env;
        out.writeInt16LE(Math.round(v * 32767), (k + i) * 2);
      }
      k += n;
    }
  }
  return out;
}

/** Decode 48 kHz mono PCM with the worker's demodulator (via python). */
export function demod48(pcm: Buffer): [string, string][] {
  const dir = mkdtempSync(join(tmpdir(), 'dvt-'));
  const f = join(dir, 'a.pcm');
  writeFileSync(f, pcm);
  const out = execFileSync(
    'python3',
    ['-c', `import sys,json,numpy as np; sys.path.insert(0, ${JSON.stringify(WORKER_DIR)});
from translator_worker.providers.fake import modem_decode_runs
a=np.frombuffer(open(${JSON.stringify(f)},'rb').read(),dtype='<i2').astype(np.float32)/32768
print(json.dumps(modem_decode_runs(a,48000)))`],
    { encoding: 'utf8' },
  );
  return JSON.parse(out);
}

export function stereoToMono(st: Buffer): Buffer {
  const n = st.length >> 2;
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(st.readInt16LE(i * 4), i * 2);
  return out;
}

export class FakeVoiceLink extends EventEmitter implements VoiceLinkLike {
  channelId = 'vc-1';
  subscribed = new Set<string>();
  played: Buffer[] = [];
  playCount = 0;
  destroyed = false;
  private timer: NodeJS.Timeout | null = null;

  subscribe(u: string): void {
    this.subscribed.add(u);
  }
  unsubscribe(u: string): void {
    this.subscribed.delete(u);
  }
  isPlaying(): boolean {
    return this.timer !== null;
  }
  play(src: PullSource): void {
    this.playCount++;
    this.timer = setInterval(() => {
      for (let i = 0; i < 4; i++) {
        const r = src.pull();
        if ('frame' in r) this.played.push(r.frame);
        else if ('wait' in r) return;
        else {
          clearInterval(this.timer!);
          this.timer = null;
          this.emit('idle');
          return;
        }
      }
    }, 5);
  }
  stopPlayback(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  destroy(): void {
    this.stopPlayback();
    this.destroyed = true;
  }

  /** Simulate a user talking: speaking start, 20 ms "packets" (raw 16k PCM), speaking end. */
  async speak(userId: string, pcm: Buffer, msPerFrame = 5): Promise<void> {
    this.emit('speaking', userId, true);
    for (let off = 0; off < pcm.length; off += 640) {
      let f = pcm.subarray(off, off + 640);
      if (f.length < 640) f = Buffer.concat([f, Buffer.alloc(640 - f.length)]);
      this.emit('packet', userId, f);
      await new Promise((r) => setTimeout(r, msPerFrame));
    }
    this.emit('speaking', userId, false);
  }
}

export interface WorkerProc {
  port: number;
  proc: ChildProcess;
  stop(): Promise<void>;
}

export function startWorker(env: Record<string, string> = {}, port = 0): Promise<WorkerProc> {
  return new Promise((resolveP, reject) => {
    const proc = spawn('python3', ['-m', 'translator_worker'], {
      cwd: WORKER_DIR,
      env: { ...process.env, FAKE_MODELS: '1', WORKER_TOKEN: 'secret', HARDWARE_TIER: 'gpu8', WORKER_HEALTH_PORT: '0', WORKER_PORT: String(port), LOG_LEVEL: 'INFO', DATA_DIR: mkdtempSync(join(tmpdir(), 'dvtw-')), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/listening on [^\s]+:(\d+)/);
      if (m) {
        proc.stderr!.off('data', onData);
        proc.stderr!.on('data', () => {});
        resolveP({
          port: Number(m[1]),
          proc,
          stop: () =>
            new Promise((r) => {
              if (proc.exitCode !== null) return r();
              proc.once('exit', () => r());
              proc.kill('SIGKILL');
            }),
        });
      }
    };
    proc.stderr!.on('data', onData);
    proc.stdout!.on('data', () => {});
    proc.once('exit', (code) => reject(new Error(`worker exited early (${code}): ${buf.slice(-2000)}`)));
    setTimeout(() => reject(new Error(`worker did not start: ${buf.slice(-2000)}`)), 20_000);
  });
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 10_000, stepMs = 25): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
