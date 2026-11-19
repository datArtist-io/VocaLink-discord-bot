<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-dark.png">
    <img alt="VocaLink" src="docs/brand/logo-light.png" height="64">
  </picture>
</p>

Live voice translation for Discord. People in a voice channel speak whatever language they like, and everyone hears the others in their own language, about a second behind the speaker.

VocaLink was built for mixed Filipino and English groups first, so Tagalog, English and Taglish (both in one sentence) are handled as normal speech. Any other language works too.

## How it works

```
Discord voice channel
   │  each speaker's audio (Opus, end-to-end encrypted with DAVE)
   ▼
VocaLink bot (Node.js, runs on Railway in Singapore)
   │  16 kHz audio per speaker, boosted if the speaker is quiet
   ├──► Soniox real-time: speech to text and translation, one stream per target language
   │        translated phrases arrive as they are spoken
   ├──► ElevenLabs: each phrase is spoken in a voice matched to the speaker
   ▼
Personal translator (web player, one per listener)
   each person hears everyone else in their chosen language, never their own voice
```

1. When someone talks, the bot sends their audio to Soniox, which recognises it and translates it into each language the server uses. Translations come back phrase by phrase while the person is still talking.
2. Each translated phrase goes to ElevenLabs and is spoken in a voice matched to the speaker's pitch. A speaker can also choose a voice, or use a clone of their own voice once they consent.
3. Each listener opens their personal translator from Discord. It plays only the translations into their language, skips their own speech, and gets quieter while they are talking.
4. Live captions appear in a Discord thread, with the original and each translation.

Measured on the production setup, a translated phrase reaches the listener about 1.2 seconds after the speaker finishes it: around 0.95 s for recognition and translation, 0.12 s for the first sound of the voice, and the rest for delivery.

## Using it in Discord

| Command | What it does |
|---|---|
| `/translate start` | Starts translating the voice channel you are in. |
| `/translate stop` | Stops translating. |
| `/setup` | Server admins pick up to three server languages, the channel voice and captions. |
| `/listen` | Opens your personal translator: pick your language, volume and how others hear you. |
| `/optout`, `/optin` | Stop or allow processing of your voice, in every server, immediately. |
| `/plan` | Shows the server's plan and hours left this month, with Discord's buttons to upgrade. |

The usual flow is: an admin runs `/setup` once, someone runs `/translate start`, and each person taps **Open my translator**.

## Running your own copy

You need a Discord application with a bot token, a [Soniox](https://soniox.com) API key and an [ElevenLabs](https://elevenlabs.io) API key.

```bash
cd discord-voice-translator/edge
npm install
cp ../.env.example .env   # fill in the tokens and keys
npm run dev
```

The production deployment runs the same code on Railway. [docs/DEPLOY.md](discord-voice-translator/docs/DEPLOY.md) has the settings, environment variables and the persistent volume it needs.

To run the checks:

```bash
cd discord-voice-translator/edge
npm run typecheck
npm test
```

## Repository layout

```
discord-voice-translator/
  edge/        the Discord bot (TypeScript): voice, captions, commands, translation pipeline, web player
    src/worker/CloudWorker.ts   Soniox and ElevenLabs pipeline
    src/voice/                  Discord voice connection and per-call session
    src/web/                    personal translator (web player) and its server
    src/discord/                slash commands, /setup panel, captions
    test/                       automated tests
  worker/      optional self-hosted pipeline (Python): Whisper, NLLB, Piper; needs a GPU to be fast
  bench/       short audio clips used to measure latency
  docs/        architecture, deployment and privacy
```

## Documentation

- [Architecture](discord-voice-translator/docs/ARCHITECTURE.md): the pipeline in detail and the design decisions behind it.
- [Deploying on Railway](discord-voice-translator/docs/DEPLOY.md)
- [The product](discord-voice-translator/docs/PRODUCT.md): the website, plans, Discord shop payments and how they connect.
- [Privacy and data](discord-voice-translator/docs/PRIVACY.md)
- [Self-hosted pipeline](discord-voice-translator/docs/self-hosted/ARCHITECTURE.md): the original design with open-source models.

## Status

VocaLink is in active development and tested in real calls. Voice cloning needs an ElevenLabs plan that includes it.
