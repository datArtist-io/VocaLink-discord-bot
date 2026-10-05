/** Web companion server: auth, CSP, WebSocket fan-out of captions and audio. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import WebSocket from 'ws';

import { Metrics } from '../src/metrics/Metrics.js';
import { Store } from '../src/store/Store.js';
import { createLogger } from '../src/util/log.js';
import { TokenSigner } from '../src/web/auth.js';
import { WebHub } from '../src/web/hub.js';
import { WebServer } from '../src/web/server.js';

test('web server: health, pages, dashboard auth, listener websocket', async () => {
  const hub = new WebHub();
  const signer = new TokenSigner('s'.repeat(32));
  const store = new Store(':memory:');
  const langsSet: string[][] = [];
  hub.registerSession('g1', { setWebLangs: (l) => langsSet.push(l), describe: () => ({ ok: 1 }) });
  const fakeClient = { name: 'w1', status: 'ready', ready: true, stats: { lastRttMs: 3, disconnects: 0 }, info: { hardware: { tier: 'gpu8' }, languages: { en: { tier: 2, name: 'English' } }, providers: [], registry_summary: { counts: {} }, plan: {} } };
  const web = new WebServer({
    hub, signer, store, metrics: new Metrics(), log: createLogger('t'),
    pool: { clients: [fakeClient] as never, info: () => fakeClient.info as never },
    sessions: () => new Map([['g1', { describe: () => ({ live: true }) }]]),
  });
  const port = await web.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const h = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean };
    assert.equal(h.ok, true);
    const page = await fetch(`${base}/listen?t=x`);
    assert.equal(page.status, 200);
    const csp = page.headers.get('content-security-policy')!;
    const nonce = /nonce-([^']+)'/.exec(csp)![1];
    assert.ok((await page.text()).includes(`<script nonce="${nonce}">`));
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');

    const listen = signer.sign({ g: 'g1', u: 'u1', s: 'listen', l: 'yo' }, 60_000);
    const admin = signer.sign({ g: 'g1', u: 'u1', s: 'admin' }, 60_000);
    assert.equal((await fetch(`${base}/api/dashboard?t=${listen}`)).status, 401); // listen token can't read analytics
    const dash = (await (await fetch(`${base}/api/dashboard?t=${admin}`)).json()) as { guild_id: string; live: unknown };
    assert.equal(dash.guild_id, 'g1');
    assert.deepEqual(dash.live, { live: true });
    assert.equal((await fetch(`${base}/api/languages?t=${listen}`)).status, 200);
    assert.match(await (await fetch(`${base}/metrics`)).text(), /dvt_edge_web_listeners/);

    // bad token: upgrade refused
    await assert.rejects(new Promise((res, rej) => {
      const bad = new WebSocket(`ws://127.0.0.1:${port}/ws/listen?t=nope`);
      bad.on('open', res);
      bad.on('error', rej);
    }));

    // good token: status, caption in listener language, binary audio, language switch
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/listen?t=${listen}`);
    const msgs: Record<string, unknown>[] = [];
    const bins: Buffer[] = [];
    ws.on('message', (d, isBin) => (isBin ? bins.push(d as Buffer) : msgs.push(JSON.parse(String(d)))));
    await new Promise((r) => ws.on('open', r));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(msgs[0]!.type, 'status');
    assert.equal(msgs[0]!.lang, 'yo');
    assert.deepEqual(langsSet.at(-1), ['yo']); // session told to produce Yoruba audio
    hub.caption('g1', { name: 'Ada', userId: 'u2', srcLang: 'en', original: 'hi', translations: { yo: 'ẹ n lẹ' }, final: true, uttKey: '1:1' });
    hub.dubStart('g1', 'yo', { dub_id: 7, user_id: 'u2' });
    const pcm48 = Buffer.alloc(1920);
    hub.dubAudio('g1', 'yo', 7, 0, pcm48);
    hub.dubAudio('g1', 'fr', 8, 0, pcm48); // other language: not delivered
    await new Promise((r) => setTimeout(r, 100));
    const cap = msgs.find((m) => m.type === 'caption')!;
    assert.equal(cap.text, 'ẹ n lẹ');
    assert.equal(bins.length, 1);
    assert.equal(bins[0]!.readUInt32BE(0), 7);
    assert.equal(bins[0]!.length, 8 + 960); // 48k -> 24k
    ws.send(JSON.stringify({ type: 'set_lang', lang: 'French' }));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(langsSet.at(-1), ['fr']);
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(langsSet.at(-1), []); // last listener left
  } finally {
    await web.close();
    store.close();
  }
});
