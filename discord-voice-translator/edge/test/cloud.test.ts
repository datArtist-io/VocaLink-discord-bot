import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Agc } from '../src/audio/Agc.js';
import { CloudWorker } from '../src/worker/CloudWorker.js';

// Token sequence recorded from Soniox stt-rt-v6, two-way tl<->en, on a Taglish sentence.
const tok = (text: string, language: string, translation_status: string) => ({ text, language, translation_status, is_final: true });
const BATCHES = [
  [tok('Pare, sandali lang ha,', 'tl', 'original')],
  [tok('Dude, just a moment,', 'en', 'translation')],
  [tok(' kasi yung internet ko', 'tl', 'original')],
  [tok(' because my internet', 'en', 'translation')],
  [tok(' is so slow today,', 'en', 'original')],
  [tok(' ay sobrang bagal ngayon,', 'tl', 'translation')],
  [{ text: '<end>', is_final: true, translation_status: 'none' }],
];

function setup(audioTargets: string[]) {
  const w = new CloudWorker({ sonioxKey: async () => 'x', elevenKey: 'x' });
  const events: any[] = [];
  const spoken: { lang: string; text: string }[] = [];
  w.on('event', (e) => events.push(e));
  (w as any).speak = (_s: unknown, lang: string, text: string) => spoken.push({ lang, text });
  w.start();
  w.sendJson({ type: 'guild_config', guild_id: 'g', text_targets: ['en', 'tl'], audio_targets: audioTargets, expected_langs: null });
  w.sendJson({ type: 'stream_open', sid: 7, guild_id: 'g', user_id: 'u', name: 'n', speak_lang: 'auto' });
  const s = (w as any).streams.get(7);
  for (const b of BATCHES) (w as any).onSoniox(s, { tokens: b });
  w.stop();
  return { events, spoken };
}

test('Taglish: English target keeps original English words in order', () => {
  const { events } = setup(['en']);
  const fin = events.find((e) => e.type === 'final');
  assert.equal(fin.text, 'Pare, sandali lang ha, kasi yung internet ko is so slow today,');
  assert.equal(fin.lang, 'tl');
  assert.equal(fin.translations.en.text, 'Dude, just a moment, because my internet is so slow today,');
  assert.equal(fin.translations.tl.text, 'Pare, sandali lang ha, kasi yung internet ko ay sobrang bagal ngayon,');
});

test('English dub speaks every phrase of a mixed sentence, nothing is dropped', () => {
  const { spoken } = setup(['en']);
  assert.equal(spoken.map((x) => x.text).join(' '), 'Dude, just a moment, because my internet is so slow today,');
  assert.ok(spoken.every((x) => x.lang === 'en'));
});

test('a listener is never dubbed their own language when nothing needed translating', () => {
  const w = new CloudWorker({ sonioxKey: async () => 'x', elevenKey: 'x' });
  const spoken: string[] = [];
  (w as any).speak = (_s: unknown, _l: string, text: string) => spoken.push(text);
  w.start();
  w.sendJson({ type: 'guild_config', guild_id: 'g', text_targets: ['en', 'tl'], audio_targets: ['en'], expected_langs: null });
  w.sendJson({ type: 'stream_open', sid: 1, guild_id: 'g', user_id: 'u', name: 'n', speak_lang: 'auto' });
  const s = (w as any).streams.get(1);
  (w as any).onSoniox(s, { tokens: [tok('Hello everyone, ready to play?', 'en', 'original')] });
  (w as any).onSoniox(s, { tokens: [{ text: '<end>', is_final: true }] });
  w.stop();
  assert.deepEqual(spoken, []);
});

test('AGC lifts faint speech, caps gain and leaves silence silent', () => {
  const agc = new Agc();
  const faint = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) faint.writeInt16LE(Math.round(300 * Math.sin(i / 3)), i * 2);
  let out = faint;
  for (let k = 0; k < 100; k++) out = agc.process(faint);
  const peak = (b: Buffer) => Math.max(...Array.from({ length: b.length / 2 }, (_, i) => Math.abs(b.readInt16LE(i * 2))));
  assert.ok(peak(out) > peak(faint) * 4, 'faint speech is boosted');
  assert.ok(agc.gain <= 6);
  const silent = agc.process(Buffer.alloc(640));
  assert.equal(peak(silent), 0);
});
