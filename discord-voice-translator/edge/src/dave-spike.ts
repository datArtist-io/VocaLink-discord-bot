/**
 * PHASE 0 SPIKE — verifies Risk R1 (DAVE end-to-end-encrypted voice receive)
 * on YOUR server before anything else is trusted.
 *
 *   DISCORD_TOKEN=... SPIKE_GUILD_ID=... SPIKE_CHANNEL_ID=... [SPIKE_SECONDS=180] npm run dave-spike
 *
 * What to do while it runs (3 minutes):
 *   1. Two or more people talk normally.
 *   2. Someone LEAVES and RE-JOINS the channel while others talk (each
 *      membership change forces a DAVE MLS key transition - the moment the
 *      upstream bug discord.js#11441 drops packets).
 *   3. Listen for the bot's beep (tests the send path through DAVE).
 *
 * Output: spike-out/<user>.wav (16 kHz mono, decrypted + decoded) and a JSON
 * report with packet loss overall vs. around key transitions. PASS criteria:
 * overall loss < 5 % and transition-window loss < 20 % with no stuck speakers.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client, Events, GatewayIntentBits, type VoiceBasedChannel } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';

import { EventEmitter } from 'node:events';
import { createDecoder, opusBackend } from './audio/opus.js';
import { BYTES_20MS_48K_MONO, monoToStereoGain } from './audio/pcm.js';
import type { PullResult } from './audio/PlayoutScheduler.js';
import { createLogger } from './util/log.js';
import { DiscordVoiceLink } from './voice/DiscordVoiceLink.js';

const token = process.env.DISCORD_TOKEN!;
const guildId = process.env.SPIKE_GUILD_ID!;
const channelId = process.env.SPIKE_CHANNEL_ID!;
const seconds = Number(process.env.SPIKE_SECONDS ?? 180);
if (!token || !guildId || !channelId) throw new Error('set DISCORD_TOKEN, SPIKE_GUILD_ID, SPIKE_CHANNEL_ID');

const log = createLogger('spike');
const out = join(process.cwd(), 'spike-out');
mkdirSync(out, { recursive: true });

interface U {
  pcm: Buffer[];
  packets: number;
  decodeErrors: number;
  speakingMs: number;
  speakingSince: number | null;
  packetTimes: number[];
}
const users = new Map<string, U>();
const transitions: number[] = [];
const daveEvents: Record<string, unknown>[] = [];

class Beep extends EventEmitter {
  private left = 50; // 1 s
  private t = 0;
  pull(): PullResult {
    if (this.left-- <= 0) return { end: 0 };
    const b = Buffer.alloc(BYTES_20MS_48K_MONO);
    for (let i = 0; i < 960; i++, this.t++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * this.t) / 48000)), i * 2);
    return { frame: monoToStereoGain(b) };
  }
}

function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
client.on(Events.VoiceStateUpdate, (o, n) => {
  if (n.guild.id !== guildId) return;
  if (o.channelId === channelId || n.channelId === channelId) {
    if (o.channelId !== n.channelId) {
      transitions.push(Date.now());
      log.info('membership change (DAVE transition expected)', { user: n.id, joined: n.channelId === channelId });
    }
  }
});

client.once(Events.ClientReady, async () => {
  log.info('dependency report', { report: generateDependencyReport() });
  log.info('opus backend', { backend: opusBackend() });
  const ch = (await client.channels.fetch(channelId)) as VoiceBasedChannel;
  const link = new DiscordVoiceLink(ch, { log, decryptionFailureTolerance: 36 });
  link.on('dave', (e: Record<string, unknown>) => {
    daveEvents.push({ t: Date.now(), ...e });
    log.info('dave', e);
  });
  await link.connect();
  log.info('joined with DAVE enabled; talk now', { seconds });
  link.play(new Beep());
  const beepTimer = setInterval(() => !link.isPlaying() && link.play(new Beep()), 30_000);

  const decoders = new Map<string, ReturnType<typeof createDecoder>>();
  link.on('speaking', (uid: string, speaking: boolean) => {
    let u = users.get(uid);
    if (!u) users.set(uid, (u = { pcm: [], packets: 0, decodeErrors: 0, speakingMs: 0, speakingSince: null, packetTimes: [] }));
    if (speaking) {
      u.speakingSince = Date.now();
      link.subscribe(uid);
    } else if (u.speakingSince) {
      u.speakingMs += Date.now() - u.speakingSince;
      u.speakingSince = null;
    }
  });
  link.on('packet', (uid: string, opus: Buffer) => {
    const u = users.get(uid);
    if (!u) return;
    u.packets++;
    u.packetTimes.push(Date.now());
    let d = decoders.get(uid);
    if (!d) decoders.set(uid, (d = createDecoder()));
    try {
      u.pcm.push(d.decode(opus));
    } catch {
      u.decodeErrors++;
    }
  });

  setTimeout(async () => {
    clearInterval(beepTimer);
    link.destroy();
    const report: Record<string, unknown> = { transitions: transitions.length, dave_events: daveEvents.filter((e) => e.event !== 'health'), users: {} };
    let worstOverall = 0;
    let worstTransition = 0;
    for (const [uid, u] of users) {
      if (u.speakingSince) u.speakingMs += Date.now() - u.speakingSince;
      const expected = Math.max(1, Math.round(u.speakingMs / 20) - 5);
      const loss = Math.max(0, 1 - u.packets / expected);
      // packets inside +-3 s windows around membership changes vs. expected at 50 pps while speaking
      const inWin = (t: number) => transitions.some((x) => Math.abs(t - x) <= 3000);
      const winPackets = u.packetTimes.filter(inWin).length;
      const gaps = u.packetTimes.slice(1).map((t, i) => t - u.packetTimes[i]!).filter((g, i) => g > 60 && g < 400 && inWin(u.packetTimes[i]!)).reduce((a, g) => a + Math.round(g / 20) - 1, 0);
      const tLoss = winPackets ? gaps / (winPackets + gaps) : 0;
      worstOverall = Math.max(worstOverall, loss);
      worstTransition = Math.max(worstTransition, tLoss);
      writeFileSync(join(out, `${uid}.wav`), wav(Buffer.concat(u.pcm)));
      (report.users as Record<string, unknown>)[uid] = {
        packets: u.packets, speaking_s: Math.round(u.speakingMs / 100) / 10, est_loss_pct: Math.round(loss * 1000) / 10,
        transition_window_packets: winPackets, transition_loss_pct: Math.round(tLoss * 1000) / 10, decode_errors: u.decodeErrors,
        wav: join(out, `${uid}.wav`),
      };
    }
    const pass = users.size > 0 && worstOverall < 0.05 && worstTransition < 0.2;
    report.verdict = users.size === 0 ? 'NO AUDIO RECEIVED - FAIL (check permissions, selfDeaf, DAVE)' : pass ? 'PASS' : 'FAIL - see loss numbers';
    console.log(JSON.stringify(report, null, 2));
    console.log('Listen to the WAV files: speech must be clear and complete.');
    await client.destroy();
    process.exit(pass ? 0 : 2);
  }, seconds * 1000);
});

await client.login(token);
