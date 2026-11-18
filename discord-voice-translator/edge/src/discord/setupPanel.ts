/**
 * The /setup panel: the only settings most servers ever need, on one screen.
 *
 *   🌐 Server languages   (pick 1-3)
 *   🔊 Voice in channel   on / off
 *   💬 Captions           on / off
 *
 * It always shows, in one plain sentence, what VocaLink will do.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, type APIEmbed } from 'discord.js';

import type { GuildSettings } from '../store/Store.js';
import { languageName } from '../languages.js';

/** Languages offered in the picker (Discord allows 25 options): all have natural voices. */
export const PANEL_LANGS = [
  'en', 'tl', 'es', 'fr', 'pt', 'de', 'it', 'ja', 'ko', 'zh', 'hi', 'id', 'ms',
  'vi', 'ar', 'ru', 'tr', 'pl', 'nl', 'sv', 'uk', 'ro', 'el', 'cs', 'ta',
] as const;

const FLAG: Record<string, string> = {
  en: '🇺🇸', tl: '🇵🇭', es: '🇪🇸', fr: '🇫🇷', pt: '🇧🇷', de: '🇩🇪', it: '🇮🇹', ja: '🇯🇵', ko: '🇰🇷', zh: '🇨🇳',
  hi: '🇮🇳', id: '🇮🇩', ms: '🇲🇾', vi: '🇻🇳', ar: '🇸🇦', ru: '🇷🇺', tr: '🇹🇷', pl: '🇵🇱', nl: '🇳🇱', sv: '🇸🇪',
  uk: '🇺🇦', ro: '🇷🇴', el: '🇬🇷', cs: '🇨🇿', ta: '🇮🇳',
};

export const flag = (l: string): string => FLAG[l] ?? '🌐';
const nice = (l: string): string => (l === 'tl' ? 'Filipino' : languageName(l));
export const langLabel = (l: string): string => `${flag(l)} ${nice(l)}`;

function listJoin(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** One plain sentence describing what will happen. */
export function describe(s: GuildSettings): string {
  const langs = s.textTargets.slice(0, 3);
  const names = langs.map(langLabel);
  const voice = s.dubLang !== null;
  const lines = [
    `Anyone can speak **any language**. VocaLink translates it into ${listJoin(names.map((n) => `**${n}**`))}.`,
  ];
  if (voice && langs.length >= 2) {
    lines.push(`🔊 In the voice channel, ${nice(langs[0]!)} speech is spoken in ${nice(langs[1]!)}, and everything else in ${nice(langs[0]!)}.`);
  } else if (voice) {
    lines.push(`🔊 In the voice channel, everything is spoken in ${nice(langs[0]!)}.`);
  } else {
    lines.push('🔇 Nothing is spoken in the voice channel.');
  }
  lines.push(s.captions ? '💬 Live captions appear in a thread.' : '💬 Captions are off.');
  lines.push('🎧 Want your own language only? Use **/listen**.');
  return lines.join('\n');
}

export function renderPanel(s: GuildSettings): { embeds: APIEmbed[]; components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] } {
  const langs = s.textTargets.slice(0, 3);
  const select = new StringSelectMenuBuilder()
    .setCustomId('setup:langs')
    .setPlaceholder('🌐 Choose your server’s languages (up to 3)')
    .setMinValues(1)
    .setMaxValues(3)
    .addOptions(
      PANEL_LANGS.map((l) => ({ label: nice(l), value: l, emoji: flag(l), default: langs.includes(l) })),
    );
  const voiceOn = s.dubLang !== null;
  const buttons = [
    new ButtonBuilder()
      .setCustomId('setup:voice')
      .setLabel(voiceOn ? 'Voice in channel: On' : 'Voice in channel: Off')
      .setEmoji(voiceOn ? '🔊' : '🔇')
      .setStyle(voiceOn ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('setup:captions')
      .setLabel(s.captions ? 'Captions: On' : 'Captions: Off')
      .setEmoji('💬')
      .setStyle(s.captions ? ButtonStyle.Success : ButtonStyle.Secondary),
  ];
  return {
    embeds: [
      {
        title: '⚙️ VocaLink setup',
        description: describe(s),
        color: 0x5865f2,
        footer: { text: 'Changes apply instantly, even during a call.' },
      },
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons),
    ],
  };
}
