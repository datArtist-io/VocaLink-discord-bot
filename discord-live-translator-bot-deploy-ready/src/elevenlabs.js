const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;

// A stock ElevenLabs premade voice, used for speakers who haven't enrolled
// their own voice. Not a clone of anyone — just a generic narrator voice so
// non-enrolled speakers still get dubbed audio. Swap for any voice_id from
// your own ElevenLabs voice library if you'd rather use a different one.
export const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // "Rachel"

// Takes a raw audio sample (the file a user uploads to /translate enroll-voice)
// and registers it as an Instant Voice Clone. Returns the new voice_id.
export async function cloneVoice({ buffer, filename, mimeType, name }) {
  const form = new FormData();
  form.set('name', name);
  form.set(
    'description',
    'Self-enrolled via Discord live-translator bot. Consent confirmed at enrollment time.'
  );
  form.set('files', new Blob([buffer], { type: mimeType }), filename);

  const res = await fetch('https://api.elevenlabs.io/v1/voices/add', {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_KEY },
    body: form
  });

  if (!res.ok) {
    throw new Error(`ElevenLabs voice clone failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  return data.voice_id;
}

export async function deleteVoice(voiceId) {
  await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
    method: 'DELETE',
    headers: { 'xi-api-key': ELEVENLABS_KEY }
  });
}

// Synthesizes `text` in the given voice and returns an MP3 buffer.
// eleven_flash_v2_5 trades a little quality for much lower latency, which
// matters here since this sits in a live STT -> translate -> TTS chain.
// Swap to 'eleven_multilingual_v2' if you'd rather prioritize quality.
export async function synthesizeSpeech(text, voiceId = DEFAULT_VOICE_ID) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_flash_v2_5',
        output_format: 'mp3_44100_128'
      })
    }
  );

  if (!res.ok) {
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${await res.text()}`);
  }

  return Buffer.from(await res.arrayBuffer());
}
