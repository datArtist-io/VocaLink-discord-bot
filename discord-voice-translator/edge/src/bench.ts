/**
 * One-off latency benchmark, run on the real host (e.g. Railway Singapore) when BENCH=1.
 * Streams a recorded Taglish clip at real speed through each candidate and logs, per stage,
 * how long after a word is SPOKEN its text / translation / voice is available.
 *
 *   Soniox  : speech -> translated text (one socket)
 *   Deepgram: speech -> text (live), then Gemini text -> translation
 *   ElevenLabs: text -> first audio byte
 *
 * Results are written to the log as `bench …` lines. It never touches Discord.
 */

import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

import type { Logger } from './util/log.js';

const CLIP_URL =
  process.env.BENCH_CLIP_URL ??
  'https://raw.githubusercontent.com/datArtist-io/VocaLink-discord-bot/vocalink-fast-cloud-pipeline/discord-voice-translator/bench/taglish-16k.pcm';
const FRAME = 640; // 20 ms at 16 kHz s16

const pct = (xs: number[], q: number) => (xs.length ? Math.round([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))]!) : null);
const stats = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 0.5), p90: pct(xs, 0.9), min: xs.length ? Math.round(Math.min(...xs)) : null });

async function streamRealtime(ws: WebSocket, pcm: Buffer, t0: number): Promise<void> {
  for (let i = 0; i < pcm.length; i += FRAME) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(pcm.subarray(i, i + FRAME));
    const due = t0 + ((i + FRAME) / 32000) * 1000;
    await new Promise((r) => setTimeout(r, Math.max(0, due - performance.now())));
  }
}

async function benchSoniox(pcm: Buffer, key: string, log: Logger): Promise<void> {
  const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket');
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  ws.send(JSON.stringify({
    api_key: key, model: process.env.SONIOX_MODEL || 'stt-rt-v6', audio_format: 'pcm_s16le', sample_rate: 16000, num_channels: 1,
    language_hints: ['tl', 'en'], enable_language_identification: true, enable_endpoint_detection: true,
    translation: { type: 'two_way', language_a: 'tl', language_b: 'en' },
  }));
  const t0 = performance.now();
  const seen: number[] = [];
  const finals: number[] = [];
  const translated: number[] = [];
  let lastSrcEnd = 0;
  let text = '';
  let err = '';
  const done = new Promise<void>((res) => {
    ws.on('message', (m) => {
      const now = performance.now() - t0;
      const d = JSON.parse(String(m));
      if (d.error_code) { err = `${d.error_code} ${d.error_message}`; res(); return; }
      for (const t of d.tokens ?? []) {
        if (t.translation_status === 'translation') {
          if (t.is_final) { translated.push(now - lastSrcEnd); if (t.language === 'en') text += t.text; }
          continue;
        }
        if (typeof t.end_ms !== 'number' || !t.text.trim()) continue;
        if (t.is_final) { finals.push(now - t.end_ms); lastSrcEnd = Math.max(lastSrcEnd, t.end_ms); if (t.language === 'en') text += t.text; }
        else seen.push(now - t.end_ms);
      }
      if (d.finished) res();
    });
    ws.on('close', () => res());
  });
  await streamRealtime(ws, pcm, t0);
  ws.send('');
  await Promise.race([done, new Promise((r) => setTimeout(r, 8000))]);
  ws.close();
  log.info('bench soniox', { error: err || undefined, word_first_seen: stats(seen), word_final: stats(finals), translation_after_source_chunk: stats(translated), english: text.trim().slice(0, 200) });
}

async function benchDeepgram(pcm: Buffer, key: string, model: string, log: Logger): Promise<string[]> {
  const url = `wss://api.deepgram.com/v1/listen?model=${model}&language=tl&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=100&smart_format=true&punctuate=true`;
  const ws = new WebSocket(url, { headers: { Authorization: `Token ${key}` } });
  const opened = await new Promise<string | null>((res) => {
    ws.once('open', () => res(null));
    ws.once('unexpected-response', (_q, r) => res(`HTTP ${r.statusCode} ${String(r.headers['dg-error'] ?? '')}`));
    ws.once('error', (e) => res(String(e.message)));
  });
  if (opened) { log.info('bench deepgram', { model, error: opened }); return []; }
  const t0 = performance.now();
  const seen = new Map<string, number>();
  const firstSeen: number[] = [];
  const final: number[] = [];
  const phrases: string[] = [];
  ws.on('message', (m) => {
    const now = performance.now() - t0;
    const d = JSON.parse(String(m));
    if (d.type !== 'Results') return;
    const alt = d.channel?.alternatives?.[0];
    for (const w of alt?.words ?? []) {
      const k = `${Math.round(w.start * 100)}`;
      if (!seen.has(k)) { seen.set(k, now); firstSeen.push(now - w.end * 1000); }
      if (d.is_final) final.push(now - w.end * 1000);
    }
    if (d.is_final && alt?.transcript) phrases.push(alt.transcript);
  });
  await streamRealtime(ws, pcm, t0);
  ws.send(JSON.stringify({ type: 'Finalize' }));
  await new Promise((r) => setTimeout(r, 2000));
  ws.send(JSON.stringify({ type: 'CloseStream' }));
  ws.close();
  log.info('bench deepgram', { model, word_first_seen: stats(firstSeen), word_final: stats(final), transcript: phrases.join(' ').slice(0, 220) });
  return phrases;
}

async function benchGemini(phrases: string[], key: string, log: Logger): Promise<void> {
  const models = (process.env.BENCH_GEMINI_MODELS ?? 'gemini-2.5-flash-lite,gemini-2.0-flash-lite,gemini-2.5-flash').split(',');
  const sample = phrases.length ? phrases.slice(0, 4) : ['Pare, sandali lang ha, kasi yung internet ko is so slow today.', 'Huwag ka nang mag-alala, panalo tayo mamaya.'];
  for (const model of models) {
    const ttft: number[] = [];
    const total: number[] = [];
    let out = '';
    let error = '';
    for (const p of sample) {
      const t = performance.now();
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: `Translate this Filipino/Taglish speech into natural casual English. Output only the translation.\n\n${p}` }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 120, ...(model.includes('2.5') ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
          }),
        });
        if (!r.ok || !r.body) { error = `HTTP ${r.status} ${(await r.text()).slice(0, 160)}`; break; }
        let first = 0;
        let txt = '';
        for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
          if (!first) first = performance.now() - t;
          txt += Buffer.from(c).toString();
        }
        ttft.push(first);
        total.push(performance.now() - t);
        const m = [...txt.matchAll(/"text":\s*"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]).join('');
        if (!out) out = m.slice(0, 160);
      } catch (e) {
        error = String((e as Error).message);
        break;
      }
    }
    log.info('bench gemini', { model, error: error || undefined, first_token: stats(ttft), total: stats(total), example: out });
  }
}

async function benchEleven(key: string, log: Logger): Promise<void> {
  for (const model of (process.env.BENCH_TTS_MODELS ?? 'eleven_flash_v2_5,eleven_v4_turbo').split(',')) {
  const ttfb: number[] = [];
  let error = '';
  for (const text of ['Dude, just a moment, okay,', 'because my internet is so slow today,', "Don't worry, we'll win later.", 'Kumusta kayong lahat?', 'Tara, laro na tayo mamaya.']) {
    const t = performance.now();
    try {
      const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=pcm_48000', {
        method: 'POST', signal: AbortSignal.timeout(10_000),
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: model }),
      });
      if (!r.ok || !r.body) { error = `HTTP ${r.status} ${(await r.text()).slice(0, 160)}`; continue; }
      const it = (r.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
      await it.next();
      ttfb.push(performance.now() - t);
      await r.body.cancel().catch(() => {});
    } catch (e) {
      error = String((e as Error).message);
    }
  }
  log.info('bench elevenlabs', { model, error: error || undefined, first_audio: stats(ttfb) });
  }
}

export async function runBench(log: Logger): Promise<void> {
  log.info('bench starting', { clip: CLIP_URL, region: process.env.RAILWAY_REPLICA_REGION ?? process.env.RAILWAY_REGION ?? null });
  const r = await fetch(CLIP_URL);
  if (!r.ok) { log.error('bench clip download failed', { status: r.status }); return; }
  const pcm = Buffer.from(await r.arrayBuffer());
  const env = process.env;
  if (env.ELEVENLABS_API_KEY) await benchEleven(env.ELEVENLABS_API_KEY, log).catch((e) => log.error('bench elevenlabs failed', { err: e }));
  if (env.BENCH_ONLY === 'tts') { log.info('bench done'); return; }
  if (env.SONIOX_API_KEY) await benchSoniox(pcm, env.SONIOX_API_KEY, log).catch((e) => log.error('bench soniox failed', { err: e }));
  let phrases: string[] = [];
  if (env.DEEPGRAM_API_KEY) {
    for (const model of ['nova-3', 'nova-2']) {
      phrases = await benchDeepgram(pcm, env.DEEPGRAM_API_KEY, model, log).catch((e) => { log.error('bench deepgram failed', { err: e }); return []; });
      if (phrases.length) break;
    }
  }
  if (env.GEMINI_API_KEY) await benchGemini(phrases, env.GEMINI_API_KEY, log).catch((e) => log.error('bench gemini failed', { err: e }));
  log.info('bench done');
}
