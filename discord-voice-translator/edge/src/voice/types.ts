/** Interfaces that decouple session logic from discord.js (for testability). */

import type { EventEmitter } from 'node:events';

import type { PullResult } from '../audio/PlayoutScheduler.js';

export interface PullSource {
  pull(): PullResult;
  /** 'available' fires when more audio may be pullable */
  once(event: 'available', cb: () => void): unknown;
  off(event: 'available', cb: () => void): unknown;
}

/**
 * A voice channel connection.
 * Events:
 *   'speaking' (userId: string, speaking: boolean)
 *   'packet'   (userId: string, opus: Buffer)
 *   'idle'     ()                      playback of the current source finished
 *   'state'    (status: string)        connection state changes
 *   'dave'     (info: Record<string, unknown>)
 */
export interface VoiceLinkLike extends EventEmitter {
  readonly channelId: string;
  subscribe(userId: string): void;
  unsubscribe(userId: string): void;
  play(source: PullSource): void;
  isPlaying(): boolean;
  stopPlayback(): void;
  destroy(): void;
}

export interface MemberInfo {
  name: string;
  bot: boolean;
}
