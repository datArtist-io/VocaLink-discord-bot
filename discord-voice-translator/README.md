# Discord Live Voice Translator

A Discord bot that translates what people say in a voice channel, live, using **open-source models you host
yourself**. It needs **no paid API keys**; cloud providers are optional plug-ins.

* **Per-speaker pipeline**: Silero VAD → faster-whisper (speech-to-text + language ID for 100 languages) → NLLB-200 /
  MADLAD-400 translation → Piper / MMS / Chatterbox speech.
* **Three ways to listen**: captions in a thread, a dubbed voice in the channel (optional listen-only mirror
  channels per language), and a personal web companion (`/listen`) where each person picks their own language
  and volume.
* **Fast**: partial captions, speculative translation, the first clause dubbed while the person is still
  talking, streaming TTS. Estimated ~0.6–1.05 s from end of speech to the first dubbed audio on a 16 GB GPU.
  On CPU, expect 1.5–2.5 s.
* **Language-aware**: per-speaker auto-detection with anti-flip-flop smoothing, code-switching splits, and a
  capability registry that tells users exactly which languages get a cloned voice, a standard voice or
  captions only, and why. Nigerian Pidgin, Yoruba, Hausa and Igbo have explicit strategies
  ([docs/LANGUAGES.md](docs/LANGUAGES.md)).
* **Features**: voice-preserving dubbing (consented, encrypted, deletable), prosody transfer, barge-in and
  cross-talk handling, glossaries that learn from `/correct`, literal/natural/cultural modes, confidence flags
  with "say that again?", `/whisper` private translation, a post-call multilingual summary with action items,
  and an analytics dashboard.
* **Safety**: a visible notice when the bot joins, `/optout`, no audio stored, and cloning only for users who
  opt in. See [docs/POLICY.md](docs/POLICY.md).

```
edge/      TypeScript: discord.js + @discordjs/voice (DAVE), captions, commands, playout, web companion
worker/    Python: VAD/STT/LID/MT/TTS pipeline, provider router, hardware tiers, voice profiles
config/    worker config.yaml
docs/      ARCHITECTURE · RISKS · LANGUAGES · DEPLOY · POLICY · TESTING · PHASES · LICENSES
```

## Quick start (cloud VM with Docker)

```bash
cp .env.example .env     # set DISCORD_TOKEN, DISCORD_CLIENT_ID, DEV_GUILD_ID, WORKER_TOKEN, PUBLIC_URL
# CPU server
docker compose --profile init-cpu run --rm models-init
docker compose --profile cpu up -d --build
# …or NVIDIA GPU server
docker compose --profile init-gpu run --rm models-init-gpu
docker compose --profile gpu up -d --build
```
Then, in Discord, join a voice channel and run `/translate start`. The full guide, including the invite link,
HTTPS and the Phase 0 checks, is in [docs/DEPLOY.md](docs/DEPLOY.md).

**Before relying on it, run the Phase 0 DAVE spike** (`edge/src/dave-spike.ts`, DEPLOY.md §6). Receiving
end-to-end-encrypted voice works in `@discordjs/voice` 0.19.2, but an open upstream bug can drop packets during
key changes. The bot detects this and recovers, but you need to measure it on your own server.

## Commands

| Command | What it does |
|---|---|
| `/translate start [captions] [dub]` · `stop` · `status` | join your voice channel / leave and post the summary / pipeline health and latency |
| `/mylang speak:<auto\|lang> hear:<lang>` | your spoken language (auto-detect by default) and the language you want |
| `/listen [lang]` | your personal translated audio and captions in the browser |
| `/optout` · `/optin` | stop or allow processing of your voice, everywhere, instantly |
| `/voice enroll` · `delete` · `status` | create, delete or check a consented voice profile for cloned-voice dubbing |
| `/glossary add\|remove\|list`, `/correct`, right-click a caption → *Correct translation* | teach names and terms; small corrections are learned |
| `/whisper on\|off`, `/whisper send to: text:` | DM live translations to yourself / send someone a privately translated message |
| `/summary [lang]` | summary and action items so far |
| `/languages [code]` | which languages get cloned voice, standard voice or captions, and why |
| `/settings view\|set` (Manage Server) | caption languages, dub language, mode, voice, mirrors, summaries, expected languages |
| `/dashboard` (Manage Server) | analytics link |

## Status

All six phases (spike through analytics) are implemented, with 71 automated tests passing. Those tests include
end-to-end runs through the real worker process and recovery after the worker is killed mid-session.
**This environment had no access to Discord or to the real models**, so those two layers still need the Phase 0
checks. [docs/TESTING.md](docs/TESTING.md) lists exactly what was and wasn't verified.
