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

/** The language spoken into the voice channel, or null when the channel voice is off. */
export function channelVoice(s: GuildSettings): string | null {
  if (s.dubLang === null) return null;
  if (s.dubLang === 'auto' || !s.textTargets.includes(s.dubLang)) return s.textTargets[0] ?? null;
  return s.dubLang;
}

/** Plain sentences describing what will happen. */
export function describe(s: GuildSettings): string {
  const langs = s.textTargets.slice(0, 3);
  const main = channelVoice(s);
  const lines = [`Anyone can speak **any language**. Captions in ${listJoin(langs.map((l) => `**${langLabel(l)}**`))}.`];
  lines.push(
    main
      ? `🔊 **Channel voice: ${langLabel(main)}.** When someone speaks another language, everyone hears it in ${nice(main)}. ${nice(main)} speech stays as it is.`
      : '🔇 **Channel voice is off.** Nothing is spoken in the voice channel.',
  );
  lines.push(`🎧 **Speak a different language?** Use **/listen** to hear everyone in your language, privately. Only you hear it.`);
  if (!s.captions) lines[0] = 'Anyone can speak **any language**. Captions are off.';
  return lines.join('\n');
}

export function renderPanel(s: GuildSettings): { embeds: APIEmbed[]; components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] } {
  const langs = s.textTargets.slice(0, 3);
  const select = new StringSelectMenuBuilder()
    .setCustomId('setup:langs')
    .setPlaceholder('🌐 Languages in this server (up to 3)')
    .setMinValues(1)
    .setMaxValues(3)
    .addOptions(
      PANEL_LANGS.map((l) => ({ label: nice(l), value: l, emoji: flag(l), default: langs.includes(l) })),
    );
  const main = channelVoice(s);
  const voice = new StringSelectMenuBuilder()
    .setCustomId('setup:voice')
    .setPlaceholder('🔊 Channel voice')
    .addOptions(
      ...langs.map((l) => ({ label: `Channel voice: ${nice(l)}`, description: `The group's main language is ${nice(l)}`, value: l, emoji: flag(l), default: main === l })),
      { label: 'Channel voice: Off', description: 'Captions and personal listening only', value: 'off', emoji: '🔇', default: main === null },
    );
  const buttons = [
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
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(voice),
      new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons),
    ],
  };
}
