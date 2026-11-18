# Architecture

This describes the cloud pipeline that VocaLink runs in production. The older self-hosted pipeline (Whisper, NLLB and Piper on your own GPU) is documented in [self-hosted/ARCHITECTURE.md](self-hosted/ARCHITECTURE.md); the bot still supports it with `PIPELINE=worker`.

## Overview

```
Discord voice channel (one encrypted Opus stream per speaker)
        │
┌───────▼───────────────────────────────────────────────────────────────┐
│ edge (Node.js)                                                        │
│                                                                       │
│  DiscordVoiceLink   joins the channel, receives audio, reconnects     │
│  GuildSession       one per call: speakers, captions, dub routing     │
│  CloudWorker        per speaker: gain control, pitch, Soniox lanes,   │
│                     phrase timing, ElevenLabs speech                  │
│  WebHub / WebServer personal translator for each listener             │
│  Store (SQLite)     server settings, user preferences, consent        │
└──────┬──────────────────────┬─────────────────────────┬───────────────┘
       │ WebSocket             │ HTTPS                    │ WebSocket
       ▼                       ▼                          ▼
   Soniox real-time        ElevenLabs TTS           listeners' browsers
   (speech to text +       (streamed PCM)           (one player each)
    translation)
```

The bot is one Node.js process. There is no separate worker in cloud mode, so a single small Railway service runs everything.

## The path of one phrase

1. **Receive.** `DiscordVoiceLink` gets each speaker's Opus packets (decrypted with DAVE) and decodes them to 16 kHz mono PCM in 20 ms frames. `UserStream` fills short gaps with silence so timing stays real.
2. **Prepare.** `CloudWorker` raises quiet speakers with automatic gain control (`audio/Agc.ts`, up to 6×) and measures the speaker's pitch (`audio/Pitch.ts`) to choose a matching voice later.
3. **Recognise and translate.** Each speaker gets one Soniox WebSocket per server language, called a lane. A lane translates whatever is spoken into its own language, so a server with English and French understands Tagalog, Spanish or anything else. Words that are already in the lane's language pass through unchanged, which keeps Taglish sentences whole.
4. **Speak.** Soniox sends each translated phrase complete, and the bot sends it to ElevenLabs straight away instead of waiting for the end of the sentence. Requests share a concurrency gate sized to the ElevenLabs plan; a request that stalls is retried once and abandoned after a few seconds.
5. **Deliver.** The audio goes to the channel (if a channel voice is set) and to every personal translator whose language matches, except the speaker's own.
6. **Caption.** The first lane drives captions. Other languages are matched to the same sentence by when the words were spoken, using one audio clock per speaker, so captions never pair a translation with the wrong sentence.

## Who hears what

A Discord bot has one audio output per channel, so everyone in the channel hears the same thing. VocaLink gives each person a private output instead.

| Output | Who it's for | What plays |
|---|---|---|
| Personal translator | Each listener, opened from Discord | Everyone else, in that listener's language |
| Channel voice (optional) | Everyone in the channel | Speech in other languages, spoken in the group's main language |
| Captions | Everyone in the text channel | The original and each server language |

The personal translator (`web/static/listen.html`) buffers each phrase for about 150 ms, then plays phrases one at a time in the order they started. It lowers translations to 30% while the listener is talking and skips anything that would start more than 8 seconds late.

## Settings and storage

Server settings and user preferences live in SQLite at `DB_PATH` (default `/data/edge.sqlite`, on a Railway volume). Audio is never written to disk.

| Setting | Where it is changed |
|---|---|
| Server languages (up to 3), channel voice, captions | `/setup` |
| A listener's language and volume | the personal translator panel in Discord |
| How a speaker sounds (own voice, a picked voice, or automatic) | the personal translator panel |
| Opt out | `/optout`, `/optin` |

## Reliability

- Soniox connections back off when they fail (up to 30 s, or 60 s for authentication errors), so a bad key cannot cause a reconnect storm.
- A graceful close lets Soniox finish the last words before the socket is replaced.
- If the voice connection drops, the bot rejoins up to five times; if that fails, the session ends cleanly.
- Player links are signed with `WEB_SECRET` and keep working across restarts. Players refresh themselves after a deployment, but never while audio is playing.

## Measured latency

Measured on Railway in Singapore with a recorded Taglish clip played at real speed:

| Stage | Time |
|---|---|
| Phrase ends → translated text from Soniox | about 0.95 to 1.15 s |
| Text → first audio from ElevenLabs | about 0.12 s |
| Player buffer | about 0.15 s |

The benchmark lives in `edge/src/bench.ts` and runs on the server when `BENCH=1` is set. [history/design-v2.md](history/design-v2.md) has the design notes and the provider comparison that led to this pipeline.
