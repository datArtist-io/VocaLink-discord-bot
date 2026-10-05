/**
 * @discordjs/voice adapter (DAVE end-to-end encryption on by default).
 *
 * - joins un-deafened (a self-deafened bot receives no audio);
 * - one receive stream per user (Discord sends separate SSRCs per speaker);
 * - accepts both receive formats: Buffer (0.19.x) and AudioPacket objects
 *   with RTP sequence numbers (newer @discordjs/voice main branch);
 * - recovers from disconnects (Signalling/Connecting within 5 s, otherwise rejoin);
 * - tracks DAVE health: receive-stream errors and packet-gap rate; when they
 *   spike it rejoins, which forces a fresh MLS group (works around the open
 *   key-transition packet-loss issue, discord.js #11441).
 */

import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';

import type { Logger } from '../util/log.js';
import { BYTES_20MS_48K_STEREO } from '../audio/pcm.js';
import type { PullSource, VoiceLinkLike } from './types.js';

export interface DiscordVoiceLinkOptions {
  selfDeaf?: boolean; // mirror bots only play
  decryptionFailureTolerance?: number;
  group?: string;     // separate connection group (mirror bots)
  log: Logger;
}

class PullReadable extends Readable {
  private waiting = false;
  constructor(private readonly src: PullSource, private readonly onAvailable: (cb: () => void) => () => void) {
    super({ highWaterMark: BYTES_20MS_48K_STEREO * 2 });
  }
  private unsub: (() => void) | null = null;

  override _read(): void {
    for (;;) {
      const r = this.src.pull();
      if ('frame' in r) {
        if (!this.push(r.frame)) return;
        continue;
      }
      if ('wait' in r) {
        if (!this.waiting) {
          this.waiting = true;
          this.unsub = this.onAvailable(() => {
            this.waiting = false;
            this.unsub?.();
            this.unsub = null;
            this._read();
          });
        }
        return;
      }
      this.push(null); // end or idle
      return;
    }
  }

  override _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
    this.unsub?.();
    cb(err);
  }
}

export class DiscordVoiceLink extends EventEmitter implements VoiceLinkLike {
  readonly channelId: string;
  private conn: VoiceConnection | null = null;
  private player: AudioPlayer;
  private subs = new Map<string, Readable>();
  private destroyed = false;
  private rejoining = false;
  private lastPacketAt = new Map<string, number>();
  private health = { streamErrors: 0, gaps: 0, packets: 0, rejoins: 0, windowStart: Date.now() };
  private healthTimer: NodeJS.Timeout;

  constructor(private readonly channel: VoiceBasedChannel, private readonly o: DiscordVoiceLinkOptions) {
    super();
    this.channelId = channel.id;
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 250 },
    });
    this.player.on(AudioPlayerStatus.Idle, () => this.emit('idle'));
    this.player.on('error', (e) => this.o.log.warn('audio player error', { err: e.message }));
    this.healthTimer = setInterval(() => this.checkHealth(), 10_000);
    this.healthTimer.unref();
  }

  async connect(): Promise<void> {
    const conn = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.channel.guild.id,
      adapterCreator: this.channel.guild.voiceAdapterCreator,
      selfDeaf: this.o.selfDeaf ?? false,
      selfMute: false,
      group: this.o.group,
      daveEncryption: true,
      decryptionFailureTolerance: this.o.decryptionFailureTolerance ?? 36,
    });
    this.conn = conn;
    conn.subscribe(this.player);
    conn.on('stateChange', (_old, s) => this.emit('state', s.status));
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (!this.destroyed) void this.rejoin('disconnected');
      }
    });
    conn.on('error', (e) => this.o.log.warn('voice connection error', { err: e.message }));
    if (!this.o.selfDeaf) {
      const speaking = conn.receiver.speaking;
      speaking.on('start', (userId: string) => this.emit('speaking', userId, true));
      speaking.on('end', (userId: string) => this.emit('speaking', userId, false));
    }
    await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
  }

  private async rejoin(reason: string): Promise<void> {
    if (this.rejoining || this.destroyed) return;
    this.rejoining = true;
    this.health.rejoins++;
    this.o.log.warn('rejoining voice channel', { reason, channel: this.channelId });
    this.emit('dave', { event: 'rejoin', reason });
    const users = [...this.subs.keys()];
    for (const u of users) this.unsubscribe(u);
    try {
      this.conn?.destroy();
    } catch {
      /* already destroyed */
    }
    for (let attempt = 0; attempt < 5 && !this.destroyed; attempt++) {
      try {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        await this.connect();
        for (const u of users) this.subscribe(u);
        break;
      } catch (e) {
        this.o.log.warn('rejoin attempt failed', { attempt, err: (e as Error).message });
      }
    }
    this.rejoining = false;
  }

  subscribe(userId: string): void {
    if (!this.conn || this.subs.has(userId) || this.o.selfDeaf) return;
    const stream = this.conn.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    this.subs.set(userId, stream);
    let lastSeq: number | null = null;
    stream.on('data', (chunk: Buffer | { payload: Buffer; sequence: number }) => {
      let payload: Buffer;
      if (Buffer.isBuffer(chunk)) {
        payload = chunk;
      } else {
        payload = chunk.payload;
        if (lastSeq !== null) {
          const gap = (chunk.sequence - lastSeq - 1 + 65536) % 65536;
          if (gap > 0 && gap < 50) this.health.gaps += gap;
        }
        lastSeq = chunk.sequence;
      }
      this.health.packets++;
      this.lastPacketAt.set(userId, Date.now());
      this.emit('packet', userId, payload);
    });
    stream.on('error', (e: Error) => {
      this.health.streamErrors++;
      this.o.log.debug('receive stream error', { userId, err: e.message });
      this.subs.delete(userId);
      // resubscribe: a single decrypt failure must not silence a speaker for the rest of the call
      setTimeout(() => !this.destroyed && this.subscribe(userId), 250);
    });
    stream.on('close', () => this.subs.delete(userId));
  }

  unsubscribe(userId: string): void {
    const s = this.subs.get(userId);
    if (s) {
      this.subs.delete(userId);
      s.destroy();
    }
  }

  play(source: PullSource): void {
    const readable = new PullReadable(source, (cb) => {
      source.once('available', cb);
      return () => source.off('available', cb);
    });
    const resource = createAudioResource(readable, { inputType: StreamType.Raw });
    this.player.play(resource);
  }

  isPlaying(): boolean {
    return this.player.state.status !== AudioPlayerStatus.Idle;
  }

  stopPlayback(): void {
    this.player.stop(true);
  }

  private checkHealth(): void {
    const h = this.health;
    const secs = (Date.now() - h.windowStart) / 1000;
    const snapshot = { ...h, window_s: Math.round(secs) };
    this.emit('dave', { event: 'health', ...snapshot });
    const lossRate = h.packets ? h.gaps / (h.packets + h.gaps) : 0;
    if (h.streamErrors >= 20 || (h.packets > 500 && lossRate > 0.2)) {
      void this.rejoin(`receive health degraded (errors=${h.streamErrors}, loss=${(lossRate * 100).toFixed(0)}%)`);
    }
    this.health = { streamErrors: 0, gaps: 0, packets: 0, rejoins: h.rejoins, windowStart: Date.now() };
  }

  destroy(): void {
    this.destroyed = true;
    clearInterval(this.healthTimer);
    for (const u of [...this.subs.keys()]) this.unsubscribe(u);
    this.player.stop(true);
    try {
      this.conn?.destroy();
    } catch {
      /* noop */
    }
  }
}
