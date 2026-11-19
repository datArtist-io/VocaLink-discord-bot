/**
 * Plans, Discord shop purchases and monthly usage, per server.
 *
 * Payment happens in Discord's own shop: a server owner buys a guild subscription SKU there,
 * Discord sends the bot an entitlement for that server, and the plan unlocks at once. Nothing
 * is charged or stored by VocaLink itself; it only reads which SKUs a server has.
 *
 * Until SKU ids are configured (SKU_PLUS / SKU_PRO), billing is off: every server gets the
 * full product with no limits, which is how the bot behaved before plans existed.
 */

import type { Store } from '../store/Store.js';
import type { Logger } from '../util/log.js';

export type PlanId = 'free' | 'plus' | 'pro';

export interface Plan {
  id: PlanId;
  name: string;
  /** hours of translated speech per server per calendar month (UTC) */
  hours: number;
  /** natural AI voices (ElevenLabs); otherwise each listener's device reads translations aloud */
  aiVoice: boolean;
  /** consented clone of a speaker's own voice */
  ownVoice: boolean;
}

export interface BillingOptions {
  skuPlus?: string | null;
  skuPro?: string | null;
  hours?: Partial<Record<PlanId, number>>;
  log?: Logger;
}

/** Minimal entitlement shape (matches discord.js Entitlement and the raw API object). */
export interface EntitlementLike {
  id: string;
  skuId: string;
  guildId: string | null;
  deleted?: boolean;
  endsAt?: Date | null;
  consumed?: boolean;
}

const month = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

export class Billing {
  readonly plans: Record<PlanId, Plan>;
  private readonly skuPlus: string | null;
  private readonly skuPro: string | null;
  /** guildId -> entitlement id -> entitlement */
  private ents = new Map<string, Map<string, EntitlementLike>>();
  /** unsaved usage in ms, per guild and month */
  private buffered = new Map<string, number>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly store: Store, o: BillingOptions = {}) {
    this.skuPlus = o.skuPlus || null;
    this.skuPro = o.skuPro || null;
    const h = o.hours ?? {};
    this.plans = {
      free: { id: 'free', name: 'Free', hours: h.free ?? 3, aiVoice: false, ownVoice: false },
      plus: { id: 'plus', name: 'Plus', hours: h.plus ?? 30, aiVoice: false, ownVoice: false },
      pro: { id: 'pro', name: 'Pro', hours: h.pro ?? 60, aiVoice: true, ownVoice: true },
    };
  }

  /** Plans are only enforced once at least one shop SKU is configured. */
  get enabled(): boolean {
    return Boolean(this.skuPlus || this.skuPro);
  }

  sku(plan: 'plus' | 'pro'): string | null {
    return plan === 'plus' ? this.skuPlus : this.skuPro;
  }

  // ------------------------------------------------------------------ entitlements
  private active(e: EntitlementLike, now = Date.now()): boolean {
    if (e.deleted || e.consumed) return false;
    return !e.endsAt || e.endsAt.getTime() > now;
  }

  /** Add or refresh one entitlement (create/update events, interaction payloads, fetches). */
  upsert(e: EntitlementLike): void {
    if (!e.guildId) return; // VocaLink sells per-server plans only
    let m = this.ents.get(e.guildId);
    if (!m) this.ents.set(e.guildId, (m = new Map()));
    if (this.active(e)) m.set(e.id, { ...e });
    else m.delete(e.id);
  }

  remove(e: Pick<EntitlementLike, 'id' | 'guildId'>): void {
    if (e.guildId) this.ents.get(e.guildId)?.delete(e.id);
  }

  /** Replace everything known with a full fetch from Discord. */
  replaceAll(list: Iterable<EntitlementLike>): void {
    this.ents.clear();
    for (const e of list) this.upsert(e);
  }

  // ------------------------------------------------------------------ plans
  planOf(guildId: string, now = Date.now()): Plan {
    if (!this.enabled) return { ...this.plans.pro, hours: Infinity };
    const skus = new Set([...(this.ents.get(guildId)?.values() ?? [])].filter((e) => this.active(e, now)).map((e) => e.skuId));
    if (this.skuPro && skus.has(this.skuPro)) return this.plans.pro;
    if (this.skuPlus && skus.has(this.skuPlus)) return this.plans.plus;
    return this.plans.free;
  }

  // ------------------------------------------------------------------ usage
  /** Count speech that was sent for translation (ms of audio). */
  addUsage(guildId: string, ms: number): void {
    if (!(ms > 0)) return;
    const k = `${guildId}|${month()}`;
    this.buffered.set(k, (this.buffered.get(k) ?? 0) + ms);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 15_000);
      this.flushTimer.unref?.();
    }
  }

  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const [k, ms] of this.buffered) {
      const [g, mo] = k.split('|');
      const key = `usage:${g}:${mo}`;
      this.store.setKv(key, String(Number(this.store.getKv(key) ?? 0) + Math.round(ms)));
    }
    this.buffered.clear();
  }

  /** Seconds of speech used this month. */
  usedSeconds(guildId: string, now = new Date()): number {
    const mo = month(now);
    const saved = Number(this.store.getKv(`usage:${guildId}:${mo}`) ?? 0);
    return (saved + (this.buffered.get(`${guildId}|${mo}`) ?? 0)) / 1000;
  }

  /** Seconds left this month (Infinity when billing is off). */
  remainingSeconds(guildId: string, now = new Date()): number {
    const p = this.planOf(guildId, now.getTime());
    if (!Number.isFinite(p.hours)) return Infinity;
    return Math.max(0, p.hours * 3600 - this.usedSeconds(guildId, now));
  }

  /** When this month's allowance resets (start of next UTC month). */
  resetsAt(now = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  }
}

export function formatHours(sec: number): string {
  if (!Number.isFinite(sec)) return 'unlimited';
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
