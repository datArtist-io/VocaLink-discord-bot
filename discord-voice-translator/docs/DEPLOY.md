# Deploying on Railway

VocaLink needs one Railway service: the `edge` Discord bot. Recognition, translation and speech run at Soniox and ElevenLabs, so there is no GPU and no Python worker. The self-hosted alternative is in [self-hosted/DEPLOY.md](self-hosted/DEPLOY.md).

## 1. Service settings

| Setting | Value |
|---|---|
| Source | this GitHub repository, branch `main` (Railway redeploys on every push) |
| Root directory | `discord-voice-translator/edge` (builds with `edge/Dockerfile`) |
| Region | Southeast Asia (Singapore), closest to Filipino users and Discord's Asian voice servers |
| Networking | generate a public domain; the personal translator is served from it |
| Volume | mount one at `/data` so settings, preferences and voice choices survive redeploys |

## 2. Variables

Set these in the service's Variables tab. `.env.example` has the same list.

| Variable | Value |
|---|---|
| `DISCORD_TOKEN` | bot token, from the Discord Developer Portal under your app → Bot |
| `DISCORD_CLIENT_ID` | the application ID |
| `PIPELINE` | `cloud` |
| `SONIOX_API_KEY` | from the Soniox console |
| `ELEVENLABS_API_KEY` | from ElevenLabs → Developers → API keys, with Text to Speech access (and Voices access for cloning) |
| `PUBLIC_URL` | the Railway domain, for example `https://vocalink-production.up.railway.app` |
| `WEB_SECRET` | any long random string; keeps personal translator links valid across restarts |

Optional:

| Variable | Default | Use |
|---|---|---|
| `DEV_GUILD_ID` | none | registers commands instantly in one test server |
| `ELEVENLABS_CONCURRENCY` | `3` | how many speech requests run at once; set it to your ElevenLabs plan's limit (2 on the free plan) |
| `DEFAULT_SPOKEN_LANGS` | `tl,en` | languages a new server starts with |
| `PRIVACY_URL` | none | link shown in the notice the bot posts when it starts |
| `DB_PATH` | `/data/edge.sqlite` | where settings are stored |

Remove `WORKER_URLS` if it is set; it switches the bot to the self-hosted pipeline.

## 3. Inviting the bot

In the Developer Portal, open OAuth2 → URL Generator, tick `bot` and `applications.commands`, and give it Connect, Speak, Send Messages, Create Public Threads, Send Messages in Threads and Embed Links. Open the generated link to add the bot to a server.

## 4. First run in Discord

1. An admin runs `/setup` and picks the server's languages (up to three), whether the channel gets a spoken translation, and whether captions are posted.
2. Someone joins a voice channel and runs `/translate start`.
3. Each person taps **Open my translator** in the message the bot posts, or runs `/listen`, and picks their language and volume.

## 5. Quiet speakers

The bot boosts quiet voices automatically, up to six times. Discord only sends someone's audio while their own app thinks they are speaking, so a very quiet person should set User Settings → Voice & Video → Input Sensitivity to manual and lower the slider. If the ends of their words get cut off, switch noise suppression from Krisp to Standard.

## 6. Checking a deployment

The deploy logs show `discord ready` once the bot has logged in. `/healthz?live=1` on the public domain returns 200 while the process is up. To measure latency on the server itself, set `BENCH=1` for one deploy; the results appear in the logs, and you then remove the variable.
