/** Edge configuration from environment variables (see .env.example). */

import { parseWorkerUrls } from './worker/WorkerPool.js';

export interface EdgeConfig {
  discordToken: string;
  clientId: string;
  devGuildId: string | null;
  registerCommandsOnStart: boolean;
  workers: { host: string; port: number }[];
  workerToken: string;
  dbPath: string;
  webPort: number;
  webHost: string;
  publicUrl: string;
  webSecret: string | null;
  mirrorTokens: string[];
  defaultTextTargets: string[];
  autoLeaveMs: number;
  listenTtlMs: number;
  adminTtlMs: number;
  logLevel: string;
  playout: { staleMs: number; maxQueue: number; duckGain: number };
  daveFailureTolerance: number;
  consentVersion: string;
  privacyUrl: string;
}

function req(env: NodeJS.ProcessEnv, k: string): string {
  const v = env[k];
  if (!v) throw new Error(`missing required environment variable ${k}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { requireDiscord?: boolean } = {}): EdgeConfig {
  const requireDiscord = opts.requireDiscord ?? true;
  const port = Number(env.WEB_PORT ?? 8080);
  return {
    discordToken: requireDiscord ? req(env, 'DISCORD_TOKEN') : (env.DISCORD_TOKEN ?? ''),
    clientId: requireDiscord ? req(env, 'DISCORD_CLIENT_ID') : (env.DISCORD_CLIENT_ID ?? ''),
    devGuildId: env.DEV_GUILD_ID || null,
    registerCommandsOnStart: (env.REGISTER_COMMANDS ?? '1') === '1',
    workers: parseWorkerUrls(env.WORKER_URLS ?? 'worker:7700'),
    workerToken: env.WORKER_TOKEN ?? '',
    dbPath: env.DB_PATH ?? '/data/edge.sqlite',
    webPort: port,
    webHost: env.WEB_HOST ?? '0.0.0.0',
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    webSecret: env.WEB_SECRET || null,
    mirrorTokens: (env.MIRROR_BOT_TOKENS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    defaultTextTargets: (env.DEFAULT_TEXT_TARGETS ?? 'en').split(',').map((s) => s.trim()).filter(Boolean),
    autoLeaveMs: Number(env.AUTO_LEAVE_MS ?? 120_000),
    listenTtlMs: Number(env.LISTEN_TTL_MS ?? 12 * 3600_000),
    adminTtlMs: Number(env.ADMIN_TTL_MS ?? 3600_000),
    logLevel: env.LOG_LEVEL ?? 'info',
    playout: {
      staleMs: Number(env.DUB_STALE_MS ?? 3000),
      maxQueue: Number(env.DUB_MAX_QUEUE ?? 3),
      duckGain: Number(env.DUB_DUCK_GAIN ?? 0.35),
    },
    daveFailureTolerance: Number(env.DAVE_FAILURE_TOLERANCE ?? 36),
    consentVersion: env.CONSENT_VERSION ?? '2026-10-v1',
    privacyUrl: env.PRIVACY_URL ?? '',
  };
}
