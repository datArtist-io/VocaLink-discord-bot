/**
 * Mirror voice channels: one listen-only voice channel per target language,
 * each served by a SEPARATE bot application (MIRROR_BOT_TOKENS), because a
 * bot can hold only one voice connection per guild.
 *
 * Policy note: every mirror bot must be its own, clearly named and disclosed
 * application that the server admin invites. Never use user accounts
 * ("self-bots") - that violates Discord's Terms.
 *
 * Trade-off: people in a mirror channel hear the translated dubs but not the
 * original speakers, and they are not translated themselves (mirror bots are
 * deafened). Captions and the web companion don't split the group.
 */

import { ChannelType, Client, GatewayIntentBits, type Guild, type VoiceBasedChannel } from 'discord.js';

import { languageName } from '../languages.js';
import type { Logger } from '../util/log.js';
import { DiscordVoiceLink } from './DiscordVoiceLink.js';
import type { GuildSession } from './GuildSession.js';

interface MirrorBot {
  index: number;
  client: Client;
  busy: Set<string>; // guild ids this bot is serving
}

export class MirrorManager {
  private bots: MirrorBot[] = [];
  private created = new Map<string, string[]>(); // guildId -> channel ids we created

  constructor(private readonly tokens: string[], private readonly log: Logger, private readonly decryptionFailureTolerance = 36) {}

  get size(): number {
    return this.bots.length;
  }

  async start(): Promise<void> {
    let i = 0;
    for (const token of this.tokens) {
      const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
      try {
        await client.login(token);
        this.bots.push({ index: i++, client, busy: new Set() });
        this.log.info('mirror bot ready', { tag: client.user?.tag });
      } catch (e) {
        this.log.error('mirror bot login failed', { err: e });
      }
    }
  }

  /** Attach up to N mirror channels to a session; returns the languages actually mirrored. */
  async attach(session: GuildSession, guild: Guild, source: VoiceBasedChannel, langs: string[]): Promise<{ lang: string; channelId: string }[]> {
    const out: { lang: string; channelId: string }[] = [];
    const free = this.bots.filter((b) => !b.busy.has(guild.id));
    for (const [i, lang] of langs.entries()) {
      const bot = free[i];
      if (!bot) {
        this.log.warn('not enough mirror bots for all languages', { wanted: langs.length, have: free.length });
        break;
      }
      const mirrorGuild = await bot.client.guilds.fetch(guild.id).catch(() => null);
      if (!mirrorGuild) {
        this.log.warn('mirror bot is not in this guild - invite it first', { bot: bot.client.user?.tag, guild: guild.id });
        continue;
      }
      const name = `🌐 ${languageName(lang)} · ${source.name}`.slice(0, 100);
      let ch = guild.channels.cache.find((c) => c.type === ChannelType.GuildVoice && c.name === name) as VoiceBasedChannel | undefined;
      if (!ch) {
        ch = (await guild.channels.create({ name, type: ChannelType.GuildVoice, parent: source.parentId ?? undefined, reason: 'Live translation mirror channel' })) as VoiceBasedChannel;
        this.created.set(guild.id, [...(this.created.get(guild.id) ?? []), ch.id]);
      }
      const mirrorChannel = (await bot.client.channels.fetch(ch.id)) as VoiceBasedChannel;
      const link = new DiscordVoiceLink(mirrorChannel, { selfDeaf: true, group: `mirror-${bot.index}`, log: this.log.child(`mirror-${lang}`), decryptionFailureTolerance: this.decryptionFailureTolerance });
      await link.connect();
      bot.busy.add(guild.id);
      const origDestroy = link.destroy.bind(link);
      link.destroy = () => {
        bot.busy.delete(guild.id);
        origDestroy();
      };
      session.attachMirror(lang, link);
      out.push({ lang, channelId: ch.id });
    }
    return out;
  }

  /** Delete mirror channels we created once they are empty. */
  async cleanup(guild: Guild): Promise<void> {
    for (const id of this.created.get(guild.id) ?? []) {
      const ch = guild.channels.cache.get(id) as VoiceBasedChannel | undefined;
      if (ch && ch.members.filter((m) => !m.user.bot).size === 0) await ch.delete('Translation session ended').catch(() => {});
    }
    this.created.delete(guild.id);
  }

  async stop(): Promise<void> {
    for (const b of this.bots) await b.client.destroy();
  }
}
