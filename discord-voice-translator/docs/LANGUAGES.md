# Language coverage report

**Status: prior estimates.** Tiers are computed at start-up from the models that actually loaded
(`python -m translator_worker --languages`, `/languages` in Discord, the dashboard). The speech-recognition
grades below are priors from published Whisper large-v3 FLEURS/Common Voice WER, bucketed coarsely
(good < ~12 % WER, fair 12–35 %, poor > 35 %). Run `worker/scripts/bench.py --clips` with real speech to
replace them with measured numbers.

## Tiers (what a *listener* gets in language X)

| Tier | Meaning | Requires |
|---|---|---|
| 1 🗣️ cloned voice | your words, translated, in your own voice | GPU tier + Chatterbox supports X + you ran `/voice enroll` + server set `voice: clone` |
| 2 🔊 standard voice | translated speech in a house voice | MT into X + a Piper/MMS/cloud voice for X |
| 3 💬 captions only | translated text | MT into X, no voice |
| 0 ⛔ unsupported | — | no MT into X |

Fallback is automatic, per utterance and per language: clone → house voice → captions. The caption thread
posts a one-time notice per language explaining *why* (e.g. "Igbo: captions only — no speech voice installed").

## Expected tiers with the default local stack (non-commercial, GPU)

| | Languages |
|---|---|
| **Tier 1** (Chatterbox Multilingual, 23) | ar da de el en es fi fr he hi it ja ko ms nl no pl pt ru sv sw tr zh |
| **Tier 2** (Piper voices ≈ 40 families, + MMS-TTS for many others when `requirements-extras` is installed) | e.g. bg ca cs cy fa hu is ka kk lb lv ml ne ro sk sl sr te uk vi … plus yo ha ig via MMS |
| **Tier 3** | languages with NLLB translation but no installed voice |
| **Tier 0** | la, br, haw (not in NLLB) unless an LLM/cloud MT is configured |

On the CPU tier there is no cloning, so Tier 1 languages become Tier 2. With `COMMERCIAL=true`, MMS voices are
removed, so languages that only MMS covers fall to Tier 3.

**Speech recognition (source side):** Whisper recognises and auto-detects 100 languages (99 + Cantonese on
large-v3). Smaller CPU models lose accuracy on low-resource languages; the registry downgrades their grade.

## Nigerian languages — strategy and honest expectations

| Language | Recognise (speaker side) | Translate | Speak (listener side) | Expected tier | Fallback strategy |
|---|---|---|---|---|---|
| **Yoruba (yo)** | Whisper: supported, **poor** (high WER; tone marks often missing) | NLLB `yor_Latn` ✓, MADLAD ✓ | MMS-TTS `mms-tts-yor` (non-commercial; needs tone-marked text for good prosody) | **2** non-commercial, **3** commercial | `expected_langs` to stop yo↔en/ha confusion; glossary for names; captions flagged `weak_language`; hybrid mode can route Yoruba STT to a cloud key |
| **Hausa (ha)** | Whisper: supported, **poor** | NLLB `hau_Latn` ✓, MADLAD ✓ | MMS-TTS `mms-tts-hau` | **2** / **3** | same as Yoruba |
| **Igbo (ig)** | **Not a Whisper language** → no zero-setup auto-detect. Enable `stt.igbo_asr` (MMS-1b-all, CC-BY-NC) and speakers set `/mylang speak:ig` | NLLB `ibo_Latn` ✓, MADLAD ✓ | MMS-TTS `mms-tts-ibo` | listeners: **2** / **3**; speakers: needs the add-on or a cloud key | without the add-on, Igbo speakers are mis-detected (often as Yoruba/Swahili) — the registry says so |
| **Nigerian Pidgin (pcm)** | Not a Whisper language, but English-lexified: transcribed as English (**fair**), relabelled `pcm` by a transcript marker detector (*abeg, wetin, dey, una, wahala…*) | **Pidgin → other:** NLLB lacks Pidgin; translated *as English* (note shown). **Other → Pidgin:** needs an LLM | spoken with an English voice | listeners: **2** with an LLM, **0** without; speakers: works | set `/mylang speak:pcm` to skip detection; add Ollama for Pidgin output |

What I need from you to make these numbers real: ~10 short clips (5–15 s, 16-bit WAV) per language with a
reference transcript (`clips/yo/001.wav` + `clips/yo/001.txt`, same for ha, ig, pcm). I can't judge Yoruba
tone or Pidgin quality without real speech.
