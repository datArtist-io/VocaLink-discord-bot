/**
 * Discord front-end: slash commands, consent flows, session lifecycle.
 */

import { randomInt } from 'node:crypto';

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  Events,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Interaction,
  type Message,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
  type VoiceState,
} from 'discord.js';

import { createDecoder } from '../audio/opus.js';
import type { EdgeConfig } from '../config.js';
import { autocompleteLanguages, languageName, normalizeLang, parseLangList } from '../languages.js';
import type { Metrics } from '../metrics/Metrics.js';
import type { GuildSettings, Store } from '../store/Store.js';
import type { Logger } from '../util/log.js';
import { DiscordVoiceLink } from '../voice/DiscordVoiceLink.js';
import { GuildSession } from '../voice/GuildSession.js';
import type { MirrorManager } from '../voice/Mirror.js';
import type { TokenSigner } from '../web/auth.js';
import type { WebHub } from '../web/hub.js';
import type { WorkerPool } from '../worker/WorkerPool.js';
import { CaptionSink, escapeMd, type CaptionTarget } from './captions.js';

const EPH = MessageFlags.Ephemeral;

interface Active {
  session: GuildSession;
  link: DiscordVoiceLink;
  captionsChannel: GuildTextBasedChannel;
  noticeChannel: GuildTextBasedChannel;
  leaveTimer: NodeJS.Timeout | null;
}

export interface BotDeps {
  cfg: EdgeConfig;
  client: Client;
  pool: WorkerPool;
  store: Store;
  metrics: Metrics;
  hub: WebHub;
  signer: TokenSigner;
  mirrors: MirrorManager | null;
  log: Logger;
}

const PHRASE_WORDS = ['river', 'orange', 'piano', 'garden', 'silver', 'thunder', 'mango', 'harbor', 'lantern', 'violet', 'pepper', 'meadow', 'comet', 'saffron', 'canyon', 'falcon'];

export class TranslatorBot {
  readonly sessions = new Map<string, Active>();
  private whisperRate = new Map<string, number>();

  constructor(private readonly d: BotDeps) {}

  attach(): void {
    const c = this.d.client;
    c.on(Events.InteractionCreate, (i) => void this.onInteraction(i));
    c.on(Events.VoiceStateUpdate, (o, n) => this.onVoiceState(o, n));
    c.on(Events.GuildDelete, (g) => void this.stop(g.id, 'removed from server'));
  }

  // ------------------------------------------------------------------ routing
  private async onInteraction(i: Interaction): Promise<void> {
    try {
      if (i.isAutocomplete()) return await this.autocomplete(i);
      if (i.isMessageContextMenuCommand()) return await this.correctMenu(i);
      if (i.isModalSubmit() && i.customId.startsWith('correct:')) return await this.correctSubmit(i);
      if (!i.isChatInputCommand() || !i.inGuild()) return;
      this.d.metrics.inc(`cmd_${i.commandName}`);
      switch (i.commandName) {
        case 'translate': {
          const sub = i.options.getSubcommand();
          if (sub === 'start') return await this.cmdStart(i);
          if (sub === 'stop') return await this.cmdStop(i);
          return await this.cmdStatus(i);
        }
        case 'mylang':
          return await this.cmdMyLang(i);
        case 'settings':
          return await this.cmdSettings(i);
        case 'optout':
          return await this.cmdOpt(i, true);
        case 'optin':
          return await this.cmdOpt(i, false);
        case 'voice':
          return await this.cmdVoice(i);
        case 'glossary':
          return await this.cmdGlossary(i);
        case 'correct':
          return await this.cmdCorrect(i);
        case 'whisper':
          return await this.cmdWhisper(i);
        case 'summary':
          return await this.cmdSummary(i);
        case 'listen':
          return await this.cmdListen(i);
        case 'languages':
          return await this.cmdLanguages(i);
        case 'dashboard':
          return await this.cmdDashboard(i);
      }
    } catch (e) {
      this.d.log.error('interaction failed', { err: e });
      if (i.isRepliable()) {
        const content = `⚠️ ${(e as Error).message ?? 'Something went wrong.'}`;
        if (i.deferred || i.replied) await i.followUp({ content, flags: EPH }).catch(() => {});
        else await i.reply({ content, flags: EPH }).catch(() => {});
      }
    }
  }

  private async autocomplete(i: AutocompleteInteraction): Promise<void> {
    const f = i.options.getFocused(true);
    const extra = f.name === 'speak' ? [{ name: 'Auto-detect (recommended)', value: 'auto' }] : f.name === 'dub' ? [{ name: 'Off (captions only)', value: 'off' }] : [];
    await i.respond(autocompleteLanguages(String(f.value), extra));
  }

  private async member(i: ChatInputCommandInteraction | MessageContextMenuCommandInteraction | ModalSubmitInteraction): Promise<GuildMember> {
    const g = i.guild!;
    return g.members.cache.get(i.user.id) ?? (await g.members.fetch(i.user.id));
  }

  // ------------------------------------------------------------------ /translate
  private async cmdStart(i: ChatInputCommandInteraction): Promise<void> {
    const guild = i.guild!;
    if (this.sessions.has(guild.id)) {
      await i.reply({ content: 'Already translating in this server. Use `/translate stop` first.', flags: EPH });
      return;
    }
    const m = await this.member(i);
    const vc = m.voice.channel;
    if (!vc) {
      await i.reply({ content: 'Join a voice channel first, then run `/translate start`.', flags: EPH });
      return;
    }
    const me = guild.members.me!;
    const perms = vc.permissionsFor(me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      await i.reply({ content: `I need **View Channel, Connect and Speak** in ${vc}.`, flags: EPH });
      return;
    }
    const worker = this.d.pool.anyReady();
    if (!worker) {
      await i.reply({ content: '⚠️ The translation worker is not reachable right now. Try again in a moment.', flags: EPH });
      return;
    }
    await i.deferReply();
    const dubOpt = i.options.getString('dub');
    if (dubOpt) {
      const dub = dubOpt === 'off' ? null : normalizeLang(dubOpt);
      if (dubOpt !== 'off' && !dub) throw new Error(`Unknown language "${dubOpt}"`);
      this.d.store.updateSettings(guild.id, { dubLang: dub });
    }
    const settings = this.d.store.getSettings(guild.id);
    const textChannel = ((i.options.getChannel('captions') as GuildTextBasedChannel | null) ?? (i.channel as GuildTextBasedChannel));
    let captionsChannel: GuildTextBasedChannel = textChannel;
    if (settings.captionsInThread && 'threads' in textChannel && textChannel.type === ChannelType.GuildText) {
      try {
        captionsChannel = await textChannel.threads.create({
          name: `🌐 Live translation · ${vc.name}`.slice(0, 100),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
          reason: 'Live translation captions',
        });
      } catch (e) {
        this.d.log.warn('could not create caption thread, using channel', { err: (e as Error).message });
      }
    }

    // cache members already in the channel (their speech is ignored until we know they're not bots)
    const inVoice = [...guild.voiceStates.cache.filter((v: { channelId: string | null }) => v.channelId === vc.id).keys()];
    if (inVoice.length) await guild.members.fetch({ user: inVoice }).catch(() => null);
    const pendingFetch = new Set<string>();
    const link = new DiscordVoiceLink(vc, { log: this.d.log.child(`voice-${guild.id}`), decryptionFailureTolerance: this.d.cfg.daveFailureTolerance });
    try {
      await link.connect();
    } catch (e) {
      link.destroy();
      throw new Error(`Could not join ${vc.name}: ${(e as Error).message}`);
    }
    link.on('dave', (info: Record<string, unknown>) => {
      if (info.event === 'rejoin') this.d.metrics.inc('dave_rejoins');
      if (info.event === 'health') this.d.metrics.gauge(`dave_stream_errors_${guild.id}`, Number(info.streamErrors ?? 0));
    });

    const target: CaptionTarget = {
      send: async (content) => {
        const msg = await captionsChannel.send({ content, allowedMentions: { parse: [] } });
        return { id: msg.id, edit: (c: string) => msg.edit({ content: c, allowedMentions: { parse: [] } }) };
      },
    };
    let session!: GuildSession;
    const captions = new CaptionSink(target, {
      onWritten: (key, id) => session.indexCaption(key, id),
      onError: (e) => this.d.log.warn('caption write failed', { err: (e as Error).message }),
    });
    session = new GuildSession({
      guildId: guild.id,
      voice: link,
      workers: this.d.pool,
      store: this.d.store,
      metrics: this.d.metrics,
      captions,
      hub: this.d.hub,
      resolveMember: (uid) => {
        const mm = guild.members.cache.get(uid);
        if (mm) return { name: mm.displayName, bot: mm.user.bot };
        if (!pendingFetch.has(uid)) {
          pendingFetch.add(uid); // fetch once; the next "speaking" event will resolve
          void guild.members.fetch(uid).catch(() => null).finally(() => pendingFetch.delete(uid));
        }
        return null;
      },
      decoderFactory: createDecoder,
      log: this.d.log.child(`session-${guild.id}`),
      botUserId: this.d.client.user!.id,
      dm: async (uid, content) => {
        await this.d.client.users.send(uid, { content, allowedMentions: { parse: [] } });
      },
      listMembers: () => [...vc.members.filter((x) => !x.user.bot).keys()],
      playout: this.d.cfg.playout,
    });
    session.start();
    const active: Active = { session, link, captionsChannel, noticeChannel: textChannel, leaveTimer: null };
    this.sessions.set(guild.id, active);

    let mirrorNote = '';
    if (settings.mirrors && this.d.mirrors && settings.mirrorLangs.length) {
      try {
        const got = await this.d.mirrors.attach(session, guild, vc, settings.mirrorLangs);
        mirrorNote = got.length ? `\n🎧 Mirror channels: ${got.map((g) => `<#${g.channelId}> (${languageName(g.lang)})`).join(', ')} — listen-only.` : '';
      } catch (e) {
        mirrorNote = `\n⚠️ Mirror channels unavailable: ${(e as Error).message}`;
      }
    }

    const privacy = this.d.cfg.privacyUrl ? ` Privacy: <${this.d.cfg.privacyUrl}>` : '';
    const notice =
      `🔴 **Live translation is ON in ${vc}.**\n` +
      `I process what people say in this channel to show live captions and translations` +
      `${settings.dubLang ? ` and speak them in ${languageName(settings.dubLang)}` : ''}. ` +
      `Audio is **not recorded or stored**.${settings.summaries ? ' A text transcript is kept in memory only until the call summary is posted.' : ''} ` +
      `Don't want your voice processed? Use \`/optout\` (instant).${privacy}\n` +
      `Captions: ${captionsChannel}. Personal translated audio: \`/listen\`.` + mirrorNote;
    await i.editReply({ content: notice, allowedMentions: { parse: [] } });
    if (captionsChannel.id !== textChannel.id) {
      await captionsChannel.send({ content: `Captions for ${vc} · languages: ${settings.textTargets.map((l) => l.toUpperCase()).join(', ')}`, allowedMentions: { parse: [] } });
    }
    this.d.log.info('session started', { guild: guild.id, channel: vc.id });
  }

  private async cmdStop(i: ChatInputCommandInteraction): Promise<void> {
    if (!this.sessions.has(i.guildId!)) {
      await i.reply({ content: 'Not translating in this server.', flags: EPH });
      return;
    }
    await i.deferReply();
    await this.stop(i.guildId!, `stopped by ${i.user.username}`);
    await i.editReply('⏹️ Live translation stopped. Captions and summary are in the caption thread.');
  }

  async stop(guildId: string, reason: string): Promise<void> {
    const a = this.sessions.get(guildId);
    if (!a) return;
    this.sessions.delete(guildId);
    if (a.leaveTimer) clearTimeout(a.leaveTimer);
    const summary = await a.session.stop({ summary: true });
    if (summary && (summary as { ok?: boolean }).ok) await this.postSummary(a.captionsChannel, summary);
    await a.captionsChannel.send({ content: `⏹️ Translation ended (${reason}).`, allowedMentions: { parse: [] } }).catch(() => {});
    const guild = this.d.client.guilds.cache.get(guildId);
    if (guild && this.d.mirrors) await this.d.mirrors.cleanup(guild);
    this.d.log.info('session stopped', { guild: guildId, reason });
  }

  private async postSummary(ch: GuildTextBasedChannel, s: Record<string, unknown>): Promise<void> {
    const byLang = (s.by_lang ?? {}) as Record<string, { summary?: string; decisions?: string[]; action_items?: { owner: string; item: string; due?: string | null }[]; error?: string }>;
    const parts: string[] = [`📝 **Call summary**${s.method === 'extractive' ? ' *(extractive — no LLM configured)*' : ''}`];
    for (const [lang, d] of Object.entries(byLang)) {
      if (d.error) continue;
      const lines = [`**${languageName(lang)}**`, d.summary ?? ''];
      if (d.decisions?.length) lines.push('Decisions:', ...d.decisions.map((x) => `• ${x}`));
      if (d.action_items?.length) lines.push('Action items:', ...d.action_items.map((a) => `☐ ${a.item}${a.owner && a.owner !== 'unassigned' ? ` — ${a.owner}` : ''}${a.due ? ` (due ${a.due})` : ''}`));
      parts.push(lines.join('\n'));
    }
    let buf = '';
    for (const p of parts) {
      if (buf.length + p.length + 2 > 1900) {
        await ch.send({ content: buf, allowedMentions: { parse: [] } });
        buf = '';
      }
      buf += (buf ? '\n\n' : '') + p.slice(0, 1900);
    }
    if (buf) await ch.send({ content: buf, allowedMentions: { parse: [] } });
  }

  private async cmdStatus(i: ChatInputCommandInteraction): Promise<void> {
    const a = this.sessions.get(i.guildId!);
    const info = this.d.pool.info();
    const m = this.d.metrics;
    const fmt = (k: string) => {
      const p50 = m.pct(k, 0.5);
      const p90 = m.pct(k, 0.9);
      return p50 === null ? '—' : `${Math.round(p50)}/${Math.round(p90 ?? p50)}`;
    };
    const workers = this.d.pool.clients.map((c) => `${c.status === 'ready' ? '🟢' : '🔴'} ${c.info?.hardware?.tier ?? '?'}${c.info?.hardware?.gpu_name ? ` (${c.info.hardware.gpu_name})` : ''}`).join(', ');
    const lines = [
      a ? `🟢 Translating in <#${a.link.channelId}>` : '⚪ Not translating in this server',
      `Workers: ${workers} · mode **${info?.policy?.mode ?? '?'}**${info?.policy?.commercial ? ' · commercial' : ''}`,
      `Latency p50/p90 ms — endpoint ${fmt('vad_endpoint')} · STT ${fmt('stt')} · MT ${fmt('mt')} · caption ${fmt('end_to_caption')} · first audio ${fmt('end_to_first_audio_edge')}`,
    ];
    if (a) {
      const d = a.session.describe() as { speakers: { name: string }[]; dub_queue: number; web_langs: string[]; mirrors: string[] };
      const s = a.session.settings;
      lines.push(`Captions: ${s.textTargets.map((x) => x.toUpperCase()).join(', ')} · Dub: ${s.dubLang ? s.dubLang.toUpperCase() : 'off'} (${s.voiceMode}) · Mode: ${s.mode}`);
      lines.push(`Speakers: ${d.speakers.map((x) => x.name).join(', ') || '—'} · Web listeners: ${this.d.hub.count(i.guildId!)} ${d.web_langs.length ? `(${d.web_langs.join(', ')})` : ''} · Mirrors: ${d.mirrors.join(', ') || '—'} · Dub queue: ${d.dub_queue}`);
    }
    if (info) {
      const c = info.registry_summary.counts;
      lines.push(`Language tiers — cloned voice: ${c.tier1 ?? 0}, standard voice: ${c.tier2 ?? 0}, captions only: ${c.tier3 ?? 0} (\`/languages\`)`);
      const skipped = info.providers.filter((p) => p.status === 'skipped').map((p) => p.name);
      if (skipped.length) lines.push(`-# Not loaded: ${skipped.join(', ')}`);
    }
    await i.reply({ content: lines.join('\n'), flags: EPH });
  }

  // ------------------------------------------------------------------ /mylang, /optout
  private async cmdMyLang(i: ChatInputCommandInteraction): Promise<void> {
    const speak = i.options.getString('speak');
    const hear = i.options.getString('hear');
    const patch: { speakLang?: string | null; hearLang?: string | null } = {};
    if (speak) {
      const s = normalizeLang(speak);
      if (!s) throw new Error(`Unknown language "${speak}"`);
      patch.speakLang = s === 'auto' ? null : s;
    }
    if (hear) {
      const h = normalizeLang(hear);
      if (!h || h === 'auto') throw new Error(`Unknown language "${hear}"`);
      patch.hearLang = h;
    }
    const u = this.d.store.updateUser(i.user.id, patch);
    const a = this.sessions.get(i.guildId!);
    if (a && 'speakLang' in patch) a.session.setSpeakLang(i.user.id, u.speakLang);
    a?.session.pushConfig();
    const info = this.d.pool.info();
    const warn = u.speakLang && info?.languages?.[u.speakLang]?.stt === 'none' ? `\n⚠️ ${languageName(u.speakLang)} speech can't be recognised by the installed models.` : '';
    await i.reply({
      content: `You speak: **${u.speakLang ? languageName(u.speakLang) : 'auto-detect'}** · You read/hear: **${u.hearLang ? languageName(u.hearLang) : 'server default'}**${warn}`,
      flags: EPH,
    });
  }

  private async cmdOpt(i: ChatInputCommandInteraction, out: boolean): Promise<void> {
    this.d.store.updateUser(i.user.id, { optout: out });
    if (out) for (const a of this.sessions.values()) a.session.dropUser(i.user.id); // every server, immediately
    await i.reply({
      content: out
        ? '🔕 Opted out. Your voice is now ignored at the edge — it is never decoded or sent for translation, in any server. `/optin` to undo.'
        : '🔔 Opted in. Your voice will be translated when a session is running.',
      flags: EPH,
    });
  }

  // ------------------------------------------------------------------ /settings
  private async cmdSettings(i: ChatInputCommandInteraction): Promise<void> {
    const gid = i.guildId!;
    if (i.options.getSubcommand() === 'view') {
      await i.reply({ content: this.renderSettings(this.d.store.getSettings(gid)), flags: EPH });
      return;
    }
    const patch: Partial<GuildSettings> = {};
    const captions = i.options.getString('captions');
    if (captions !== null) {
      const l = parseLangList(captions);
      if (!l.length) throw new Error('No valid caption languages given');
      patch.textTargets = l;
    }
    const dub = i.options.getString('dub');
    if (dub !== null) {
      const d = dub === 'off' ? null : normalizeLang(dub);
      if (dub !== 'off' && (!d || d === 'auto')) throw new Error(`Unknown language "${dub}"`);
      patch.dubLang = d;
    }
    const mode = i.options.getString('mode');
    if (mode) patch.mode = mode as GuildSettings['mode'];
    const voice = i.options.getString('voice');
    if (voice) patch.voiceMode = voice as GuildSettings['voiceMode'];
    const mirrors = i.options.getBoolean('mirrors');
    if (mirrors !== null) patch.mirrors = mirrors;
    const ml = i.options.getString('mirror_langs');
    if (ml !== null) patch.mirrorLangs = parseLangList(ml);
    const sums = i.options.getBoolean('summaries');
    if (sums !== null) patch.summaries = sums;
    const exp = i.options.getString('expected');
    if (exp !== null) patch.expectedLangs = exp.trim().toLowerCase() === 'auto' ? null : parseLangList(exp);
    const th = i.options.getBoolean('threads');
    if (th !== null) patch.captionsInThread = th;
    const s = this.d.store.updateSettings(gid, patch);
    this.sessions.get(gid)?.session.reloadSettings();
    const warnings: string[] = [];
    const info = this.d.pool.info();
    if ((s.mode === 'natural' || s.mode === 'cultural') && info && !info.providers.some((p) => p.stage === 'llm' && p.status === 'loaded')) {
      warnings.push(`⚠️ ${s.mode} mode needs an LLM (set LLM_BASE_URL/LLM_MODEL or an API key). Literal translation is used until then.`);
    }
    if (s.voiceMode === 'clone' && info && !info.voice_cloning.enabled) warnings.push(`⚠️ Voice cloning is unavailable: ${info.voice_cloning.reason}`);
    if (s.mirrors && !this.d.mirrors?.size) warnings.push('⚠️ Mirror channels need extra bot tokens (MIRROR_BOT_TOKENS).');
    if (s.dubLang && info?.languages?.[s.dubLang] && info.languages[s.dubLang]!.tier < 2) warnings.push(`⚠️ ${languageName(s.dubLang)} has no installed voice — captions only.`);
    await i.reply({ content: this.renderSettings(s) + (warnings.length ? '\n' + warnings.join('\n') : ''), flags: EPH });
  }

  private renderSettings(s: GuildSettings): string {
    return [
      '**Translation settings**',
      `Captions: ${s.textTargets.map((l) => `${languageName(l)} (${l})`).join(', ')}`,
      `Voice dubbing: ${s.dubLang ? `${languageName(s.dubLang)} · ${s.voiceMode === 'clone' ? 'cloned voices of consenting speakers' : 'house voice'}` : 'off'}`,
      `Mode: ${s.mode} · Summaries: ${s.summaries ? 'on' : 'off'} · Caption thread: ${s.captionsInThread ? 'on' : 'off'}`,
      `Mirror channels: ${s.mirrors ? s.mirrorLangs.join(', ') || '(no languages set)' : 'off'}`,
      `Expected languages: ${s.expectedLangs ? s.expectedLangs.join(', ') : 'auto (any of ~100)'}`,
    ].join('\n');
  }

  // ------------------------------------------------------------------ /voice (cloning consent)
  private async cmdVoice(i: ChatInputCommandInteraction): Promise<void> {
    const sub = i.options.getSubcommand();
    const worker = this.d.pool.anyReady();
    if (sub === 'delete') {
      let deleted = false;
      if (worker) deleted = Boolean((await worker.request({ type: 'voice_delete', user_id: i.user.id }, 'voice_delete_result')).deleted);
      this.d.store.deleteConsent(i.user.id);
      for (const a of this.sessions.values()) a.session.pushConfig();
      await i.reply({ content: deleted ? '🗑️ Your voice profile was deleted. Dubs of your speech now use the house voice.' : 'You had no voice profile. Any consent record was removed.', flags: EPH });
      return;
    }
    if (sub === 'status') {
      const st = worker ? await worker.request({ type: 'voice_status', user_id: i.user.id }, 'voice_status_result') : null;
      const c = this.d.store.consent(i.user.id);
      await i.reply({
        content: `Voice profile: **${st?.has_profile ? 'yes' : 'no'}**${c ? ` · consent ${c.version} on <t:${Math.floor(c.at / 1000)}:d>` : ''}\nCloning on this bot: ${st?.enabled ? 'available' : `unavailable (${st?.reason ?? 'worker offline'})`}`,
        flags: EPH,
      });
      return;
    }
    // enroll
    const a = this.sessions.get(i.guildId!);
    const m = await this.member(i);
    if (!a || m.voice.channelId !== a.link.channelId) {
      await i.reply({ content: 'Join the voice channel where translation is running, then run `/voice enroll` again.', flags: EPH });
      return;
    }
    if (this.d.store.optedOut(i.user.id)) {
      await i.reply({ content: 'You are opted out. Run `/optin` first if you want a voice profile.', flags: EPH });
      return;
    }
    const st = worker ? await worker.request({ type: 'voice_status', user_id: i.user.id }, 'voice_status_result') : null;
    if (!st?.enabled) {
      await i.reply({ content: `Voice cloning isn't available on this bot: ${st?.reason ?? 'worker offline'}.`, flags: EPH });
      return;
    }
    const consentText =
      '**Create a voice profile (voice cloning) — please read**\n' +
      '• **What:** a synthetic copy of your voice is used to speak *your own* translated words to listeners, only in servers whose admins turned on cloned voices.\n' +
      '• **How:** you will read a one-time phrase aloud now (about 10 s). Only that recording is kept, **encrypted**, to condition the voice model. It is never shared, sold or used for training.\n' +
      '• **Labelled:** dubs in your cloned voice are marked 🗣️ in captions, and the audio carries an inaudible AI watermark.\n' +
      '• **Your control:** `/voice delete` erases it immediately. `/optout` stops all processing of your voice.\n' +
      'Only enroll your **own** voice. Impersonating someone else breaks Discord rules and this bot\'s terms.';
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('consent:yes').setLabel('I consent').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('consent:no').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    await i.reply({ content: consentText, components: [row], flags: EPH });
    const msg = await i.fetchReply();
    const btn = await msg.awaitMessageComponent({ componentType: ComponentType.Button, filter: (b) => b.user.id === i.user.id, time: 120_000 }).catch(() => null);
    if (!btn || btn.customId !== 'consent:yes') {
      await i.editReply({ content: 'Enrollment cancelled. Nothing was recorded.', components: [] });
      if (btn) await btn.deferUpdate().catch(() => {});
      return;
    }
    const code = Array.from({ length: 3 }, () => PHRASE_WORDS[randomInt(PHRASE_WORDS.length)]).join(' ');
    const phrase = `I, ${m.displayName}, agree that this bot may create a synthetic copy of my voice for live translation. My code is ${code}.`;
    this.d.store.recordConsent(i.user.id, this.d.cfg.consentVersion, phrase, 'pending', i.guildId!);
    const go = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('consent:rec').setLabel('Start recording (12 s)').setStyle(ButtonStyle.Primary));
    await btn.update({ content: `When ready, press the button and read this aloud in the voice channel:\n> **${phrase}**`, components: [go] });
    const rec = await msg.awaitMessageComponent({ componentType: ComponentType.Button, filter: (b) => b.user.id === i.user.id, time: 180_000 }).catch(() => null);
    if (!rec) {
      await i.editReply({ content: 'Enrollment timed out. Nothing was recorded.', components: [] });
      return;
    }
    await rec.update({ content: `🎙️ Recording… read the phrase now:\n> **${phrase}**`, components: [] });
    const pcm = await a.session.captureEnrollment(i.user.id, 12_000);
    await i.editReply({ content: '⏳ Verifying the recording…' });
    const u = this.d.store.getUser(i.user.id);
    try {
      const r = await a.session.enroll(i.user.id, phrase, pcm, u.speakLang ?? 'en', this.d.cfg.consentVersion);
      if (r.ok) {
        this.d.store.recordConsent(i.user.id, this.d.cfg.consentVersion, phrase, 'enrolled', i.guildId!);
        a.session.pushConfig();
        await i.editReply({ content: '✅ Voice profile created. When the server uses cloned voices, your translated speech will sound like you (marked 🗣️). `/voice delete` anytime.' });
      } else {
        this.d.store.deleteConsent(i.user.id);
        await i.editReply({ content: `❌ Enrollment failed: ${r.reason}. Nothing was kept. You can try again.` });
      }
    } catch (e) {
      this.d.store.deleteConsent(i.user.id);
      await i.editReply({ content: `❌ Enrollment failed: ${(e as Error).message}` });
    }
  }

  // ------------------------------------------------------------------ /glossary, /correct
  private async cmdGlossary(i: ChatInputCommandInteraction): Promise<void> {
    const gid = i.guildId!;
    const sub = i.options.getSubcommand();
    if (sub === 'add') {
      const from = i.options.getString('from');
      const to = i.options.getString('to');
      const id = this.d.store.addTerm({
        guildId: gid, source: i.options.getString('source', true), target: i.options.getString('target', true),
        srcLang: from ? (normalizeLang(from) ?? '*') : '*', tgtLang: to ? (normalizeLang(to) ?? '*') : '*', kind: 'term', createdBy: i.user.id,
      });
      this.sessions.get(gid)?.session.pushConfig();
      await i.reply({ content: `📘 Glossary term #${id} saved. It also helps speech recognition catch the word.`, flags: EPH });
    } else if (sub === 'remove') {
      const ok = this.d.store.removeTerm(gid, i.options.getInteger('id', true));
      this.sessions.get(gid)?.session.pushConfig();
      await i.reply({ content: ok ? 'Removed.' : 'No such term.', flags: EPH });
    } else {
      const rows = this.d.store.glossary(gid);
      const text = rows.length
        ? rows.map((r) => `#${r.id} ${r.kind === 'fix' ? '✏️' : '📘'} "${r.source}" → "${r.target}" (${r.srcLang}→${r.tgtLang})`).join('\n').slice(0, 1900)
        : 'The glossary is empty. `/glossary add` or correct a caption to teach the bot.';
      await i.reply({ content: text, flags: EPH });
    }
  }

  private async correctMenu(i: MessageContextMenuCommandInteraction): Promise<void> {
    const cap = this.d.store.caption(i.targetId);
    if (!cap) {
      await i.reply({ content: 'That is not a recent caption (captions can be corrected for 24 h).', flags: EPH });
      return;
    }
    const pref = this.d.store.getUser(i.user.id).hearLang;
    const lang = (pref && cap.translations[pref] ? pref : Object.keys(cap.translations).find((k) => cap.translations[k])) ?? 'en';
    const modal = new ModalBuilder()
      .setCustomId(`correct:${i.targetId}`)
      .setTitle('Correct translation')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('lang').setLabel('Language code').setStyle(TextInputStyle.Short).setValue(lang).setMaxLength(5)),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('text').setLabel('Corrected translation').setStyle(TextInputStyle.Paragraph).setValue((cap.translations[lang] ?? '').slice(0, 3900)).setMaxLength(4000),
        ),
      );
    await i.showModal(modal);
  }

  private async correctSubmit(i: ModalSubmitInteraction): Promise<void> {
    const messageId = i.customId.slice('correct:'.length);
    await this.applyCorrection(i, messageId, i.fields.getTextInputValue('lang'), i.fields.getTextInputValue('text'));
  }

  private async cmdCorrect(i: ChatInputCommandInteraction): Promise<void> {
    const ref = i.options.getString('message', true);
    const messageId = ref.split('/').pop()!.trim();
    await this.applyCorrection(i, messageId, i.options.getString('lang', true), i.options.getString('text', true));
  }

  private async applyCorrection(i: ChatInputCommandInteraction | ModalSubmitInteraction, messageId: string, langIn: string, corrected: string): Promise<void> {
    const cap = this.d.store.caption(messageId);
    const lang = normalizeLang(langIn);
    if (!cap || !lang) {
      await i.reply({ content: 'Caption not found (or unknown language).', flags: EPH });
      return;
    }
    const original = cap.translations[lang];
    if (!original) {
      await i.reply({ content: `That caption has no ${languageName(lang)} translation.`, flags: EPH });
      return;
    }
    const worker = this.d.pool.anyReady();
    if (!worker) throw new Error('translation worker offline');
    const r = (await worker.request({ type: 'correct', original, corrected, src_lang: cap.srcLang, tgt_lang: lang }, 'correct_result')) as unknown as {
      terms: { source: string; target: string; src_lang: string; tgt_lang: string; kind: 'fix' }[];
    };
    for (const t of r.terms) this.d.store.addTerm({ guildId: i.guildId!, srcLang: t.src_lang, tgtLang: t.tgt_lang, source: t.source, target: t.target, kind: 'fix', createdBy: i.user.id });
    this.sessions.get(i.guildId!)?.session.pushConfig();
    // update the caption in place
    try {
      const a = this.sessions.get(i.guildId!);
      const ch = a?.captionsChannel ?? (i.channel as GuildTextBasedChannel | null);
      const msg: Message | undefined = await ch?.messages.fetch(messageId);
      if (msg && msg.author.id === this.d.client.user!.id) {
        const before = escapeMd(original);
        const fixed = msg.content.includes(before) ? msg.content.replace(before, () => `${escapeMd(corrected)} ✏️`) : msg.content;
        if (fixed !== msg.content) await msg.edit({ content: fixed, allowedMentions: { parse: [] } });
      }
    } catch {
      /* caption may be in another channel or deleted */
    }
    await i.reply({
      content: r.terms.length
        ? `✏️ Thanks! Learned ${r.terms.length} correction(s): ${r.terms.map((t) => `"${t.source}" → "${t.target}"`).join(', ')}`
        : '✏️ Caption corrected. (The change was too large to learn as a reusable rule.)',
      flags: EPH,
    });
  }

  // ------------------------------------------------------------------ /whisper, /summary, /listen
  private async cmdWhisper(i: ChatInputCommandInteraction): Promise<void> {
    const sub = i.options.getSubcommand();
    if (sub === 'on' || sub === 'off') {
      const u = this.d.store.updateUser(i.user.id, { whisperDm: sub === 'on' });
      this.sessions.get(i.guildId!)?.session.pushConfig();
      await i.reply({
        content: sub === 'on'
          ? `🤫 I'll DM you live translations in **${u.hearLang ? languageName(u.hearLang) : 'your hear language — set it with `/mylang hear:`'}** while you're in a translated call.`
          : 'DM translations off.',
        flags: EPH,
      });
      return;
    }
    const to = i.options.getUser('to', true);
    const text = i.options.getString('text', true).slice(0, 1500);
    const last = this.whisperRate.get(i.user.id) ?? 0;
    if (Date.now() - last < 5000) throw new Error('Slow down — one private message every 5 seconds.');
    this.whisperRate.set(i.user.id, Date.now());
    if (to.bot) throw new Error("You can't whisper to a bot.");
    const sender = this.d.store.getUser(i.user.id);
    const rec = this.d.store.getUser(to.id);
    const tgt = rec.hearLang ?? rec.speakLang ?? 'en';
    const src = sender.speakLang ?? sender.hearLang ?? 'en';
    await i.deferReply({ flags: EPH });
    const worker = this.d.pool.anyReady();
    if (!worker) throw new Error('translation worker offline');
    const r = await worker.request({ type: 'translate_text', guild_id: i.guildId, text, src, tgt }, 'translate_result');
    if (!r.ok) throw new Error(String(r.error));
    const m = await this.member(i);
    await to.send({ content: `🤫 **${m.displayName}** (from ${i.guild!.name}, ${languageName(src)} → ${languageName(tgt)}):\n${r.text}\n-# original: ${text}`, allowedMentions: { parse: [] } });
    await i.editReply(`Sent privately to ${to.username} in ${languageName(tgt)}.`);
  }

  private async cmdSummary(i: ChatInputCommandInteraction): Promise<void> {
    const a = this.sessions.get(i.guildId!);
    if (!a) throw new Error('No translation session is running.');
    if (!a.session.settings.summaries) throw new Error('Summaries are off (`/settings set summaries:true`).');
    await i.deferReply();
    const extra = i.options.getString('lang');
    const langs = [...a.session.summaryLangs(), ...(extra ? [normalizeLang(extra) ?? 'en'] : [])];
    const s = await a.session.summarize(langs, false);
    await this.postSummary(i.channel as GuildTextBasedChannel, s);
    await i.editReply('Summary posted.');
  }

  private async cmdListen(i: ChatInputCommandInteraction): Promise<void> {
    const pref = this.d.store.getUser(i.user.id);
    const langOpt = i.options.getString('lang');
    const lang = (langOpt ? normalizeLang(langOpt) : null) ?? pref.hearLang ?? 'en';
    const t = this.d.signer.sign({ g: i.guildId!, u: i.user.id, s: 'listen', l: lang }, this.d.cfg.listenTtlMs);
    const live = this.sessions.has(i.guildId!) ? '' : '\n-# No session is running yet; the page will connect when one starts.';
    await i.reply({
      content: `🎧 Your personal translated stream (${languageName(lang)}): ${this.d.cfg.publicUrl}/listen?t=${t}\nTip: in Discord, right-click foreign speakers → lower **User Volume**, then use the page's mixer.${live}`,
      flags: EPH,
    });
  }

  private async cmdLanguages(i: ChatInputCommandInteraction): Promise<void> {
    const info = this.d.pool.info();
    if (!info) throw new Error('translation worker offline');
    const code = i.options.getString('code');
    if (code) {
      const c = normalizeLang(code);
      const l = c ? info.languages[c] : undefined;
      if (!l || !c) throw new Error(`Unknown language "${code}"`);
      const tier = ['unsupported', 'cloned voice', 'standard voice', 'captions only'][l.tier] ?? '?';
      await i.reply({ content: `**${l.name} (${c})** — listeners get: **${tier}** · speech recognition: **${l.stt}**${l.auto ? ' (auto-detected)' : ''}\n${l.reasons.map((r) => `• ${r}`).join('\n')}`, flags: EPH });
      return;
    }
    const by: Record<number, string[]> = { 1: [], 2: [], 3: [], 0: [] };
    for (const [k, v] of Object.entries(info.languages)) by[v.tier]!.push(k);
    const fmtList = (xs: string[]) => (xs.length ? xs.sort().join(' ') : '—');
    await i.reply({
      content: [
        `🗣️ **Cloned voice** (${by[1]!.length}): ${fmtList(by[1]!)}`,
        `🔊 **Standard voice** (${by[2]!.length}): ${fmtList(by[2]!)}`,
        `💬 **Captions only** (${by[3]!.length}): ${fmtList(by[3]!)}`,
        `⛔ **Unsupported** (${by[0]!.length}): ${fmtList(by[0]!)}`,
        '-# `/languages code:yo` for details. Tiers reflect the models installed on this bot right now.',
      ].join('\n').slice(0, 1990),
      flags: EPH,
    });
  }

  private async cmdDashboard(i: ChatInputCommandInteraction): Promise<void> {
    const t = this.d.signer.sign({ g: i.guildId!, u: i.user.id, s: 'admin' }, this.d.cfg.adminTtlMs);
    await i.reply({ content: `📊 ${this.d.cfg.publicUrl}/dashboard?t=${t}\n-# Link valid for ${Math.round(this.d.cfg.adminTtlMs / 60000)} min. Don't share it.`, flags: EPH });
  }

  // ------------------------------------------------------------------ voice state
  private onVoiceState(o: VoiceState, n: VoiceState): void {
    const a = this.sessions.get(n.guild.id);
    if (!a) return;
    const botId = this.d.client.user!.id;
    if (n.id === botId && !n.channelId) {
      void this.stop(n.guild.id, 'bot was disconnected');
      return;
    }
    if (o.channelId === a.link.channelId && n.channelId !== a.link.channelId) a.session.dropUser(n.id);
    const ch = n.guild.channels.cache.get(a.link.channelId);
    const humans = ch && 'members' in ch ? (ch.members as Map<string, GuildMember>) : null;
    const count = humans ? [...humans.values()].filter((m) => !m.user.bot).length : 1;
    if (count === 0 && !a.leaveTimer) {
      a.leaveTimer = setTimeout(() => void this.stop(n.guild.id, 'everyone left'), this.d.cfg.autoLeaveMs);
    } else if (count > 0 && a.leaveTimer) {
      clearTimeout(a.leaveTimer);
      a.leaveTimer = null;
    }
  }

  guildOf(id: string): Guild | undefined {
    return this.d.client.guilds.cache.get(id);
  }

  async shutdown(): Promise<void> {
    for (const gid of [...this.sessions.keys()]) await this.stop(gid, 'bot restarting');
  }
}
