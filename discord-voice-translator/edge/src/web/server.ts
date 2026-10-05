/**
 * Web companion + analytics dashboard + health/metrics endpoints.
 *
 *   GET  /healthz             liveness + worker status (no auth)
 *   GET  /metrics             Prometheus text (bind to a private network!)
 *   GET  /listen?t=...        companion page (per-listener translated audio + captions)
 *   GET  /dashboard?t=...     analytics page (admin token)
 *   GET  /api/dashboard?t=    JSON for the dashboard (admin token)
 *   GET  /api/languages?t=    language tiers (listen token)
 *   WS   /ws/listen?t=&lang=  listener stream: JSON events + binary audio
 *        binary frame = u32 dubId | u32 seq | PCM s16le 24 kHz mono
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { WebSocketServer, type WebSocket } from 'ws';

import { normalizeLang } from '../languages.js';
import type { Metrics } from '../metrics/Metrics.js';
import type { Store } from '../store/Store.js';
import type { Logger } from '../util/log.js';
import type { WorkerPool } from '../worker/WorkerPool.js';
import type { TokenSigner } from './auth.js';
import type { WebHub } from './hub.js';

export interface WebDeps {
  hub: WebHub;
  signer: TokenSigner;
  store: Store;
  metrics: Metrics;
  pool: Pick<WorkerPool, 'clients' | 'info'>;
  sessions: () => Map<string, { describe(): Record<string, unknown> }>;
  log: Logger;
  staticDir?: string;
}

const here = dirname(fileURLToPath(import.meta.url));

function page(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...extra,
  });
  res.end(body);
}

const json = (res: ServerResponse, status: number, obj: unknown) => send(res, status, JSON.stringify(obj), 'application/json');

export class WebServer {
  readonly http: Server;
  private wss: WebSocketServer;
  private pingTimer: NodeJS.Timeout;
  private readonly dir: string;
  private pages = new Map<string, string>();

  constructor(private readonly d: WebDeps) {
    this.dir = d.staticDir ?? join(here, 'static');
    this.http = createServer((req, res) => this.route(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    this.http.on('upgrade', (req, sock, head) => this.upgrade(req, sock, head));
    this.pingTimer = setInterval(() => {
      for (const ws of this.wss.clients) {
        const w = ws as WebSocket & { alive?: boolean };
        if (w.alive === false) {
          w.terminate();
          continue;
        }
        w.alive = false;
        w.ping();
      }
    }, 30_000);
    this.pingTimer.unref();
  }

  listen(port: number, host = '0.0.0.0'): Promise<number> {
    return new Promise((resolve) => {
      this.http.listen(port, host, () => {
        const addr = this.http.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });
  }

  close(): Promise<void> {
    clearInterval(this.pingTimer);
    for (const ws of this.wss.clients) ws.terminate();
    return new Promise((r) => this.http.close(() => r()));
  }

  private html(res: ServerResponse, name: string): void {
    let tpl = this.pages.get(name);
    if (!tpl) {
      tpl = page(this.dir, name);
      this.pages.set(name, tpl);
    }
    const nonce = randomBytes(16).toString('base64');
    const body = tpl.replace(/<script>/g, `<script nonce="${nonce}">`).replace(/<style>/g, `<style nonce="${nonce}">`);
    send(res, 200, body, 'text/html; charset=utf-8', {
      'Content-Security-Policy': `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'`,
    });
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const t = url.searchParams.get('t');
    try {
      switch (url.pathname) {
        case '/healthz': {
          const workers = this.d.pool.clients.map((c) => ({ name: c.name, status: c.status, tier: c.info?.hardware?.tier ?? null }));
          const ok = workers.some((w) => w.status === 'ready');
          // ?live=1 is a liveness probe: the edge process is fine even while workers reconnect
          const live = url.searchParams.get('live') === '1';
          return json(res, ok || live ? 200 : 503, { ok, workers, sessions: this.d.sessions().size, listeners: this.d.hub.count() });
        }
        case '/metrics': {
          this.d.metrics.gauge('sessions', this.d.sessions().size);
          this.d.metrics.gauge('web_listeners', this.d.hub.count());
          this.d.metrics.gauge('workers_ready', this.d.pool.clients.filter((c) => c.ready).length);
          return send(res, 200, this.d.metrics.prometheus(), 'text/plain; version=0.0.4');
        }
        case '/listen':
          return this.html(res, 'listen.html');
        case '/dashboard':
          return this.html(res, 'dashboard.html');
        case '/api/languages': {
          if (!this.d.signer.verify(t, 'listen')) return json(res, 401, { error: 'invalid or expired link' });
          return json(res, 200, { languages: this.d.pool.info()?.languages ?? {} });
        }
        case '/api/dashboard': {
          const p = this.d.signer.verify(t, 'admin');
          if (!p) return json(res, 401, { error: 'invalid or expired link' });
          const now = Date.now();
          const info = this.d.pool.info();
          return json(res, 200, {
            guild_id: p.g,
            day: this.d.store.analytics(p.g, now - 24 * 3600_000),
            week: this.d.store.analytics(p.g, now - 7 * 24 * 3600_000),
            live: this.d.sessions().get(p.g)?.describe() ?? null,
            listeners: this.d.hub.count(p.g),
            edge: this.d.metrics.snapshot(),
            workers: this.d.pool.clients.map((c) => ({
              name: c.name, status: c.status, rtt_ms: c.stats.lastRttMs, reconnects: c.stats.disconnects,
              hardware: c.info?.hardware ?? null, policy: c.info?.policy ?? null,
            })),
            providers: info?.providers ?? [],
            registry: info?.registry_summary ?? null,
            expected_latency: (info?.plan as { expected_latency?: unknown } | undefined)?.expected_latency ?? null,
          });
        }
        case '/':
          return send(res, 200, 'Discord voice translator edge. Use /listen or /dashboard links from the bot.', 'text/plain');
        default:
          return send(res, 404, 'not found', 'text/plain');
      }
    } catch (e) {
      this.d.log.error('web route failed', { err: e });
      return json(res, 500, { error: 'internal error' });
    }
  }

  private upgrade(req: IncomingMessage, sock: import('node:stream').Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws/listen') {
      sock.destroy();
      return;
    }
    const p = this.d.signer.verify(url.searchParams.get('t'), 'listen');
    if (!p) {
      sock.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      sock.destroy();
      return;
    }
    this.wss.handleUpgrade(req, sock, head, (ws) => {
      const w = ws as WebSocket & { alive?: boolean };
      w.alive = true;
      ws.on('pong', () => (w.alive = true));
      const lang = normalizeLang(url.searchParams.get('lang')) ?? p.l ?? 'en';
      const listener = this.d.hub.attach(p.g, p.u, lang === 'auto' ? 'en' : lang, ws);
      this.d.metrics.inc('web_listener_connects');
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        try {
          const m = JSON.parse(String(data)) as { type?: string; lang?: string };
          if (m.type === 'set_lang') {
            const l = normalizeLang(m.lang);
            if (l && l !== 'auto') this.d.hub.setLang(listener, l);
          }
        } catch {
          /* ignore malformed */
        }
      });
      ws.on('close', () => this.d.hub.detach(listener));
      ws.on('error', () => this.d.hub.detach(listener));
    });
  }
}
