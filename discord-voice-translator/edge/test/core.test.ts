/** Unit tests for the pure edge modules. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FrameDecoder, type Frame, encodeAudioIn, encodeBlob, encodeJson, FRAME_AUDIO_IN, FRAME_BLOB, FRAME_JSON } from '../src/protocol/frames.js';
import { PlayoutScheduler } from '../src/audio/PlayoutScheduler.js';
import { UserStream } from '../src/audio/UserStream.js';
import { RingBuffer } from '../src/audio/RingBuffer.js';
import { decimate2, monoToStereoGain } from '../src/audio/pcm.js';
import { CaptionSink, escapeMd, formatCaption, type CaptionMessage } from '../src/discord/captions.js';
import { Store } from '../src/store/Store.js';
import { TokenSigner } from '../src/web/auth.js';
import { normalizeLang, parseLangList, autocompleteLanguages } from '../src/languages.js';
import { Metrics } from '../src/metrics/Metrics.js';
import { parseWorkerUrls } from '../src/worker/WorkerPool.js';

test('frames: roundtrip with worst-case fragmentation', () => {
  const all = Buffer.concat([encodeJson({ type: 'x', s: 'ẹ́' }), encodeAudioIn(5, 9, Buffer.from([1, 2, 3, 4])), encodeBlob({ type: 'b' }, Buffer.from('zz'))]);
  const d = new FrameDecoder();
  const out: Frame[] = [];
  for (let i = 0; i < all.length; i++) out.push(...d.feed(all.subarray(i, i + 1)));
  assert.equal(out.length, 3);
  assert.equal(out[0]!.kind, FRAME_JSON);
  assert.deepEqual(out[0]!.kind === FRAME_JSON && out[0]!.json, { type: 'x', s: 'ẹ́' });
  assert.ok(out[1]!.kind === FRAME_AUDIO_IN && out[1]!.id === 5 && out[1]!.seq === 9 && out[1]!.pcm.length === 4);
  assert.ok(out[2]!.kind === FRAME_BLOB && out[2]!.data.toString() === 'zz');
});

const frame48 = (v = 1000, ms = 20) => {
  const b = Buffer.alloc(96 * ms);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(v, i);
  return b;
};

test('playout: FIFO, prebuffer, end', () => {
  let now = 0;
  const s = new PlayoutScheduler({ now: () => now, prebufferMs: 40 });
  s.enqueue({ dubId: 1, userId: 'a', lang: 'en' });
  s.enqueue({ dubId: 2, userId: 'b', lang: 'en' });
  assert.deepEqual(s.pull(), { wait: true });
  s.push(1, frame48(1000, 20));
  assert.equal(s.hasPlayable(), false); // below prebuffer
  s.push(1, frame48(1000, 20));
  const r = s.pull();
  assert.ok('frame' in r && r.frame.length === 3840);
  s.end(1);
  assert.ok('frame' in s.pull());
  assert.deepEqual(s.pull(), { end: 1 });
  assert.equal(s.current()?.dubId, 2);
});

test('playout: stale and queue-full drops emit reasons', () => {
  let now = 0;
  const s = new PlayoutScheduler({ now: () => now, staleMs: 1000, maxQueue: 2 });
  const drops: [number, string][] = [];
  s.on('drop', (it, why) => drops.push([it.dubId, why]));
  for (let i = 1; i <= 4; i++) s.enqueue({ dubId: i, userId: 'u', lang: 'en' });
  assert.deepEqual(drops, [[1, 'queue_full'], [2, 'queue_full']]);
  now = 1500;
  s.pull();
  assert.deepEqual(drops.slice(2), [[3, 'stale'], [4, 'stale']]);
});

test('playout: ducking ramps gain while others talk, barge-in cuts own speaker', () => {
  let now = 0;
  const s = new PlayoutScheduler({ now: () => now, duckGain: 0.25, rampMs: 20, prebufferMs: 0, cutRemainingMs: 100 });
  s.enqueue({ dubId: 1, userId: 'spk', lang: 'en' });
  for (let i = 0; i < 20; i++) s.push(1, frame48(10000));
  s.pull();
  s.humanSpeaking('other', true);
  const r = s.pull();
  assert.ok('frame' in r);
  const last = r.frame.readInt16LE(r.frame.length - 4);
  assert.ok(Math.abs(last - 2500) <= 2, `ducked sample ${last}`);
  s.humanSpeaking('other', false);
  const drops: string[] = [];
  s.on('drop', (_it, why) => drops.push(why));
  s.humanSpeaking('spk', true); // own speaker resumes; dub not ended -> remaining unknown -> cut
  for (let i = 0; i < 5; i++) s.pull();
  assert.deepEqual(drops, ['barge_in']);
  assert.equal(s.stats.bargeIns, 1);
});

test('userstream: fills real-time silence after packets stop, then idles', () => {
  let now = 0;
  const sent: { seq: number; len: number; silent: boolean }[] = [];
  const us = new UserStream(1, (_sid, seq, pcm) => sent.push({ seq, len: pcm.length, silent: pcm.every((b) => b === 0) }), {
    now: () => now, fillAfterMs: 100, idleSilenceMs: 400,
  });
  const voiced = Buffer.alloc(640, 7);
  for (let i = 0; i < 5; i++) {
    us.onFrame(voiced);
    now += 20;
  }
  for (let t = 0; t < 60; t++) {
    us.tick();
    now += 20;
  }
  const silent = sent.filter((x) => x.silent).length;
  assert.equal(silent, 20); // 400 ms of silence then idle
  assert.equal(us.active, false);
  assert.deepEqual(sent.map((x) => x.seq), sent.map((_, i) => i)); // contiguous sequence numbers
  // a 300 ms dropout mid-speech is filled when packets resume
  now += 1000;
  us.onFrame(voiced);
  now += 300;
  us.onFrame(voiced);
  const tail = sent.slice(-16);
  assert.equal(tail.filter((x) => x.silent).length, 14);
});

test('ringbuffer drops oldest', () => {
  const r = new RingBuffer<number>(3);
  [1, 2, 3, 4, 5].forEach((x) => r.push(x));
  assert.deepEqual(r.drain(), [3, 4, 5]);
  assert.equal(r.dropped, 2);
});

test('pcm helpers', () => {
  const m = Buffer.alloc(8);
  m.writeInt16LE(1000, 0);
  m.writeInt16LE(-1000, 2);
  const st = monoToStereoGain(m, 0.5, 0.5);
  assert.equal(st.readInt16LE(0), 500);
  assert.equal(st.readInt16LE(2), 500);
  assert.equal(decimate2(m).readInt16LE(0), 0);
});

test('captions: formatting escapes markdown and mentions', () => {
  assert.equal(escapeMd('*hi* @everyone'), '\\*hi\\* @​everyone');
  const s = formatCaption({ name: 'Ada', srcLang: 'yo', prob: 0.9, original: 'Ẹ kú àárọ̀', translations: { en: 'Good morning', fr: null }, flags: ['low_confidence'], voiceTier: { en: 2 } });
  assert.match(s, /\*\*Ada\*\* · YO 90%/);
  assert.match(s, /→ \*\*EN\*\* 🔊 Good morning/);
  assert.doesNotMatch(s, /FR/);
  assert.match(s, /say that again/);
});

class FakeTarget {
  sends: string[] = [];
  edits: string[] = [];
  async send(content: string): Promise<CaptionMessage> {
    this.sends.push(content);
    const id = String(this.sends.length);
    return { id, edit: async (c: string) => void this.edits.push(`${id}:${c}`) };
  }
}

test('captions: debounced edits, finals win, rate-limited digest', async () => {
  const t = new FakeTarget();
  const written: [string, string][] = [];
  const sink = new CaptionSink(t, { editIntervalMs: 100, burst: 2, refillMs: 200, digestThreshold: 2, onWritten: (k, id) => written.push([k, id]) });
  sink.upsert('u1', 'p1', false);
  await new Promise((r) => setTimeout(r, 20));
  sink.upsert('u1', 'p2', false);
  sink.upsert('u1', 'p3', false);
  sink.upsert('u1', 'FINAL', true);
  sink.upsert('u1', 'late partial', false); // ignored after final
  await sink.flush(2000);
  assert.deepEqual(t.sends, ['p1']);
  assert.deepEqual(t.edits, ['1:FINAL']);
  // burst of finals -> digest
  for (let i = 0; i < 5; i++) sink.upsert(`f${i}`, `final ${i}`, true);
  await sink.flush(3000);
  assert.ok(sink.stats.digests >= 1, 'expected a digest message');
  const all = t.sends.join('\n');
  for (let i = 0; i < 5; i++) assert.match(all, new RegExp(`final ${i}`));
  assert.ok(written.some(([k]) => k === 'f0'));
  sink.stop();
});

test('store: settings, prefs, glossary, captions index, analytics, consent', () => {
  const st = new Store(':memory:');
  assert.deepEqual(st.getSettings('g').textTargets, ['en']);
  st.updateSettings('g', { textTargets: ['en', 'yo'], dubLang: 'en' });
  assert.equal(st.getSettings('g').dubLang, 'en');
  st.updateUser('u', { speakLang: 'yo', optout: true });
  assert.equal(st.optedOut('u'), true);
  const id = st.addTerm({ guildId: 'g', srcLang: 'en', tgtLang: '*', source: 'Ade', target: 'Adé', kind: 'term', createdBy: 'u' });
  st.addTerm({ guildId: 'g', srcLang: 'en', tgtLang: '*', source: 'Ade', target: 'Adéọlá', kind: 'term', createdBy: 'u' }); // upsert
  assert.equal(st.glossary('g').length, 1);
  assert.equal(st.glossary('g')[0]!.target, 'Adéọlá');
  assert.ok(st.removeTerm('g', id) || st.glossary('g').length === 0);
  st.indexCaption('m1', 'g', 'u', 'yo', 'orig', { en: 'tr' });
  assert.equal(st.caption('m1')?.translations.en, 'tr');
  st.recordUtterance({ guildId: 'g', ts: Date.now(), srcLang: 'yo', targets: ['en'], tierMin: 2, sttMs: 300, mtMs: 80, endpointMs: 500, captionMs: 880, firstAudioMs: null, flags: ['weak_language'], sttProvider: 'fw' });
  const a = st.analytics('g', 0) as { utterances: number; byLang: Record<string, number>; latency: Record<string, { p50: number }> };
  assert.equal(a.utterances, 1);
  assert.equal(a.byLang.yo, 1);
  assert.equal(a.latency.stt!.p50, 300);
  st.recordConsent('u', 'v1', 'phrase', 'enrolled');
  assert.deepEqual(st.enrolledUsers(['u', 'x']), ['u']);
  st.prune(Date.now() + 25 * 3600_000);
  assert.equal(st.caption('m1'), null);
  st.close();
});

test('auth tokens: sign/verify/expire/tamper/scope', () => {
  const s = new TokenSigner('x'.repeat(32));
  const t = s.sign({ g: 'g', u: 'u', s: 'listen' }, 1000, 0);
  assert.equal(s.verify(t, 'listen', 500)?.u, 'u');
  assert.equal(s.verify(t, 'listen', 2000), null);
  assert.equal(s.verify(t, 'admin', 500), null);
  assert.equal(s.verify(t.slice(0, -2) + 'AA', 'listen', 500), null);
  const admin = s.sign({ g: 'g', u: 'u', s: 'admin' }, 1000, 0);
  assert.ok(s.verify(admin, 'listen', 1)); // admin can listen
  assert.throws(() => new TokenSigner('short'));
});

test('languages and misc', () => {
  assert.equal(normalizeLang('Yoruba'), 'yo');
  assert.equal(normalizeLang('pidgin'), 'pcm');
  assert.equal(normalizeLang('en-GB'), 'en');
  assert.deepEqual(parseLangList('en, yo ha,xx,igbo'), ['en', 'yo', 'ha', 'ig']);
  assert.ok(autocompleteLanguages('yor').some((c) => c.value === 'yo'));
  assert.deepEqual(parseWorkerUrls('a:1, tcp://b:2,c'), [{ host: 'a', port: 1 }, { host: 'b', port: 2 }, { host: 'c', port: 7700 }]);
  const m = new Metrics();
  [10, 20, 30].forEach((x) => m.observe('stt', x));
  assert.equal(m.pct('stt', 0.5), 20);
  assert.match(m.prometheus(), /dvt_edge_latency_ms\{stage="stt",quantile="0.5"\} 20/);
});
