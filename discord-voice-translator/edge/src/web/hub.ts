/**
 * Fan-out of captions and translated audio to companion web listeners.
 * Each listener picks a language; the guild session adds that language to the
 * worker's audio targets while at least one listener wants it.
 */

import { decimate2 } from '../audio/pcm.js';

export interface SocketLike {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount?: number;
}

export interface Listener {
  id: number;
  guildId: string;
  userId: string;
  lang: string;
  sock: SocketLike;
  /** test mode: also hear your own speech translated */
  hearSelf?: boolean;
}

export interface HubSession {
  setWebLangs(langs: string[]): void;
  describe(): Record<string, unknown>;
}

let nextId = 1;

export class WebHub {
  private listeners = new Map<string, Set<Listener>>(); // guildId -> listeners
  private sessions = new Map<string, HubSession>();
  /** dub id -> the user whose speech it translates (a listener never gets their own) */
  private dubOwner = new Map<number, string>();
  stats = { audioFramesSent: 0, dropped: 0 };

  registerSession(guildId: string, s: HubSession): void {
    this.sessions.set(guildId, s);
    s.setWebLangs(this.langs(guildId));
  }

  unregisterSession(guildId: string): void {
    this.sessions.delete(guildId);
    for (const l of this.listeners.get(guildId) ?? []) {
      this.sendJson(l, { type: 'status', live: false, message: 'Translation session ended' });
    }
  }

  hasSession(guildId: string): boolean {
    return this.sessions.has(guildId);
  }

  attach(guildId: string, userId: string, lang: string, sock: SocketLike): Listener {
    const l: Listener = { id: nextId++, guildId, userId, lang, sock };
    let set = this.listeners.get(guildId);
    if (!set) this.listeners.set(guildId, (set = new Set()));
    set.add(l);
    this.sync(guildId);
    const s = this.sessions.get(guildId);
    this.sendJson(l, { type: 'status', live: Boolean(s), lang, session: s?.describe() ?? null });
    return l;
  }

  setLang(l: Listener, lang: string): void {
    l.lang = lang;
    this.sync(l.guildId);
    this.sendJson(l, { type: 'status', live: this.sessions.has(l.guildId), lang });
  }

  /** The user picked a language in Discord: switch any player they have open. */
  setUserLang(guildId: string, userId: string, lang: string): void {
    for (const l of this.listeners.get(guildId) ?? []) if (l.userId === userId) this.setLang(l, lang);
  }

  /** Volume set from Discord (10-200 %): apply to any player the user has open. */
  setUserVolume(guildId: string, userId: string, percent: number): void {
    for (const l of this.listeners.get(guildId) ?? []) if (l.userId === userId) this.sendJson(l, { type: 'volume', value: percent });
  }

  setHearSelf(l: Listener, on: boolean): void {
    l.hearSelf = on;
  }

  /** a listener gets this person's translations unless it is themselves (and not in test mode) */
  private wants(l: Listener, speaker: string | undefined): boolean {
    return l.userId !== speaker || Boolean(l.hearSelf);
  }

  detach(l: Listener): void {
    this.listeners.get(l.guildId)?.delete(l);
    this.sync(l.guildId);
  }

  langs(guildId: string): string[] {
    return [...new Set([...(this.listeners.get(guildId) ?? [])].map((l) => l.lang))].sort();
  }

  count(guildId?: string): number {
    if (guildId) return this.listeners.get(guildId)?.size ?? 0;
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }

  private sync(guildId: string): void {
    this.sessions.get(guildId)?.setWebLangs(this.langs(guildId));
  }

  // ------------------------------------------------------------------ publishing
  caption(guildId: string, ev: { name: string; userId: string; srcLang: string; original: string; translations: Record<string, string | null>; final: boolean; uttKey: string }): void {
    for (const l of this.listeners.get(guildId) ?? []) {
      const text = l.lang === ev.srcLang ? ev.original : (ev.translations[l.lang] ?? null);
      this.sendJson(l, { type: 'caption', key: ev.uttKey, name: ev.name, user_id: ev.userId, you: l.userId === ev.userId && !l.hearSelf, src: ev.srcLang, original: ev.original, text, final: ev.final });
    }
  }

  dubStart(guildId: string, lang: string, meta: Record<string, unknown>): void {
    const owner = String(meta.user_id ?? '');
    this.dubOwner.set(Number(meta.dub_id), owner);
    if (this.dubOwner.size > 500) this.dubOwner.delete(this.dubOwner.keys().next().value!);
    for (const l of this.listeners.get(guildId) ?? []) if (l.lang === lang && this.wants(l, owner)) this.sendJson(l, { type: 'dub_start', ...meta, sample_rate: 24000 });
  }

  /** Someone started/stopped talking: drives "speaking" rings, and lowers your translations while YOU talk. */
  speaking(guildId: string, userId: string, on: boolean): void {
    for (const l of this.listeners.get(guildId) ?? []) this.sendJson(l, { type: 'speaking', user_id: userId, you: l.userId === userId && !l.hearSelf, on });
  }

  dubAudio(guildId: string, lang: string, dubId: number, seq: number, pcm48: Buffer): void {
    let pkt: Buffer | null = null;
    const owner = this.dubOwner.get(dubId);
    for (const l of this.listeners.get(guildId) ?? []) {
      if (l.lang !== lang || !this.wants(l, owner)) continue;
      if ((l.sock.bufferedAmount ?? 0) > 512 * 1024) {
        this.stats.dropped++;
        continue;
      }
      if (!pkt) {
        const h = Buffer.allocUnsafe(8);
        h.writeUInt32BE(dubId >>> 0, 0);
        h.writeUInt32BE(seq >>> 0, 4);
        pkt = Buffer.concat([h, decimate2(pcm48)]);
      }
      l.sock.send(pkt);
      this.stats.audioFramesSent++;
    }
  }

  dubEnd(guildId: string, lang: string, dubId: number): void {
    const owner = this.dubOwner.get(dubId);
    for (const l of this.listeners.get(guildId) ?? []) if (l.lang === lang && this.wants(l, owner)) this.sendJson(l, { type: 'dub_end', dub_id: dubId });
    this.dubOwner.delete(dubId);
  }

  notice(guildId: string, message: string): void {
    for (const l of this.listeners.get(guildId) ?? []) this.sendJson(l, { type: 'notice', message });
  }

  private sendJson(l: Listener, obj: Record<string, unknown>): void {
    try {
      l.sock.send(JSON.stringify(obj));
    } catch {
      /* socket closing */
    }
  }
}
