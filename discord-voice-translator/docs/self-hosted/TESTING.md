# Testing: what is verified, what is not

The build environment had **no access to npm, PyPI, Hugging Face or Discord**. Real models and a real Discord
connection could not be run. Everything else was tested, using stand-in models that exercise the real pipeline.

## How the pipeline is tested without models

`worker/translator_worker/providers/fake.py` provides a stand-in TTS that **encodes "language|text" into audio**
(16-tone FSK) and a stand-in STT that **decodes it back**. Partial audio decodes to a prefix of the text, exactly
like a streaming decode. So the real code paths run end to end: VAD endpointing on real audio, partial decodes,
LocalAgreement, language smoothing, Pidgin relabelling, routing/fallback, glossary, translation fan-out,
streaming TTS, resampling to 48 kHz, the TCP protocol, the edge's playout scheduler, and dub audio that the
test **demodulates to check what the bot actually said**.

## Automated tests (all passing)

Run:
```bash
cd worker/tests && python -m unittest test_units test_providers test_e2e_worker      # 54 tests
cd edge && npm test                                                                     # 17 tests
```

| Suite | # | Covers |
|---|---|---|
| worker `test_units` | 31 | protocol framing (fragmentation, limits); endpointer (timing within one window of 500 ms, fast end after punctuation, click rejection, 12 s cut, pause split); language smoothing (no flip-flop on short/confusable utterances, confident switch, sustained switch for hi/ur, forced/allowed sets, re-check cadence); LocalAgreement (Latin + CJK); clauses; remainder after incremental dub; hallucination filter; glossary pre/post/verify/learning; router policy ordering, commercial filter, circuit breaker + half-open; registry tiers incl. yo/ha/ig/pcm; config YAML/env; hardware plans per tier + commercial switch; AES-GCM voice store (round trip, no plaintext, wrong key, delete); language table (100 Whisper languages); metrics |
| worker `test_providers` | 7 | glue to faster-whisper, CTranslate2 (exact NLLB and MADLAD token formats), Piper (per-voice sample rate, prosody), and HTTP plug-ins (Deepgram, OpenAI-compatible STT/LLM/TTS, DeepL, Google, ElevenLabs) against a local mock server; JSON-mode fallback |
| worker `test_e2e_worker` | 16 | TCP edge simulator ↔ worker: auth; partials + final + French dub decoded; two simultaneous speakers in fr/yo; Pidgin detection; dropped frames concealed; natural mode via LLM; correction learning; text translation; 100+ language registry; summary; dub cancel; flush on close; **voice enrollment** (wrong phrase rejected, clone dub for fr + house voice for yo, delete); **code-switching** (fr+en in one utterance, each part translated from its own language, only the foreign part dubbed); **load shedding** (4 speakers on a slow model: partials shed, every final delivered) |
| edge `core` | 12 | frames; playout (FIFO, prebuffer, stale/queue drops, ducking gain ramp, barge-in cut); UserStream (real-time silence fill, idle, loss fill, contiguous sequence numbers); ring buffer; PCM; caption formatting/escaping; caption sink (debounce, final wins, digest under rate limit); SQLite store; HMAC tokens; languages; metrics |
| edge `web` | 1 | health, CSP nonce, scoped tokens (listen can't read analytics), WebSocket rejects bad tokens, caption in listener's language, 24 kHz audio frames, language switch updates audio targets |
| edge `integration` | 4 | **GuildSession ↔ real Python worker process**: speech → captions + **French dub played in the channel and decoded** (incremental: first clause while speaking, then only the remainder) + Yoruba stream to a web listener; opt-out users and bots never sent to the worker; **worker `kill -9` mid-session → voice stays up, audio buffered, state replayed, translation resumes**; summary on stop + correction round trip |

Also verified:
* **Type-checking**: the core edge modules and tests type-check under `strict` against real `@types/node`.
  Discord-facing files (`bot.ts`, `DiscordVoiceLink.ts`, `Mirror.ts`, `main.ts`, `dave-spike.ts`, web server's
  `ws` usage) were compiled only against permissive local stubs. That catches syntax and internal errors, **not**
  API mismatches. Run `npm run typecheck` after `npm install`.
* **Web pages** rendered in headless Chromium (dashboard light mode, companion dark mode, 390 px mobile): no
  console or CSP errors, no horizontal overflow, Yoruba diacritics display correctly.
* `bench.py` and `--languages` / `--plan` CLIs run end to end with stand-in models.

## NOT verified here (needs your Phase 0)

1. **Discord:** login, command registration, joining voice, **DAVE receive/send**, Opus decoding of real packets,
   threads, permissions, rate limits under real load, mirror bots, DMs, buttons/modals, sharding.
2. **Real models:** faster-whisper, CTranslate2 NLLB/MADLAD, Silero ONNX, Piper, MMS, Chatterbox, SeamlessM4T,
   Ollama. Provider glue follows the documented APIs and is tested against stand-ins, not the libraries.
   The NLLB/MADLAD community CTranslate2 repos named in `hardware.py` were found by search, not downloaded.
3. **Cloud APIs** with real keys (only their request/response shapes against a mock).
4. **Docker images** (`docker build` needs registry access); CUDA image + `chatterbox-tts` dependency pins.
5. **All latency numbers** in the docs are estimates.
6. **Translation/recognition quality** in any language, especially Yoruba, Hausa, Igbo and Pidgin.

## Phase 0 checklist (about an hour on the server)

| Step | Command | Pass |
|---|---|---|
| 1. Install + typecheck edge | `cd edge && npm install && npm run typecheck && npm test` | no type errors; 17 pass |
| 2. Worker tests in the image | `docker compose --profile cpu run --rm -v $PWD/worker/tests:/app/tests worker python -m unittest discover -s tests` | 54 pass |
| 3. Models | `docker compose --profile init-gpu run --rm models-init-gpu` | "All requested models are present." |
| 4. Tiers | `python -m translator_worker --languages` | providers loaded as expected; Silero (not energy VAD) |
| 5. **DAVE spike** | see DEPLOY.md §6 | PASS: loss < 5 %, < 20 % around join/leave; WAVs intelligible |
| 6. Benchmark | `bench.py --clips /clips` | p50 end-to-first-audio within the tier budget |
| 7. Live call | `/translate start`, speak 2–3 languages, `/listen`, `/translate stop` | captions + dubs + summary |

If step 5 fails, that is risk R1 and blocks voice translation on this library version. Send me the JSON
report: the fix may be a newer `@discordjs/voice` / `davey`, or switching the edge to another DAVE stack.
