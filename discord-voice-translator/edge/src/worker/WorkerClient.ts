/**
 * Connection to one translation worker.
 *
 * Resilience contract (a worker crash must never drop the Discord voice
 * connection):
 *  - reconnects forever with jittered exponential backoff;
 *  - while the worker is down, the last `bufferMs` of audio per speaker is
 *    kept in a ring buffer and replayed after reconnect;
 *  - after every (re)connect, registered "replayers" re-send the state the
 *    worker needs (guild configs, open streams) before buffered audio.
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

import { RingBuffer } from '../audio/RingBuffer.js';
import {
  FRAME_AUDIO_OUT,
  FRAME_JSON,
  FrameDecoder,
  PROTOCOL_VERSION,
  encodeAudioIn,
  encodeBlob,
  encodeJson,
  type Json,
} from '../protocol/frames.js';
import type { HelloAck } from '../protocol/messages.js';
import { createLogger, type Logger } from '../util/log.js';

export type WorkerStatus = 'connecting' | 'ready' | 'down' | 'stopped';

export interface WorkerClientOptions {
  host: string;
  port: number;
  token?: string;
  edgeId?: string;
  heartbeatMs?: number;
  deadMs?: number;
  bufferMs?: number;
  maxBackoffMs?: number;
  log?: Logger;
}

interface Pending {
  resolve: (v: Json) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  type: string;
}

export class WorkerClient extends EventEmitter {
  readonly name: string;
  status: WorkerStatus = 'down';
  info: HelloAck | null = null;
  stats = { connects: 0, disconnects: 0, audioBuffered: 0, audioDroppedCongested: 0, lastRttMs: 0 };

  private sock: net.Socket | null = null;
  private decoder = new FrameDecoder();
  private backoff = 500;
  private hbTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastRx = 0;
  private rings = new Map<number, RingBuffer<{ seq: number; pcm: Buffer }>>();
  private replayers = new Set<() => Json[]>();
  private pending = new Map<string, Pending>();
  private readonly o: Required<Omit<WorkerClientOptions, 'log' | 'token' | 'edgeId'>> & { token: string; edgeId: string };
  private readonly log: Logger;

  constructor(opts: WorkerClientOptions) {
    super();
    this.o = {
      host: opts.host,
      port: opts.port,
      token: opts.token ?? '',
      edgeId: opts.edgeId ?? `edge-${process.pid}`,
      heartbeatMs: opts.heartbeatMs ?? 5000,
      deadMs: opts.deadMs ?? 15000,
      bufferMs: opts.bufferMs ?? 5000,
      maxBackoffMs: opts.maxBackoffMs ?? 10_000,
    };
    this.name = `${opts.host}:${opts.port}`;
    this.log = (opts.log ?? createLogger('worker')).child(this.name);
  }

  get ready(): boolean {
    return this.status === 'ready';
  }

  start(): void {
    if (this.status === 'stopped') this.status = 'down';
    this.connect();
  }

  stop(): void {
    this.status = 'stopped';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.sock?.destroy();
    this.sock = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('worker client stopped'));
    }
    this.pending.clear();
  }

  /** Register a function returning state messages to re-send after each (re)connect. */
  addReplayer(fn: () => Json[]): () => void {
    this.replayers.add(fn);
    return () => this.replayers.delete(fn);
  }

  // ------------------------------------------------------------------ sending
  sendJson(obj: Json): boolean {
    if (!this.ready || !this.sock) return false;
    this.sock.write(encodeJson(obj));
    return true;
  }

  sendAudio(sid: number, seq: number, pcm: Buffer): void {
    if (this.ready && this.sock) {
      if (this.sock.writableLength > 4 * 1024 * 1024) {
        this.stats.audioDroppedCongested++;
        return;
      }
      this.sock.write(encodeAudioIn(sid, seq, pcm));
      return;
    }
    let ring = this.rings.get(sid);
    if (!ring) {
      ring = new RingBuffer(Math.max(1, Math.round(this.o.bufferMs / 20)));
      this.rings.set(sid, ring);
    }
    ring.push({ seq, pcm });
    this.stats.audioBuffered++;
  }

  sendBlob(header: Record<string, unknown>, data: Buffer): boolean {
    if (!this.ready || !this.sock) return false;
    this.sock.write(encodeBlob(header, data));
    return true;
  }

  dropStream(sid: number): void {
    this.rings.delete(sid);
  }

  /** Send a request and wait for the matching `<resultType>` with the same req_id. */
  request<T extends Json = Json>(msg: Json, resultType: string, timeoutMs = 15_000): Promise<T> {
    const reqId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      if (!this.sendJson({ ...msg, req_id: reqId })) {
        reject(new Error('translation worker is not connected'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`worker request ${msg.type} timed out`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve: resolve as (v: Json) => void, reject, timer, type: resultType });
    });
  }

  // ------------------------------------------------------------------ connection
  private connect(): void {
    if (this.status === 'stopped') return;
    this.status = 'connecting';
    this.decoder = new FrameDecoder();
    const sock = net.createConnection({ host: this.o.host, port: this.o.port });
    this.sock = sock;
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 10_000);
    sock.on('connect', () => {
      this.lastRx = Date.now();
      sock.write(encodeJson({ type: 'hello', protocol: PROTOCOL_VERSION, token: this.o.token, edge_id: this.o.edgeId }));
    });
    sock.on('data', (chunk: Buffer) => this.onData(chunk));
    sock.on('error', (err) => this.log.debug('socket error', { err: err.message }));
    sock.on('close', () => this.onClose(sock));
  }

  private onClose(sock: net.Socket): void {
    if (this.sock !== sock) return;
    const wasReady = this.status === 'ready';
    this.sock = null;
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('translation worker disconnected'));
    }
    this.pending.clear();
    if (this.status === 'stopped') return;
    this.status = 'down';
    if (wasReady) {
      this.stats.disconnects++;
      this.log.warn('worker disconnected; buffering audio and reconnecting');
      this.emit('status', 'down');
    }
    const delay = Math.min(this.o.maxBackoffMs, this.backoff) * (0.75 + Math.random() * 0.5);
    this.backoff = Math.min(this.o.maxBackoffMs, this.backoff * 2);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private onData(chunk: Buffer): void {
    this.lastRx = Date.now();
    let frames;
    try {
      frames = this.decoder.feed(chunk);
    } catch (e) {
      this.log.error('protocol error from worker', { err: e });
      this.sock?.destroy();
      return;
    }
    for (const f of frames) {
      if (f.kind === FRAME_AUDIO_OUT) {
        this.emit('audio', f.id, f.seq, f.pcm);
      } else if (f.kind === FRAME_JSON) {
        this.onJson(f.json);
      }
    }
  }

  private onJson(m: Json): void {
    if (m.type === 'hello_ack') {
      this.info = m as unknown as HelloAck;
      this.status = 'ready';
      this.backoff = 500;
      this.stats.connects++;
      this.startHeartbeat();
      // 1) state replay, 2) buffered audio, in that order
      for (const fn of this.replayers) {
        for (const msg of fn()) this.sock?.write(encodeJson(msg));
      }
      for (const [sid, ring] of this.rings) {
        for (const { seq, pcm } of ring.drain()) this.sock?.write(encodeAudioIn(sid, seq, pcm));
      }
      this.log.info('worker ready', { tier: this.info.hardware?.tier, mode: this.info.policy?.mode });
      this.emit('status', 'ready');
      this.emit('ready', this.info);
      return;
    }
    if (m.type === 'hello_error') {
      this.log.error('worker rejected hello', { message: m.message });
      this.emit('fatal', String(m.message));
      return;
    }
    if (m.type === 'pong') {
      const t = Number(m.t);
      if (t) this.stats.lastRttMs = Date.now() - t;
      return;
    }
    const reqId = typeof m.req_id === 'string' ? m.req_id : undefined;
    if (reqId && this.pending.has(reqId)) {
      const p = this.pending.get(reqId)!;
      if (p.type === m.type) {
        clearTimeout(p.timer);
        this.pending.delete(reqId);
        p.resolve(m);
        return;
      }
    }
    this.emit('event', m);
  }

  private startHeartbeat(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => {
      if (Date.now() - this.lastRx > this.o.deadMs) {
        this.log.warn('worker heartbeat lost');
        this.sock?.destroy();
        return;
      }
      this.sendJson({ type: 'ping', t: Date.now() });
    }, this.o.heartbeatMs);
    this.hbTimer.unref();
  }
}
