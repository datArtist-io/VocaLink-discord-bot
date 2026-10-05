# Licences of models and libraries

Check each upstream page before commercial use; these are the licences as understood in October 2026.

| Component | Used for | Licence | Commercial use |
|---|---|---|---|
| Whisper weights / faster-whisper / CTranslate2 | STT + language ID | MIT | ✅ |
| Silero VAD | voice activity | MIT | ✅ |
| **NLLB-200** (Meta) | default MT | **CC-BY-NC 4.0** | ❌ → `COMMERCIAL=true` switches to MADLAD |
| MADLAD-400 (Google) | MT (commercial mode) | Apache-2.0 | ✅ |
| Piper engine (`piper-tts`, OHF-Voice/piper1-gpl) | house TTS | **GPL-3.0** | ✅ with GPL obligations (we run it in a separate worker process; review before redistributing images) |
| Piper voices | house TTS | per voice (see each `MODEL_CARD`) — many CC-BY / public domain, **some non-commercial** | check the voices you ship |
| **MMS-TTS / MMS-1b-all** (Meta) | Yoruba/Hausa/Igbo voices, Igbo ASR | **CC-BY-NC 4.0** | ❌ (auto-disabled in commercial mode) |
| **SeamlessM4T v2** (Meta) | experimental S2S | **CC-BY-NC 4.0** | ❌ |
| Chatterbox Multilingual (Resemble AI) | voice cloning | MIT (+ Perth watermark in output) | ✅ |
| LLMs via Ollama | natural/cultural modes, summaries | model-specific (Llama Community License, Qwen Apache-2.0/Qwen licence, …) | check the model you pull |
| discord.js, @discordjs/voice | Discord | Apache-2.0 | ✅ |
| @snazzah/davey | DAVE protocol | MIT | ✅ |
| @discordjs/opus / opusscript | Opus decode | MIT | ✅ |
| ws | WebSocket | MIT | ✅ |

Cloud plug-ins (Deepgram, OpenAI, Groq, DeepL, Google, ElevenLabs) are governed by each vendor's API terms.
