// Translation, optimized for speed.
//
// Primary: Google Cloud Translation (Basic v2, neural machine translation).
//   Typically ~100-300 ms, far faster than an LLM. Needs GOOGLE_TRANSLATE_API_KEY.
// Fallback: Gemini (only used if the target language isn't in the map below,
//   or if GOOGLE_TRANSLATE_API_KEY isn't set but GEMINI_API_KEY is).

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

// Name → Google language code. Users can also type a code directly (e.g. "yo").
const LANG_CODES = {
  english: 'en', french: 'fr', spanish: 'es', german: 'de', italian: 'it',
  portuguese: 'pt', 'brazilian portuguese': 'pt', dutch: 'nl', russian: 'ru',
  ukrainian: 'uk', polish: 'pl', turkish: 'tr', arabic: 'ar', hebrew: 'iw',
  hindi: 'hi', bengali: 'bn', urdu: 'ur', chinese: 'zh-CN',
  'chinese simplified': 'zh-CN', 'simplified chinese': 'zh-CN', mandarin: 'zh-CN',
  'chinese traditional': 'zh-TW', 'traditional chinese': 'zh-TW',
  japanese: 'ja', korean: 'ko', vietnamese: 'vi', thai: 'th', indonesian: 'id',
  malay: 'ms', filipino: 'tl', tagalog: 'tl', swahili: 'sw', yoruba: 'yo',
  igbo: 'ig', hausa: 'ha', zulu: 'zu', xhosa: 'xh', amharic: 'am', somali: 'so',
  afrikaans: 'af', greek: 'el', romanian: 'ro', hungarian: 'hu', czech: 'cs',
  swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi', persian: 'fa',
  farsi: 'fa', tamil: 'ta', telugu: 'te', punjabi: 'pa', nepali: 'ne'
};

function toCode(name) {
  const key = String(name).trim().toLowerCase();
  if (LANG_CODES[key]) return LANG_CODES[key];
  if (/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(key)) return key; // already a code
  return null;
}

async function googleTranslate(text, target, source) {
  const body = { q: text, target, format: 'text' };
  // Deepgram gives codes like "en" / "fr". Only pass a plain 2-letter source;
  // otherwise let Google auto-detect.
  if (source && /^[a-z]{2}$/i.test(source)) body.source = source.toLowerCase();

  const res = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${process.env.GOOGLE_TRANSLATE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  if (!res.ok) throw new Error(`Google Translate error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.data?.translations?.[0]?.translatedText ?? '';
}

async function geminiTranslate(text, targetLang, sourceLang) {
  const sourceInstruction = sourceLang === 'unknown'
    ? 'The source language was auto-detected; infer it from the text.'
    : `The source language is ${sourceLang}.`;
  const system = `You are a real-time interpreter captioning a Discord voice channel, translating into ${targetLang}. ${sourceInstruction} Reply with ONLY the natural, fluent ${targetLang} translation, nothing else. If the text is just noise, reply with exactly: …`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { maxOutputTokens: 1000, temperature: 0.2 }
      })
    }
  );
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('').trim() ?? '';
}

function decodeEntities(s) {
  return s
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export async function translate(text, { targetLang = 'English', sourceLang = 'unknown' } = {}) {
  const code = toCode(targetLang);

  // Already in the target language? Skip the API call entirely.
  if (code && sourceLang && sourceLang.toLowerCase().split('-')[0] === code.toLowerCase().split('-')[0]) {
    return text;
  }

  if (process.env.GOOGLE_TRANSLATE_API_KEY && code) {
    const out = await googleTranslate(text, code, sourceLang);
    return decodeEntities(out).trim() || '…';
  }

  if (process.env.GEMINI_API_KEY) {
    return (await geminiTranslate(text, targetLang, sourceLang)) || '…';
  }

  throw new Error(
    `Can't translate into "${targetLang}": set GOOGLE_TRANSLATE_API_KEY (and use a language name/code it knows) or GEMINI_API_KEY.`
  );
}
