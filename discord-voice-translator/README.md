# discord-voice-translator

The source for the VocaLink Discord bot. The [repository README](../README.md) explains what VocaLink does and how to use it; this page covers the code.

## Folders

| Folder | What is in it |
|---|---|
| `edge/` | The bot (TypeScript, Node.js 22). Joins voice channels, runs the Soniox and ElevenLabs pipeline, posts captions, serves the personal translator. This is what runs in production. |
| `worker/` | The optional self-hosted pipeline (Python): Silero VAD, faster-whisper, NLLB-200 and Piper. Used when `PIPELINE=worker`. |
| `config/` | Settings for the self-hosted worker. |
| `bench/` | Short recorded clips for latency tests. |
| `docs/` | Architecture, deployment, privacy, and the self-hosted docs. |

## Working on the bot

```bash
cd edge
npm install
cp ../.env.example .env   # add your Discord token and the Soniox and ElevenLabs keys
npm run dev               # runs src/main.ts with .env loaded
```

Before pushing, run the type check and the tests:

```bash
npm run typecheck
npm test
```

The tests cover translation routing (who hears which language), Taglish captions, gain control, the ElevenLabs concurrency limit, matching captions across languages, voice cloning consent and deletion, settings storage, the web server and the self-hosted worker path. They need no real keys and no Discord connection.

## Main files in `edge/src`

| File | Role |
|---|---|
| `main.ts` | Startup: config, Discord client, web server, slash command registration. |
| `config.ts` | Reads environment variables. |
| `worker/CloudWorker.ts` | Per-speaker Soniox lanes, phrase timing, ElevenLabs speech. |
| `worker/VoiceBank.ts` | Picked voices and consented voice cloning. |
| `audio/Agc.ts`, `audio/Pitch.ts` | Gain control for quiet speakers and pitch tracking for voice matching. |
| `voice/DiscordVoiceLink.ts` | Voice connection, receiving audio, reconnecting. |
| `voice/GuildSession.ts` | One call: who is speaking, captions, where each translation goes. |
| `discord/commands.ts`, `discord/setupPanel.ts` | Slash commands and the `/setup` panel. |
| `web/server.ts`, `web/hub.ts`, `web/static/listen.html` | The personal translator and the server that feeds it. |
| `store/Store.ts` | SQLite storage for settings and preferences. |

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Deploying on Railway](docs/DEPLOY.md)
- [Privacy and data](docs/PRIVACY.md)
- [Self-hosted pipeline](docs/self-hosted/ARCHITECTURE.md), with its own [deploy guide](docs/self-hosted/DEPLOY.md), [language notes](docs/self-hosted/LANGUAGES.md) and [model licences](docs/self-hosted/LICENSES.md)
