/**
 * Edge entry point. Runs standalone or as a shard child (shard-manager.ts).
 */

import { Billing } from './billing/Billing.js';
import { Client, Events, GatewayIntentBits, REST, Routes } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';

import { opusBackend } from './audio/opus.js';
import { loadConfig } from './config.js';
import { COMMANDS, SIMPLE_COMMANDS } from './discord/commands.js';
import { TranslatorBot } from './discord/bot.js';
import { Metrics } from './metrics/Metrics.js';
import { Store } from './store/Store.js';
import { createLogger, setLogLevel } from './util/log.js';
import { MirrorManager } from './voice/Mirror.js';
import { TokenSigner } from './web/auth.js';
import { WebHub } from './web/hub.js';
import { WebServer } from './web/server.js';
import { CloudWorker } from './worker/CloudWorker.js';
import { VoiceBank } from './worker/VoiceBank.js';
import { WorkerPool } from './worker/WorkerPool.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  const log = createLogger('edge');
  const shardId = process.env.SHARDS ? Number(String(process.env.SHARDS).split(',')[0]) : 0;

  log.info('voice dependencies', { report: generateDependencyReport().split('\n').filter(Boolean).join(' | '), opus: opusBackend() });

  const store = new Store(cfg.dbPath);
  let secret = cfg.webSecret ?? store.getKv('web_secret');
  if (!secret) {
    secret = TokenSigner.randomSecret();
    store.setKv('web_secret', secret);
  }
  const signer = new TokenSigner(secret);
  const metrics = new Metrics();
  const hub = new WebHub();
  const billing = new Billing(store, { skuPlus: cfg.billing.skuPlus, skuPro: cfg.billing.skuPro, hours: cfg.billing.hours, log: log.child('billing') });
  hub.voiceMode = (g) => (billing.planOf(g).aiVoice ? 'ai' : 'device');
  const voiceBank = cfg.pipeline === 'cloud' ? new VoiceBank(store, { elevenKey: cfg.cloud.elevenApiKey, log: log.child('voices') }) : null;
  const cloud =
    cfg.pipeline === 'cloud'
      ? new CloudWorker({
          sonioxKey: async () => cfg.cloud.sonioxApiKey,
          sonioxUrl: cfg.cloud.sonioxUrl,
          sonioxModel: cfg.cloud.sonioxModel,
          elevenKey: cfg.cloud.elevenApiKey,
          elevenVoiceId: cfg.cloud.elevenVoiceId,
          elevenModel: cfg.cloud.elevenModel,
          elevenConcurrency: cfg.cloud.elevenConcurrency,
          voiceBank: voiceBank ?? undefined,
          defaultLangs: cfg.cloud.defaultLangs,
          onAudio: (g, ms) => billing.addUsage(g, ms),
          aiVoice: (g) => billing.planOf(g).aiVoice,
          log: log.child('cloud'),
        })
      : null;
  log.info('translation pipeline', { pipeline: cfg.pipeline });
  const pool = new WorkerPool(cfg.workers, { token: cfg.workerToken, edgeId: `edge-shard${shardId}-${process.pid}`, log: log.child('worker') }, 5000, cloud ? [cloud] : undefined);
  pool.start();

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const mirrors = cfg.mirrorTokens.length && shardId === 0 ? new MirrorManager(cfg.mirrorTokens, log.child('mirror'), cfg.daveFailureTolerance) : null;
  const bot = new TranslatorBot({ cfg, client, pool, store, metrics, hub, signer, mirrors, voiceBank, billing, log: log.child('bot') });
  bot.attach();

  const web = new WebServer({
    hub, signer, store, metrics, pool, log: log.child('web'),
    sessions: () => new Map([...bot.sessions].map(([g, a]) => [g, a.session])),
  });
  const port = await web.listen(cfg.webPort + shardId, cfg.webHost);
  log.info('web server listening', { port, publicUrl: cfg.publicUrl });

  client.once(Events.ClientReady, async (c) => {
    log.info('discord ready', { user: c.user.tag, guilds: c.guilds.cache.size, shard: shardId });
    if (cfg.registerCommandsOnStart && shardId === 0) {
      try {
        const rest = new REST().setToken(cfg.discordToken);
        const route = cfg.devGuildId ? Routes.applicationGuildCommands(cfg.clientId, cfg.devGuildId) : Routes.applicationCommands(cfg.clientId);
        await rest.put(route, { body: cfg.pipeline === 'cloud' ? SIMPLE_COMMANDS : COMMANDS });
        log.info('slash commands registered', { scope: cfg.devGuildId ? `guild ${cfg.devGuildId}` : 'global' });
      } catch (e) {
        log.error('command registration failed', { err: e });
      }
    }
    if (mirrors) await mirrors.start();
    if (billing.enabled) {
      try {
        const all = [];
        let after: string | undefined;
        for (let page = 0; page < 50; page++) {
          const got = await c.application.entitlements.fetch({ excludeEnded: true, limit: 100, ...(after ? { after } : {}) } as never) as unknown as Map<string, { id: string; skuId: string; guildId: string | null; deleted: boolean; endsAt: Date | null; consumed: boolean }>;
          const list = [...got.values()];
          all.push(...list);
          if (list.length < 100) break;
          after = list.map((e) => e.id).sort().at(-1);
        }
        billing.replaceAll(all.map((e) => ({ id: e.id, skuId: e.skuId, guildId: e.guildId, deleted: e.deleted, endsAt: e.endsAt, consumed: e.consumed })));
        log.info('plans loaded', { entitlements: all.length });
      } catch (e) {
        log.error('could not load Discord shop purchases', { err: e });
      }
    }
  });

  const pruneTimer = setInterval(() => store.prune(), 3600_000);
  pruneTimer.unref();

  const shutdown = async (sig: string) => {
    log.info('shutting down', { sig });
    const hard = setTimeout(() => process.exit(1), 20_000);
    hard.unref();
    billing.flush();
    await bot.shutdown().catch(() => {});
    await web.close().catch(() => {});
    await mirrors?.stop().catch(() => {});
    pool.stop();
    await client.destroy();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', { err: e }));

  await client.login(cfg.discordToken);

  // one-off latency benchmark on the real host (set BENCH=1, read the logs, then remove it)
  if (process.env.BENCH === '1') void import('./bench.js').then((m) => m.runBench(log.child('bench'))).catch((e) => log.error('bench crashed', { err: e }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
