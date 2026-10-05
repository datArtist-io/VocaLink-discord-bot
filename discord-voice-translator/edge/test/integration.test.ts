/**
 * Integration: GuildSession (edge) <-> real Python worker process (fake models)
 * over TCP. Verifies captions, dub audio content, web listener fan-out, opt-out,
 * and survival of a worker crash (state replay + buffered audio).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { CaptionSink, type CaptionMessage } from '../src/discord/captions.js';
import { Metrics } from '../src/metrics/Metrics.js';
import { Store } from '../src/store/Store.js';
import { GuildSession } from '../src/voice/GuildSession.js';
import { passthroughDecoder } from '../src/audio/opus.js';
import { WorkerClient } from '../src/worker/WorkerClient.js';
import { WebHub, type SocketLike } from '../src/web/hub.js';
import { createLogger } from '../src/util/log.js';
import { FakeVoiceLink, demod48, modemPcm16, startWorker, stereoToMono, waitFor, type WorkerProc } from './helpers.js';

const procs: WorkerProc[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const c of cleanups) await c();
  for (const p of procs) await p.stop();
});

class Target {
  msgs = new Map<string, string>();
  async send(content: string): Promise<CaptionMessage> {
    const id = `m${this.msgs.size + 1}`;
    this.msgs.set(id, content);
    return { id, edit: async (c: string) => void this.msgs.set(id, c) };
  }
  all(): string {
    return [...this.msgs.values()].join('\n---\n');
  }
}

class Sock implements SocketLike {
  json: Record<string, unknown>[] = [];
  bin: Buffer[] = [];
  bufferedAmount = 0;
  send(d: string | Buffer): void {
    if (typeof d === 'string') this.json.push(JSON.parse(d));
    else this.bin.push(d);
  }
  close(): void {}
}

function makeSession(client: WorkerClient, opts: { dubLang?: string | null; textTargets?: string[] } = {}) {
  const store = new Store(':memory:');
  store.updateSettings('g1', { textTargets: opts.textTargets ?? ['en', 'fr'], dubLang: opts.dubLang === undefined ? 'fr' : opts.dubLang });
  const voice = new FakeVoiceLink();
  const target = new Target();
  const hub = new WebHub();
  const workers = Object.assign(new EventEmitter(), { clientFor: () => client });
  let session!: GuildSession;
  const captions = new CaptionSink(target, { burst: 50, refillMs: 10, editIntervalMs: 20, onWritten: (k, id) => session.indexCaption(k, id) });
  const names: Record<string, string> = { u1: 'Ada', u2: 'Bayo', u3: 'Chi' };
  cleanups.push(() => void session.stop({ summary: false }));
  session = new GuildSession({
    guildId: 'g1', voice, workers, store, metrics: new Metrics(), captions, hub,
    resolveMember: (id) => (names[id] ? { name: names[id]!, bot: false } : { name: 'bot', bot: true }),
    decoderFactory: passthroughDecoder, log: createLogger('test'), botUserId: 'bot',
    playout: { staleMs: 8000, prebufferMs: 20 },
  });
  return { store, voice, target, hub, session, captions };
}

async function connect(port: number): Promise<WorkerClient> {
  const c = new WorkerClient({ host: '127.0.0.1', port, token: 'secret', heartbeatMs: 500, deadMs: 3000, maxBackoffMs: 300 });
  c.start();
  cleanups.push(() => c.stop());
  await waitFor(() => c.ready, 10_000);
  return c;
}

test('speech -> captions + French dub audio in the voice channel + web listener', async () => {
  const w = await startWorker();
  procs.push(w);
  const client = await connect(w.port);
  assert.equal(client.info?.hardware.tier, 'gpu8');
  assert.ok(client.info!.languages.yo);
  const { voice, target, hub, session, store } = makeSession(client);
  session.start();
  const sock = new Sock();
  hub.attach('g1', 'listener', 'yo', sock); // web listener wants Yoruba audio
  await new Promise((r) => setTimeout(r, 100));

  await voice.speak('u1', modemPcm16('good morning everyone, the meeting starts now', 'en'));
  // gpu8 plan has incremental dubbing: clause 1 is dubbed while the speaker is
  // still talking, then only the remainder after the final transcript.
  await waitFor(() => (voice.playCount >= 2 && !voice.isPlaying() ? true : undefined), 15_000);
  await waitFor(() => /> good morning everyone/.test(target.all()), 5000);

  // captions: final caption with original + French translation
  const caps = target.all();
  assert.match(caps, /\*\*Ada\*\* · EN/);
  assert.match(caps, /> good morning everyone, the meeting starts now/);
  assert.match(caps, /→ \*\*FR\*\* 🔊 \[fr\] good morning everyone, the meeting starts now/);

  // the dub actually played in the channel decodes to the French translation
  const mono = stereoToMono(Buffer.concat(voice.played));
  const runs = demod48(mono);
  // back-to-back dubs demodulate as one run: "lang|text" + "lang|text"
  const dubs = (runs.map(([l, t]) => `${l}|${t}`).join('')).split(/(?=fr\|)/).map((x) => x.slice(3));
  assert.deepEqual(dubs, ['[fr] good morning everyone,', '[fr] the meeting starts now']);

  // web listener got Yoruba caption + Yoruba dub audio (24 kHz frames)
  await waitFor(() => sock.json.some((j) => j.type === 'dub_end'), 5000);
  const cap = sock.json.find((j) => j.type === 'caption' && j.final) as { text: string };
  assert.equal(cap.text, '[yo] good morning everyone, the meeting starts now');
  assert.ok(sock.bin.length > 10);

  // analytics row (no text) + caption index for /correct
  const a = store.analytics('g1', 0) as { utterances: number };
  assert.equal(a.utterances, 1);
  await session.stop({ summary: false });
  client.stop();
});

test('opted-out users are never sent to the worker; bots ignored', async () => {
  const w = await startWorker();
  procs.push(w);
  const client = await connect(w.port);
  const { voice, target, session, store } = makeSession(client, { dubLang: null });
  store.updateUser('u2', { optout: true });
  session.start();
  await voice.speak('u2', modemPcm16('this must never be translated', 'en'));
  await voice.speak('botuser', modemPcm16('bot audio', 'en'));
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(session.counts.framesUp, 0);
  assert.equal(voice.subscribed.size, 0);
  assert.doesNotMatch(target.all(), /never be translated/);
  await session.stop({ summary: false });
  client.stop();
});

test('worker crash: voice stays up, audio is buffered and replayed after restart', async () => {
  const w = await startWorker();
  const port = w.port;
  const client = await connect(port);
  const { voice, target, session } = makeSession(client, { dubLang: null, textTargets: ['en', 'fr'] });
  session.start();
  await voice.speak('u3', modemPcm16('first sentence before the crash', 'en'));
  await waitFor(() => /first sentence before the crash/.test(target.all()) && /\[fr\] first/.test(target.all()), 10_000);

  await w.stop(); // kill -9 the worker
  await waitFor(() => client.status !== 'ready', 5000);
  assert.equal(voice.destroyed, false, 'voice connection must survive a worker crash');
  // user keeps talking while the worker is down (goes into the ring buffer)
  await voice.speak('u3', modemPcm16('spoken while the worker was down', 'en'), 2);
  const w2 = await startWorker({}, port);
  procs.push(w2);
  await waitFor(() => client.ready, 10_000);
  await waitFor(() => /spoken while the worker was down/.test(target.all()), 15_000);
  assert.match(target.all(), /Translation paused/);
  assert.match(target.all(), /Translation resumed/);
  assert.equal(client.stats.disconnects, 1);
  // and new speech after the restart still works
  await voice.speak('u3', modemPcm16('after restart', 'en'));
  await waitFor(() => /\[fr\] after restart/.test(target.all()), 10_000);
  await session.stop({ summary: false });
  client.stop();
});

test('summary on stop + glossary/correct round trip', async () => {
  const w = await startWorker();
  procs.push(w);
  const client = await connect(w.port);
  const { voice, session, store } = makeSession(client, { dubLang: null });
  store.addTerm({ guildId: 'g1', srcLang: 'en', tgtLang: '*', source: 'Ade', target: 'Adé', kind: 'term', createdBy: 'x' });
  session.start();
  await voice.speak('u1', modemPcm16('we need to finish the report by friday', 'en'));
  await waitFor(() => session.counts.utterances === 1, 10_000);
  const r = (await client.request({ type: 'correct', original: 'see you at the bank', corrected: 'see you at the riverbank', src_lang: 'en', tgt_lang: 'fr' }, 'correct_result')) as unknown as { terms: { source: string; target: string }[] };
  assert.deepEqual(r.terms.map((t) => [t.source, t.target]), [['bank', 'riverbank']]);
  const summary = (await session.stop()) as { ok: boolean; method: string; by_lang: Record<string, unknown> };
  assert.equal(summary.ok, true);
  assert.equal(summary.method, 'llm');
  assert.ok(summary.by_lang.fr);
  client.stop();
});
