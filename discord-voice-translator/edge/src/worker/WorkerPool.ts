/**
 * Several workers (e.g. one per GPU). Guilds are assigned with rendezvous
 * hashing and stay sticky; if a worker stays down longer than `failoverMs`
 * while another is healthy, its guilds are moved (GuildSession replays its
 * state onto the new worker).
 */

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

import { WorkerClient, type WorkerClientOptions } from './WorkerClient.js';
import type { HelloAck } from '../protocol/messages.js';

export function parseWorkerUrls(spec: string): { host: string; port: number }[] {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const u = s.replace(/^tcp:\/\//, '');
      const i = u.lastIndexOf(':');
      return i > 0 ? { host: u.slice(0, i), port: Number(u.slice(i + 1)) } : { host: u, port: 7700 };
    });
}

function score(guildId: string, name: string): number {
  return createHash('sha1').update(`${guildId}|${name}`).digest().readUInt32BE(0);
}

export class WorkerPool extends EventEmitter {
  readonly clients: WorkerClient[];
  private assignment = new Map<string, WorkerClient>();
  private downSince = new Map<WorkerClient, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    urls: { host: string; port: number }[],
    opts: Omit<WorkerClientOptions, 'host' | 'port'>,
    private readonly failoverMs = 5000,
  ) {
    super();
    if (!urls.length) throw new Error('at least one worker URL is required');
    this.clients = urls.map((u) => new WorkerClient({ ...opts, host: u.host, port: u.port }));
    for (const c of this.clients) {
      c.on('status', (s: string) => {
        if (s === 'down') this.downSince.set(c, Date.now());
        else this.downSince.delete(c);
        this.emit('status', c, s);
      });
    }
  }

  start(): void {
    for (const c of this.clients) c.start();
    this.timer = setInterval(() => this.checkFailover(), 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const c of this.clients) c.stop();
  }

  anyReady(): WorkerClient | null {
    return this.clients.find((c) => c.ready) ?? null;
  }

  info(): HelloAck | null {
    return this.anyReady()?.info ?? this.clients.find((c) => c.info)?.info ?? null;
  }

  clientFor(guildId: string): WorkerClient {
    const cur = this.assignment.get(guildId);
    if (cur) return cur;
    const ready = this.clients.filter((c) => c.ready);
    const pool = ready.length ? ready : this.clients;
    const best = pool.reduce((a, b) => (score(guildId, a.name) >= score(guildId, b.name) ? a : b));
    this.assignment.set(guildId, best);
    return best;
  }

  release(guildId: string): void {
    this.assignment.delete(guildId);
  }

  private checkFailover(): void {
    const now = Date.now();
    for (const [guildId, c] of this.assignment) {
      const since = this.downSince.get(c);
      if (since === undefined || now - since < this.failoverMs) continue;
      const alt = this.clients.filter((x) => x !== c && x.ready);
      if (!alt.length) continue;
      const next = alt.reduce((a, b) => (score(guildId, a.name) >= score(guildId, b.name) ? a : b));
      this.assignment.set(guildId, next);
      this.emit('reassign', guildId, next, c);
    }
  }
}
