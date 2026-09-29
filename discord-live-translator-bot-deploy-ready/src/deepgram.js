// One utterance in, one transcript out. We use Deepgram's pre-recorded endpoint
// per utterance rather than a live streaming socket per speaker — far simpler to
// get right for an MVP, at the cost of a little latency (audio only gets sent once
// silence closes out the utterance, see EndBehaviorType.AfterSilence in index.js).
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;

export async function transcribeUtterance(wavBuffer) {
  const res = await fetch(
    // language=multi (nova-3) auto-detects/code-switches across its supported
    // language set — see https://developers.deepgram.com/docs/language-detection
    'https://api.deepgram.com/v1/listen?model=nova-3&language=multi&smart_format=true&punctuate=true',
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${DEEPGRAM_KEY}`,
        'Content-Type': 'audio/wav'
      },
      body: wavBuffer
    }
  );

  if (!res.ok) {
    throw new Error(`Deepgram error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const channel = data?.results?.channels?.[0];
  const alt = channel?.alternatives?.[0];
  const transcript = alt?.transcript?.trim() ?? '';
  const detectedLanguage = channel?.detected_language ?? 'unknown';

  return { transcript, detectedLanguage };
}
