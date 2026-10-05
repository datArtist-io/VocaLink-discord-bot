/** Language names / codes used by commands and the web UI (worker owns the full table). */

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', zh: 'Chinese (Mandarin)', de: 'German', es: 'Spanish', ru: 'Russian', ko: 'Korean', fr: 'French',
  ja: 'Japanese', pt: 'Portuguese', tr: 'Turkish', pl: 'Polish', ca: 'Catalan', nl: 'Dutch', ar: 'Arabic', sv: 'Swedish',
  it: 'Italian', id: 'Indonesian', hi: 'Hindi', fi: 'Finnish', vi: 'Vietnamese', he: 'Hebrew', uk: 'Ukrainian',
  el: 'Greek', ms: 'Malay', cs: 'Czech', ro: 'Romanian', da: 'Danish', hu: 'Hungarian', ta: 'Tamil', no: 'Norwegian',
  th: 'Thai', ur: 'Urdu', hr: 'Croatian', bg: 'Bulgarian', lt: 'Lithuanian', la: 'Latin', mi: 'Maori', ml: 'Malayalam',
  cy: 'Welsh', sk: 'Slovak', te: 'Telugu', fa: 'Persian', lv: 'Latvian', bn: 'Bengali', sr: 'Serbian', az: 'Azerbaijani',
  sl: 'Slovenian', kn: 'Kannada', et: 'Estonian', mk: 'Macedonian', br: 'Breton', eu: 'Basque', is: 'Icelandic',
  hy: 'Armenian', ne: 'Nepali', mn: 'Mongolian', bs: 'Bosnian', kk: 'Kazakh', sq: 'Albanian', sw: 'Swahili',
  gl: 'Galician', mr: 'Marathi', pa: 'Punjabi', si: 'Sinhala', km: 'Khmer', sn: 'Shona', yo: 'Yoruba', so: 'Somali',
  af: 'Afrikaans', oc: 'Occitan', ka: 'Georgian', be: 'Belarusian', tg: 'Tajik', sd: 'Sindhi', gu: 'Gujarati',
  am: 'Amharic', yi: 'Yiddish', lo: 'Lao', uz: 'Uzbek', fo: 'Faroese', ht: 'Haitian Creole', ps: 'Pashto', tk: 'Turkmen',
  nn: 'Norwegian Nynorsk', mt: 'Maltese', sa: 'Sanskrit', lb: 'Luxembourgish', my: 'Burmese', bo: 'Tibetan',
  tl: 'Tagalog', mg: 'Malagasy', as: 'Assamese', tt: 'Tatar', haw: 'Hawaiian', ln: 'Lingala', ha: 'Hausa',
  ba: 'Bashkir', jw: 'Javanese', su: 'Sundanese', yue: 'Cantonese', ig: 'Igbo', pcm: 'Nigerian Pidgin',
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

export function normalizeLang(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim().toLowerCase().replace('_', '-');
  if (s === 'auto') return 'auto';
  if (LANGUAGE_NAMES[s]) return s;
  const base = s.split('-')[0]!;
  if (LANGUAGE_NAMES[base]) return base;
  const byName = Object.entries(LANGUAGE_NAMES).find(([, n]) => n.toLowerCase() === s || n.toLowerCase().startsWith(s));
  if (byName) return byName[0];
  if (s === 'pidgin') return 'pcm';
  return null;
}

export function parseLangList(input: string): string[] {
  const out: string[] = [];
  for (const part of input.split(/[,\s]+/)) {
    const c = normalizeLang(part);
    if (c && c !== 'auto' && !out.includes(c)) out.push(c);
  }
  return out;
}

/** Up to 25 autocomplete choices matching `q`. */
export function autocompleteLanguages(q: string, extra: { name: string; value: string }[] = []): { name: string; value: string }[] {
  const s = q.trim().toLowerCase();
  const all = Object.entries(LANGUAGE_NAMES).map(([value, name]) => ({ name: `${name} (${value})`, value }));
  const hits = s ? all.filter((c) => c.value.startsWith(s) || c.name.toLowerCase().includes(s)) : all;
  return [...extra, ...hits].slice(0, 25);
}
