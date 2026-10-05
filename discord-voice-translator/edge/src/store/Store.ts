/**
 * Edge persistence on SQLite (node:sqlite, no native addon).
 *
 * Privacy by design:
 *  - no audio is ever stored;
 *  - utterance analytics contain no text (languages, tiers, latencies only);
 *  - caption_index (needed to /correct a caption) keeps text for 24 h max;
 *  - /optout, consent records and voice-profile metadata are per user and
 *    deletable (/voice delete, /optout).
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface GuildSettings {
  textTargets: string[];          // caption languages
  dubLang: string | null;         // language spoken into the main channel (null = no dubbing)
  mode: 'literal' | 'natural' | 'cultural';
  voiceMode: 'house' | 'clone';
  mirrors: boolean;
  mirrorLangs: string[];
  summaries: boolean;
  expectedLangs: string[] | null; // restrict auto-detect
  captionsInThread: boolean;
}

export const DEFAULT_SETTINGS: GuildSettings = {
  textTargets: ['en'],
  dubLang: null,
  mode: 'literal',
  voiceMode: 'house',
  mirrors: false,
  mirrorLangs: [],
  summaries: true,
  expectedLangs: null,
  captionsInThread: true,
};

export interface UserPrefs {
  userId: string;
  speakLang: string | null;   // null/auto = detect
  hearLang: string | null;
  optout: boolean;
  whisperDm: boolean;
}

export interface GlossaryRow {
  id: number;
  guildId: string;
  srcLang: string;
  tgtLang: string;
  source: string;
  target: string;
  kind: 'term' | 'fix';
  createdBy: string;
  hits: number;
}

export interface UtteranceStat {
  guildId: string;
  ts: number;
  srcLang: string;
  targets: string[];
  tierMin: number | null;
  sttMs: number | null;
  mtMs: number | null;
  endpointMs: number | null;
  captionMs: number | null;
  firstAudioMs: number | null;
  flags: string[];
  sttProvider: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guild_settings (guild_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS user_prefs (user_id TEXT PRIMARY KEY, speak_lang TEXT, hear_lang TEXT,
        optout INTEGER NOT NULL DEFAULT 0, whisper_dm INTEGER NOT NULL DEFAULT 0, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS voice_consent (user_id TEXT PRIMARY KEY, consent_version TEXT NOT NULL,
        consented_at INTEGER NOT NULL, phrase TEXT NOT NULL, status TEXT NOT NULL, guild_id TEXT);
      CREATE TABLE IF NOT EXISTS glossary (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL,
        src_lang TEXT NOT NULL DEFAULT '*', tgt_lang TEXT NOT NULL DEFAULT '*', source TEXT NOT NULL, target TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'term', created_by TEXT, created_at INTEGER, hits INTEGER NOT NULL DEFAULT 0,
        UNIQUE(guild_id, src_lang, tgt_lang, source, kind));
      CREATE TABLE IF NOT EXISTS utterance_stats (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, ts INTEGER,
        src_lang TEXT, targets TEXT, tier_min INTEGER, stt_ms REAL, mt_ms REAL, endpoint_ms REAL, caption_ms REAL,
        first_audio_ms REAL, flags TEXT, stt_provider TEXT);
      CREATE INDEX IF NOT EXISTS utt_guild_ts ON utterance_stats(guild_id, ts);
      CREATE TABLE IF NOT EXISTS caption_index (message_id TEXT PRIMARY KEY, guild_id TEXT, user_id TEXT,
        src_lang TEXT, original TEXT, translations TEXT, created_at INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, channel_id TEXT,
        started_at INTEGER, ended_at INTEGER, utterances INTEGER DEFAULT 0, speakers INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    `);
  }

  // ------------------------------------------------------------------ kv
  getKv(k: string): string | null {
    const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
    return r?.v ?? null;
  }
  setKv(k: string, v: string): void {
    this.db.prepare('INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  // ------------------------------------------------------------------ guild settings
  getSettings(guildId: string): GuildSettings {
    const r = this.db.prepare('SELECT json FROM guild_settings WHERE guild_id = ?').get(guildId) as { json: string } | undefined;
    return { ...DEFAULT_SETTINGS, ...(r ? (JSON.parse(r.json) as Partial<GuildSettings>) : {}) };
  }

  updateSettings(guildId: string, patch: Partial<GuildSettings>): GuildSettings {
    const s = { ...this.getSettings(guildId), ...patch };
    this.db
      .prepare('INSERT INTO guild_settings(guild_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run(guildId, JSON.stringify(s), Date.now());
    return s;
  }

  // ------------------------------------------------------------------ users
  getUser(userId: string): UserPrefs {
    const r = this.db.prepare('SELECT * FROM user_prefs WHERE user_id = ?').get(userId) as Record<string, unknown> | undefined;
    return {
      userId,
      speakLang: (r?.speak_lang as string) ?? null,
      hearLang: (r?.hear_lang as string) ?? null,
      optout: Boolean(r?.optout),
      whisperDm: Boolean(r?.whisper_dm),
    };
  }

  updateUser(userId: string, patch: Partial<Omit<UserPrefs, 'userId'>>): UserPrefs {
    const u = { ...this.getUser(userId), ...patch };
    this.db
      .prepare(`INSERT INTO user_prefs(user_id, speak_lang, hear_lang, optout, whisper_dm, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET speak_lang = excluded.speak_lang, hear_lang = excluded.hear_lang,
        optout = excluded.optout, whisper_dm = excluded.whisper_dm, updated_at = excluded.updated_at`)
      .run(userId, u.speakLang, u.hearLang, u.optout ? 1 : 0, u.whisperDm ? 1 : 0, Date.now());
    return u;
  }

  optedOut(userId: string): boolean {
    return this.getUser(userId).optout;
  }

  whisperUsers(userIds: string[]): UserPrefs[] {
    return userIds.map((id) => this.getUser(id)).filter((u) => u.whisperDm);
  }

  // ------------------------------------------------------------------ voice consent
  recordConsent(userId: string, version: string, phrase: string, status: 'pending' | 'enrolled', guildId?: string): void {
    this.db
      .prepare(`INSERT INTO voice_consent(user_id, consent_version, consented_at, phrase, status, guild_id) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET consent_version = excluded.consent_version, consented_at = excluded.consented_at,
        phrase = excluded.phrase, status = excluded.status, guild_id = excluded.guild_id`)
      .run(userId, version, Date.now(), phrase, status, guildId ?? null);
  }

  consent(userId: string): { version: string; at: number; status: string } | null {
    const r = this.db.prepare('SELECT consent_version, consented_at, status FROM voice_consent WHERE user_id = ?').get(userId) as
      | { consent_version: string; consented_at: number; status: string }
      | undefined;
    return r ? { version: r.consent_version, at: r.consented_at, status: r.status } : null;
  }

  enrolledUsers(userIds: string[]): string[] {
    return userIds.filter((u) => this.consent(u)?.status === 'enrolled');
  }

  deleteConsent(userId: string): void {
    this.db.prepare('DELETE FROM voice_consent WHERE user_id = ?').run(userId);
  }

  // ------------------------------------------------------------------ glossary
  addTerm(row: Omit<GlossaryRow, 'id' | 'hits'>): number {
    const r = this.db
      .prepare(`INSERT INTO glossary(guild_id, src_lang, tgt_lang, source, target, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, src_lang, tgt_lang, source, kind) DO UPDATE SET target = excluded.target`)
      .run(row.guildId, row.srcLang || '*', row.tgtLang || '*', row.source, row.target, row.kind, row.createdBy, Date.now());
    return Number(r.lastInsertRowid);
  }

  removeTerm(guildId: string, id: number): boolean {
    return this.db.prepare('DELETE FROM glossary WHERE guild_id = ? AND id = ?').run(guildId, id).changes > 0;
  }

  glossary(guildId: string): GlossaryRow[] {
    return (this.db.prepare('SELECT * FROM glossary WHERE guild_id = ? ORDER BY id').all(guildId) as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id),
      guildId: String(r.guild_id),
      srcLang: String(r.src_lang),
      tgtLang: String(r.tgt_lang),
      source: String(r.source),
      target: String(r.target),
      kind: r.kind as 'term' | 'fix',
      createdBy: String(r.created_by ?? ''),
      hits: Number(r.hits),
    }));
  }

  // ------------------------------------------------------------------ captions index (24 h)
  indexCaption(messageId: string, guildId: string, userId: string, srcLang: string, original: string, translations: Record<string, string | null>): void {
    this.db
      .prepare('INSERT OR REPLACE INTO caption_index(message_id, guild_id, user_id, src_lang, original, translations, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(messageId, guildId, userId, srcLang, original, JSON.stringify(translations), Date.now());
  }

  caption(messageId: string): { userId: string; srcLang: string; original: string; translations: Record<string, string | null> } | null {
    const r = this.db.prepare('SELECT * FROM caption_index WHERE message_id = ?').get(messageId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return { userId: String(r.user_id), srcLang: String(r.src_lang), original: String(r.original), translations: JSON.parse(String(r.translations)) };
  }

  // ------------------------------------------------------------------ analytics (no text)
  recordUtterance(s: UtteranceStat): void {
    this.db
      .prepare(`INSERT INTO utterance_stats(guild_id, ts, src_lang, targets, tier_min, stt_ms, mt_ms, endpoint_ms, caption_ms, first_audio_ms, flags, stt_provider)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(s.guildId, s.ts, s.srcLang, s.targets.join(','), s.tierMin, s.sttMs, s.mtMs, s.endpointMs, s.captionMs, s.firstAudioMs, s.flags.join(','), s.sttProvider);
  }

  updateFirstAudio(guildId: string, ts: number, firstAudioMs: number): void {
    this.db
      .prepare('UPDATE utterance_stats SET first_audio_ms = ? WHERE id = (SELECT id FROM utterance_stats WHERE guild_id = ? AND ts = ? ORDER BY id DESC LIMIT 1)')
      .run(firstAudioMs, guildId, ts);
  }

  startSession(guildId: string, channelId: string): number {
    return Number(this.db.prepare('INSERT INTO sessions(guild_id, channel_id, started_at) VALUES (?, ?, ?)').run(guildId, channelId, Date.now()).lastInsertRowid);
  }

  endSession(id: number, utterances: number, speakers: number): void {
    this.db.prepare('UPDATE sessions SET ended_at = ?, utterances = ?, speakers = ? WHERE id = ?').run(Date.now(), utterances, speakers, id);
  }

  analytics(guildId: string | null, sinceMs: number): Record<string, unknown> {
    const where = guildId ? 'WHERE guild_id = ? AND ts >= ?' : 'WHERE ts >= ?';
    const args = guildId ? [guildId, sinceMs] : [sinceMs];
    const rows = this.db.prepare(`SELECT * FROM utterance_stats ${where} ORDER BY ts`).all(...args) as Record<string, unknown>[];
    const pct = (xs: number[], p: number) => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, b) => a - b);
      return Math.round(s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]!);
    };
    const col = (k: string) => rows.map((r) => r[k]).filter((v): v is number => typeof v === 'number');
    const byLang: Record<string, number> = {};
    const byTier: Record<string, number> = {};
    const flags: Record<string, number> = {};
    for (const r of rows) {
      byLang[String(r.src_lang)] = (byLang[String(r.src_lang)] ?? 0) + 1;
      if (r.tier_min !== null) byTier[String(r.tier_min)] = (byTier[String(r.tier_min)] ?? 0) + 1;
      for (const f of String(r.flags ?? '').split(',').filter(Boolean)) flags[f] = (flags[f] ?? 0) + 1;
    }
    const latency: Record<string, { p50: number | null; p90: number | null; n: number }> = {};
    for (const [name, k] of [
      ['vad_endpoint', 'endpoint_ms'],
      ['stt', 'stt_ms'],
      ['mt', 'mt_ms'],
      ['end_to_caption', 'caption_ms'],
      ['end_to_first_audio', 'first_audio_ms'],
    ] as const) {
      const xs = col(k);
      latency[name] = { p50: pct(xs, 0.5), p90: pct(xs, 0.9), n: xs.length };
    }
    const hourly: Record<string, number> = {};
    for (const r of rows) {
      const h = new Date(Number(r.ts)).toISOString().slice(0, 13);
      hourly[h] = (hourly[h] ?? 0) + 1;
    }
    const sessions = this.db
      .prepare(`SELECT COUNT(*) AS n, SUM(utterances) AS u FROM sessions ${guildId ? 'WHERE guild_id = ? AND started_at >= ?' : 'WHERE started_at >= ?'}`)
      .get(...args) as { n: number; u: number | null };
    return { utterances: rows.length, byLang, byTier, flags, latency, hourly, sessions: sessions.n, sessionUtterances: sessions.u ?? 0 };
  }

  /** Retention: captions index 24 h, analytics 30 days. */
  prune(now = Date.now()): void {
    this.db.prepare('DELETE FROM caption_index WHERE created_at < ?').run(now - 24 * 3600_000);
    this.db.prepare('DELETE FROM utterance_stats WHERE ts < ?').run(now - 30 * 24 * 3600_000);
  }

  close(): void {
    this.db.close();
  }
}
