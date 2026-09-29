import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function translate(text, { targetLang = 'English', sourceLang = 'unknown' } = {}) {
  const sourceInstruction = sourceLang === 'unknown'
    ? 'The source language was auto-detected and may not be perfectly identified — infer it from the text itself if needed.'
    : `The source language is ${sourceLang}.`;

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: `You are a real-time interpreter captioning a Discord voice channel, translating into ${targetLang}. ${sourceInstruction} You'll receive a short transcribed snippet — it may include slang, filler words, or transcription errors. Reply with ONLY the natural, fluent ${targetLang} translation, nothing else. If the text is just noise or too short to translate meaningfully, reply with exactly: …`,
    messages: [{ role: 'user', content: text }]
  });

  return msg.content?.[0]?.text?.trim() ?? '…';
}
