// Translation via Google's Gemini API (free tier available, no card needed).
// Uses plain fetch, so no extra SDK is required.
// Model is configurable with GEMINI_MODEL. Default is a stable, free-tier model.
// (Avoid gemini-2.5-* — Google is shutting those down on 16 Oct 2026.)
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

export async function translate(text, { targetLang = 'English', sourceLang = 'unknown' } = {}) {
  const sourceInstruction = sourceLang === 'unknown'
    ? 'The source language was auto-detected and may not be perfectly identified — infer it from the text itself if needed.'
    : `The source language is ${sourceLang}.`;

  const system = `You are a real-time interpreter captioning a Discord voice channel, translating into ${targetLang}. ${sourceInstruction} You'll receive a short transcribed snippet — it may include slang, filler words, or transcription errors. Reply with ONLY the natural, fluent ${targetLang} translation, nothing else. If the text is just noise or too short to translate meaningfully, reply with exactly: …`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { maxOutputTokens: 1000, temperature: 0.2 }
      })
    }
  );

  if (!res.ok) {
    throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const out = data?.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('').trim();
  return out || '…';
}
