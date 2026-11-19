/** Edge configuration from environment variables (see .env.example). */

import { parseWorkerUrls } from './worker/WorkerPool.js';

export interface EdgeConfig {
  discordToken: string;
  clientId: string;
  devGuildId: string | null;
  registerCommandsOnStart: boolean;
  /** 'cloud' = fast in-process pipeline (Soniox + ElevenLabs); 'worker' = self-hosted Python worker. */
  pipeline: 'cloud' | 'worker';
  cloud: {
    sonioxApiKey: string;
    sonioxUrl?: string;
    sonioxModel?: string;
    elevenApiKey: string;
    elevenVoiceId?: string;
    elevenModel?: string;
    elevenConcurrency?: number;
    defaultLangs: string[];
  };
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
  termsUrl: string;
  /** Discord shop SKU ids for the paid plans; empty = plans off (everything unlimited) */
  billing: { skuPlus: string | null; skuPro: string | null; hours: { free?: number; plus?: number; pro?: number } };
}

/** A number from the environment; empty or invalid values fall back to the default. */
function num(v: string | undefined, def: number): number {
  if (v === undefined || v.trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function req(env: NodeJS.ProcessEnv, k: string): string {
  const v = env[k];
  if (!v) throw new Error(`missing required environment variable ${k}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { requireDiscord?: boolean } = {}): EdgeConfig {
  const requireDiscord = opts.requireDiscord ?? true;
  const port = num(env.WEB_PORT, num(env.PORT, 8080));
  const pipeline = (env.PIPELINE ?? (env.SONIOX_API_KEY && !env.WORKER_URLS ? 'cloud' : 'worker')) === 'cloud' ? 'cloud' : 'worker';
  if (pipeline === 'cloud') {
    req(env, 'SONIOX_API_KEY');
    req(env, 'ELEVENLABS_API_KEY');
  }
  return {
    discordToken: requireDiscord ? req(env, 'DISCORD_TOKEN') : (env.DISCORD_TOKEN ?? ''),
    clientId: requireDiscord ? req(env, 'DISCORD_CLIENT_ID') : (env.DISCORD_CLIENT_ID ?? ''),
    devGuildId: env.DEV_GUILD_ID || null,
    registerCommandsOnStart: !['0', 'false', 'no', 'off'].includes((env.REGISTER_COMMANDS ?? '1').trim().toLowerCase()),
    pipeline,
    cloud: {
      sonioxApiKey: env.SONIOX_API_KEY ?? '',
      sonioxUrl: env.SONIOX_WS_URL || undefined,
      sonioxModel: env.SONIOX_MODEL || undefined,
      elevenApiKey: env.ELEVENLABS_API_KEY ?? '',
      elevenVoiceId: env.ELEVENLABS_VOICE_ID || undefined,
      elevenModel: env.ELEVENLABS_MODEL || undefined,
      elevenConcurrency: env.ELEVENLABS_CONCURRENCY ? Number(env.ELEVENLABS_CONCURRENCY) : undefined,
      defaultLangs: (env.DEFAULT_SPOKEN_LANGS ?? 'tl,en').split(',').map((x) => x.trim()).filter(Boolean),
    },
    workers: parseWorkerUrls(env.WORKER_URLS ?? 'worker:7700'),
    workerToken: env.WORKER_TOKEN ?? '',
    dbPath: env.DB_PATH ?? '/data/edge.sqlite',
    webPort: port,
    webHost: env.WEB_HOST ?? '0.0.0.0',
    // accept "my-app.up.railway.app" as well as a full URL
    publicUrl: ((u) => (/^https?:\/\//.test(u) ? u : `https://${u}`))(env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${port}`)).replace(/\/$/, ''),
    webSecret: env.WEB_SECRET || null,
    mirrorTokens: (env.MIRROR_BOT_TOKENS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    defaultTextTargets: (env.DEFAULT_TEXT_TARGETS ?? 'en').split(',').map((s) => s.trim()).filter(Boolean),
    autoLeaveMs: num(env.AUTO_LEAVE_MS, 120_000),
    listenTtlMs: num(env.LISTEN_TTL_MS, 12 * 3600_000),
    adminTtlMs: num(env.ADMIN_TTL_MS, 3600_000),
    logLevel: env.LOG_LEVEL ?? 'info',
    playout: {
      staleMs: num(env.DUB_STALE_MS, 3000),
      maxQueue: num(env.DUB_MAX_QUEUE, 3),
      duckGain: num(env.DUB_DUCK_GAIN, 0.35),
    },
    daveFailureTolerance: num(env.DAVE_FAILURE_TOLERANCE, 36),
    consentVersion: env.CONSENT_VERSION ?? '2026-10-v1',
    privacyUrl: env.PRIVACY_URL ?? '',
    termsUrl: env.TERMS_URL ?? '',
    billing: {
      skuPlus: env.SKU_PLUS?.trim() || null,
      skuPro: env.SKU_PRO?.trim() || null,
      hours: {
        free: env.PLAN_FREE_HOURS ? num(env.PLAN_FREE_HOURS, 3) : undefined,
        plus: env.PLAN_PLUS_HOURS ? num(env.PLAN_PLUS_HOURS, 30) : undefined,
        pro: env.PLAN_PRO_HOURS ? num(env.PLAN_PRO_HOURS, 60) : undefined,
      },
    },
  };
}
