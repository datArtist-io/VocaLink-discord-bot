# Architecture

## 1. System diagram

```
 Discord voice channel  (DAVE end-to-end encrypted; one Opus stream per user)
        │  RTP/UDP, decrypted by @discordjs/voice 0.19.2 + @snazzah/davey
┌───────▼─────────────────────────────┐   TCP, length-prefixed frames     ┌──────────────────────────────────────┐
│ EDGE  (TypeScript, Node ≥ 22.12)    │   AUDIO_IN  16 kHz mono 20 ms ───►│ WORKER (Python ≥ 3.10)               │
│                                     │                                   │                                      │
│ DiscordVoiceLink   join/receive/    │◄── JSON events (partial, final,   │ per-speaker SpeakerSession:          │
│   play, DAVE health + auto-rejoin   │    tts_start/end, notices)        │   Endpointer (Silero VAD, adaptive)  │
│ UserStream   Opus→PCM (libopus @16k)│◄── AUDIO_OUT 48 kHz mono (dubs)   │   LocalAgreement partials (GPU)      │
│   + real-time silence fill          │                                   │   LanguageSmoother (per-speaker LID) │
│ GuildSession  orchestration         │                                   │   code-switch split on pauses        │
│ PlayoutScheduler one dub at a time, │                                   │ Router: policy local/hybrid/cloud,   │
│   stale-drop, ducking, barge-in     │                                   │   licence filter, circuit breakers   │
│ CaptionSink  rate-limited threads   │                                   │ Providers (swappable interfaces):    │
│ WorkerClient reconnect + 5 s ring   │                                   │   VAD  silero | energy               │
│   buffer + state replay             │                                   │   STT  faster-whisper | MMS | cloud  │
│ WorkerPool   N workers, failover    │                                   │   MT   NLLB | MADLAD | LLM | cloud   │
│ Store (SQLite) settings, consent,   │                                   │   TTS  Piper | MMS | Chatterbox |    │
│   glossary, analytics (no text)     │                                   │        cloud                         │
│ WebServer  /listen /dashboard       │                                   │   S2S  Seamless (experimental)       │
│ Mirror bots (optional)              │                                   │   LLM  any OpenAI-compatible (Ollama)│
└──┬──────────────┬────────────────┬──┘                                   │ Hardware probe → model plan          │
   │captions      │WebSocket       │extra bot apps                        │ Capability registry → tiers          │
   ▼              ▼                ▼                                      │ VoiceStore (AES-GCM, consented only) │
 Thread       Browser companion   Mirror voice channels                   └──────────────────────────────────────┘
              (own language,      (one per language,
               volume mixer)       listen-only)
```

**Why two processes in two languages.** The edge must never block: it holds the Discord gateway and voice
connections. `@discordjs/voice` 0.19.x is currently the most mature library with DAVE receive (py-cord cannot
receive DAVE audio; discord.py needs an unofficial fork). The worker does bursty, heavy ML work where Python owns
the ecosystem (faster-whisper, CTranslate2, Piper, Chatterbox, MMS). If the worker crashes, the edge keeps the
voice connection, buffers 5 s of audio per speaker, posts "Translation paused", reconnects with backoff, replays
guild/stream state and the buffered audio. This is covered by an integration test that `kill -9`s the worker.

**Why plain TCP instead of WebSocket between them.** Both ends are ours, on a private network. A 5-byte
length/type header is simpler, faster and dependency-free on both sides; it is identical in `edge/src/protocol/frames.ts`
and `worker/translator_worker/protocol.py`.

## 2. Per-utterance data flow (one speaker)

| # | Where | Step |
|---|---|---|
| 1 | edge | Opus packet → libopus decodes **directly to 16 kHz mono** (no resampler) → 20 ms frame, sequence-numbered |
| 2 | edge | `UserStream` fills silence in real time once packets stop (Discord sends nothing during silence), so the worker can detect the end of speech; dropped packets become short silences, not time compression |
| 3 | worker | Silero VAD on 32 ms windows; speech confirmed after 2 windows with 200 ms pre-roll; end after **500 ms** silence, or **250 ms** if the last partial ended in clause punctuation; hard cut at 12 s at the quietest point |
| 4 | worker | GPU tiers: re-decode the growing buffer every ~0.5 s (beam 1); **LocalAgreement-2** commits words two decodes agree on → live partial captions; new committed text is speculatively translated |
| 5 | worker | **Incremental dubbing** (GPU): each newly *stable clause* is translated and spoken while the person is still talking; the final step only dubs the remainder (tested: no repetition) |
| 6 | worker | Final decode (beam 5) with language ID. Per-speaker smoothing: short utterances lean on the speaker's prior; switches need a clear margin, sustained over 2 utterances for confusable pairs (es/pt, hi/ur, sr/hr…); locked speakers are re-verified every 3rd utterance |
| 7 | worker | Utterances ≥ 6 s are split at internal pauses and each part is language-detected and translated separately (code-switching) |
| 8 | worker | Nigerian Pidgin: Whisper hears it as English; a transcript-level marker detector relabels it `pcm` |
| 9 | worker | Hallucination filter ("Thank you.", repetition loops) + confidence score → `low_confidence` flag → "say that again?" in captions (rate-limited per user) |
| 10 | worker | MT into every caption + audio language (glossary terms substituted pre-MT and verified; learned post-edits applied) |
| 11 | edge | Caption message edited from partial → final; analytics row (no text) |
| 12 | worker | TTS streams in ≤ 100 ms chunks, resampled to 48 kHz; prosody transfer (pace + energy + pitch-variability → TTS rate/volume/expressiveness) |
| 13 | edge | `PlayoutScheduler` per output: prebuffer 60 ms → play; duck to 35 % while another human talks; cut (fade) if the dub's own speaker starts again and > 1.5 s remains; drop if it cannot start within 3 s; ≤ 3 waiting |

## 3. Latency budget (end of speech → first translated audio), per hardware tier

These are **engineering estimates**. `worker/scripts/bench.py` measures the real numbers on your machine
(Phase 0 gate). The dashboard shows live p50/p90 for every stage.

| Stage | CPU (8 cores, `small` int8) | 8–16 GB GPU (`large-v3-turbo` int8_fp16) | 24 GB+ GPU (`large-v3` fp16) |
|---|---|---|---|
| VAD endpoint (silence wait) | 300–500 ms | 250–400 | 250–400 |
| STT final (after partials) | 500–1200 | 120–250 | 100–200 |
| MT first clause | 250–600 (NLLB-600M) | 60–150 (NLLB-1.3B) | 50–120 (NLLB-3.3B) |
| TTS first audio — house / clone | 100–250 / — | 50–150 / 300–600 | 40–120 / 250–500 |
| Jitter buffer + playout | ~100 | ~100 | ~100 |
| **Total, house voice** | **~1.3–2.6 s** | **~0.6–1.05 s** | **~0.55–0.95 s** |
| **Total, cloned voice** | not offered | ~0.9–1.5 s | ~0.8–1.3 s |

With incremental dubbing (GPU), the first clause of a long sentence is often heard *before* the speaker
finishes, so perceived latency for long turns is lower than the table.

The honest CPU number: **1.5–2.5 s** for captions + house voice on short turns, worse for long ones, and
1–3 concurrent speakers per 8 cores. A cheap VPS is fine for captions-first use; use a GPU (or the Groq
whisper key in hybrid mode) for dubbing.

## 4. Model plan per tier (automatic; override in `config/config.yaml`)

| Stage | CPU | gpu8 (≥ 7 GB) | gpu24 (≥ 20 GB) |
|---|---|---|---|
| VAD | Silero (CPU) | same | same |
| STT + LID | faster-whisper `small` int8 (`medium` with ≥ 8 cores & 12 GB) | `large-v3-turbo` int8_float16 | `large-v3` float16 |
| MT | NLLB-200 600M int8 (MADLAD-3B if `COMMERCIAL=true`) | NLLB 1.3B | NLLB 3.3B |
| TTS house | Piper (+ MMS-TTS for yo/ha/ig, non-commercial) | same | same |
| Clone | off | Chatterbox Multilingual (23 langs) | same |
| Partials / incremental dub | off (on with ≥ 8 cores) | on | on |
| Optional LLM (Ollama) | off | 7–8B Q4 | 14B Q4 |

## 5. The per-listener problem

A bot has **one** audio output per channel, so everyone in the channel hears the same dub.

| Mode (build order) | How | Strengths | Trade-offs |
|---|---|---|---|
| 1. Captions in a thread | every utterance, every caption language, edited partial→final | works for every language tier; zero audio conflicts; searchable | reading while gaming/talking is hard |
| 2. Mirror voice channels | one extra **bot application** per language joins "🌐 French · General" and plays French dubs | native Discord, no extra app | splits the group (mirror listeners don't hear the originals and aren't translated themselves); needs one bot app per language; Manage Channels |
| 3. Web companion (`/listen`) | signed per-user link → browser plays *your* language with a volume slider and per-speaker mute | true per-listener language and mix; works on phones | user opens a page; can't mute Discord's original audio for you — lower foreign speakers' **User Volume** in Discord |

The companion can be wrapped as a **Discord Activity** (Embedded App SDK) later: the WebSocket protocol is the
same; the Activity needs an OAuth2 code exchange instead of the signed link and a URL mapping in the portal.

## 6. Interfaces (swap any stage in one file)

`worker/translator_worker/providers/base.py` defines `VADModel`, `STTModel`, `MTModel`, `TTSModel`,
`S2SModel`, `LLMModel`. Each provider declares `ProviderInfo(local, license, commercial_ok, cost_per_hour_usd,
max_concurrency)`. The `Router` orders providers per request:

* `local` – only local providers (default when no keys are set)
* `hybrid` – local first; cloud first only for `policy.hybrid_langs` (default ig, yo, ha, pcm); cloud as fallback
* `cloud` – cloud first, local fallback

Every provider has a circuit breaker (3 failures → open 30 s, doubling to 10 min; half-open probe). A missing or
wrong key is logged once and the local provider takes over. `COMMERCIAL=true` removes every non-commercial
provider from every chain.

## 7. Edge ↔ worker protocol (v1)

Frames: `u32 len | u8 type | payload`. Types: `0x01` JSON, `0x02` AUDIO_IN (`u32 sid, u32 seq`, PCM16 16 kHz),
`0x03` AUDIO_OUT (`u32 dub_id, u32 seq`, PCM16 48 kHz), `0x04` BLOB (enrollment audio).

Edge → worker: `hello{token}`, `guild_config`, `stream_open/update/close`, `cancel_dub`, `translate_text`,
`summarize`, `correct`, `voice_delete`, `voice_status`, `languages`, `ping`.
Worker → edge: `hello_ack{hardware, plan, providers, languages→tier}`, `speech_start`, `partial`,
`partial_translation`, `final{text, lang, confidence, flags, translations, tiers, latency}`, `lang_switch`,
`tts_start`, `tts_end`, `notice`, `discard`, `metrics`, `*_result`, `pong`.
