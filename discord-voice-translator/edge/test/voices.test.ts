import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/store/Store.js';
import { createLogger } from '../src/util/log.js';
import { VoiceBank, HOUSE_VOICES } from '../src/worker/VoiceBank.js';
import { CloudWorker } from '../src/worker/CloudWorker.js';

const loud = () => { const b = Buffer.alloc(640); for (let i = 0; i < 320; i++) b.writeInt16LE(Math.round(4000 * Math.sin(i / 4)), i * 2); return b; };
const flush = () => new Promise((r) => setTimeout(r, 20));

function withFetch(handler: (url: string, init: RequestInit) => Response): () => { calls: string[] } {
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: string, init: RequestInit) => { calls.push(`${init.method} ${u}`); return handler(u, init); }) as typeof fetch;
  return () => { globalThis.fetch = orig; return { calls }; };
}

test('own voice: nothing is learned without consent; with consent ~45 s of clear speech creates it once', async () => {
  const vb = new VoiceBank(new Store(':memory:'), { elevenKey: 'k', log: createLogger('t') });
  const restore = withFetch(() => new Response(JSON.stringify({ voice_id: 'v123' }), { status: 200 }));
  for (let i = 0; i < 3000; i++) vb.feed('u', loud());            // no consent: ignored
  assert.equal(vb.status('u').status, 'off');
  vb.setPref('u', 'clone');
  for (let i = 0; i < 1000; i++) vb.feed('u', Buffer.alloc(640));  // silence is never used
  assert.equal(vb.status('u').learnedPct, 0);
  for (let i = 0; i < 2300; i++) vb.feed('u', loud());              // 46 s of speech
  await flush();
  const { calls } = restore();
  assert.deepEqual(calls, ['POST https://api.elevenlabs.io/v1/voices/add']);
  assert.equal(vb.status('u').status, 'ready');
  assert.equal(vb.voiceFor('u'), 'v123');
});

test('free plan: cloning refused -> clear message, matched voice meanwhile, no retry loop', async () => {
  const vb = new VoiceBank(new Store(':memory:'), { elevenKey: 'k', log: createLogger('t') });
  const restore = withFetch(() => new Response(JSON.stringify({ detail: { message: 'Your subscription does not include instant voice cloning' } }), { status: 403 }));
  vb.setPref('u', 'clone');
  for (let i = 0; i < 2300; i++) vb.feed('u', loud());
  await flush();
  for (let i = 0; i < 2300; i++) vb.feed('u', loud());
  await flush();
  const { calls } = restore();
  assert.equal(calls.length, 1);
  assert.equal(vb.status('u').status, 'unavailable');
  assert.match(vb.status('u').detail!, /paid ElevenLabs plan/);
  assert.equal(vb.voiceFor('u'), null); // automatic voice meanwhile
});

test('delete my voice removes it at ElevenLabs and stops using it', async () => {
  const store = new Store(':memory:');
  const vb = new VoiceBank(store, { elevenKey: 'k', log: createLogger('t') });
  vb.setPref('u', 'clone');
  store.setKv('clone:u', 'v9');
  const restore = withFetch(() => new Response('{}', { status: 200 }));
  await vb.remove('u');
  const { calls } = restore();
  assert.deepEqual(calls, ['DELETE https://api.elevenlabs.io/v1/voices/v9']);
  assert.equal(vb.cloneId('u'), null);
  assert.equal(vb.pref('u'), null);
});

test('the dub voice follows the person: own voice > picked voice > automatic', () => {
  const store = new Store(':memory:');
  const vb = new VoiceBank(store, { elevenKey: 'k', log: createLogger('t') });
  const w = new CloudWorker({ sonioxKey: async () => 'x', elevenKey: 'x', voiceBank: vb });
  w.start();
  w.sendJson({ type: 'stream_open', sid: 1, guild_id: 'g', user_id: 'u', name: 'n', speak_lang: 'auto' });
  const s = (w as any).streams.get(1);
  const auto = w.voiceFor(s);
  assert.ok(auto);
  vb.setPref('u', HOUSE_VOICES[0]!.id);
  assert.equal(w.voiceFor(s), HOUSE_VOICES[0]!.id);
  vb.setPref('u', 'clone');
  store.setKv('clone:u', 'mine');
  assert.equal(w.voiceFor(s), 'mine');
  w.stop();
});
