import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Agc } from '../src/audio/Agc.js';
import { CloudWorker } from '../src/worker/CloudWorker.js';

// Tokens as Soniox stt-rt-v6 sends them (one-way translation lanes), for a Taglish sentence:
// "Pare, sandali lang ha, kasi yung internet ko is so slow today,"
const tok = (text: string, language: string, translation_status: string) => ({ text, language, translation_status, is_final: true });
const END = { text: '<end>', is_final: true, translation_status: 'none' };
const LANE_TOKENS: Record<string, object[][]> = {
  en: [
    [tok('Pare, sandali lang ha,', 'tl', 'original')],
    [tok('Dude, just a moment,', 'en', 'translation')],
    [tok(' kasi yung internet ko', 'tl', 'original')],
    [tok(' because my internet', 'en', 'translation')],
    [tok(' is so slow today,', 'en', 'none')],
    [END],
  ],
  tl: [
    [tok('Pare, sandali lang ha,', 'tl', 'none')],
    [tok(' kasi yung internet ko', 'tl', 'none')],
    [tok(' is so slow today,', 'en', 'original')],
    [tok(' ay sobrang bagal ngayon,', 'tl', 'translation')],
    [END],
  ],
  fr: [
    [tok('Pare, sandali lang ha,', 'tl', 'original')],
    [tok('Mec, une seconde,', 'fr', 'translation')],
    [tok(' kasi yung internet ko is so slow today,', 'tl', 'original')],
    [tok(' parce que mon internet est très lent,', 'fr', 'translation')],
    [END],
  ],
};

function run(langs: string[], channelDub: string[], audio = channelDub) {
  const w = new CloudWorker({ sonioxKey: async () => 'x', elevenKey: 'x' });
  const events: any[] = [];
  const spoken: { lang: string; text: string }[] = [];
  w.on('event', (e) => events.push(e));
  (w as any).speak = (_s: unknown, lang: string, text: string) => spoken.push({ lang, text });
  w.start();
  w.sendJson({ type: 'guild_config', guild_id: 'g', text_targets: langs, audio_targets: audio, channel_dub_langs: channelDub, expected_langs: null });
  w.sendJson({ type: 'stream_open', sid: 7, guild_id: 'g', user_id: 'u', name: 'n', speak_lang: 'auto' });
  const s = (w as any).streams.get(7);
  (w as any).syncLanes(s);
  // feed every lane; secondary lanes first so the primary's final sees their text
  const order = [...s.lanes.keys()].reverse();
  for (const k of order) for (const b of LANE_TOKENS[k] ?? []) (w as any).onSoniox(s, s.lanes.get(k), { tokens: b });
  w.stop();
  return { events, spoken, lanes: [...s.lanes.keys()] };
}

test('one translation lane per server language (any language in, every language out)', () => {
  assert.deepEqual(run(['en', 'tl', 'fr'], ['en', 'tl', 'fr']).lanes, ['en', 'tl', 'fr']);
});

test('Taglish caption: English keeps the original English words in order; Tagalog keeps the Tagalog', () => {
  const { events } = run(['en', 'tl'], ['en', 'tl']);
  const fin = events.find((e) => e.type === 'final');
  assert.equal(fin.text, 'Pare, sandali lang ha, kasi yung internet ko is so slow today,');
  assert.equal(fin.lang, 'tl');
  assert.equal(fin.translations.en.text, 'Dude, just a moment, because my internet is so slow today,');
  assert.equal(fin.translations.tl.text, 'Pare, sandali lang ha, kasi yung internet ko ay sobrang bagal ngayon,');
});

test('voice channel: Tagalog speech is spoken once, in English (never back in Tagalog)', () => {
  const { spoken } = run(['en', 'tl'], ['en', 'tl']);
  assert.ok(spoken.length > 0);
  assert.ok(spoken.every((x) => x.lang === 'en'), JSON.stringify(spoken));
  assert.equal(spoken.map((x) => x.text).join(' '), 'Dude, just a moment, because my internet is so slow today,');
});

test('voice channel with English + French: other languages are spoken in the main language only', () => {
  const { spoken } = run(['en', 'fr'], ['en', 'fr']);
  assert.ok(spoken.length > 0);
  assert.ok(spoken.every((x) => x.lang === 'en'), JSON.stringify(spoken)); // Tagalog -> English, not also French
});

test('personal listeners (not the channel) get their own language even when the channel speaks another', () => {
  const { spoken } = run(['en', 'fr'], ['en'], ['en', 'fr']);
  const langs = new Set(spoken.map((x) => x.lang));
  assert.ok(langs.has('en') && langs.has('fr'), JSON.stringify(spoken));
});

test('a listener is never dubbed their own language when nothing needed translating', () => {
  const w = new CloudWorker({ sonioxKey: async () => 'x', elevenKey: 'x' });
  const spoken: string[] = [];
  (w as any).speak = (_s: unknown, _l: string, text: string) => spoken.push(text);
  w.start();
  w.sendJson({ type: 'guild_config', guild_id: 'g', text_targets: ['en', 'tl'], audio_targets: ['en', 'tl'], channel_dub_langs: ['en', 'tl'], expected_langs: null });
  w.sendJson({ type: 'stream_open', sid: 1, guild_id: 'g', user_id: 'u', name: 'n', speak_lang: 'auto' });
  const s = (w as any).streams.get(1);
  (w as any).syncLanes(s);
  (w as any).onSoniox(s, s.lanes.get('en'), { tokens: [tok('Hello everyone, ready to play?', 'en', 'none')] });
  (w as any).onSoniox(s, s.lanes.get('en'), { tokens: [END] });
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
  assert.equal(peak(agc.process(Buffer.alloc(640))), 0);
});

test('captions never fuse words where original and translated text meet', async () => {
  const { joinPiece } = await import('../src/worker/CloudWorker.js');
  assert.equal('internet ko' + joinPiece('internet ko', 'sobrang bagal', true), 'internet ko sobrang bagal');
  assert.equal('internet ko' + joinPiece('internet ko', ' sobrang', true), 'internet ko sobrang');
  assert.equal('okay' + joinPiece('okay', ', fine', true), 'okay, fine');
  assert.equal('pa' + joinPiece('pa', 'nalo', false), 'panalo'); // same kind of text: untouched
});
