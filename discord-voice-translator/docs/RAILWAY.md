# Running VocaLink on Railway (fast cloud pipeline)

The fast pipeline needs only **one Railway service**: the `edge` Discord bot. Speech
recognition, translation and voice run at Soniox and ElevenLabs, so no GPU and no Python
worker are needed.

## 1. Service settings
* **Source:** this GitHub repo.
* **Root directory:** `discord-voice-translator/edge` (it builds with `edge/Dockerfile`).
* **Region:** *Southeast Asia (Singapore)*. This is closest to Filipino users and Discord's Asia
  voice servers. Settings → Deploy → Region.
* **Networking:** Generate a domain if you want the `/listen` web companion, and put that URL in
  `PUBLIC_URL`.
* **Volume (optional):** mount one at `/data` so server settings survive redeploys.

## 2. Variables
Add these under the service's **Variables** tab (see `../.env.example`):

| Variable | Value |
|---|---|
| `DISCORD_TOKEN` | Bot token (Discord Developer Portal → your app → Bot) |
| `DISCORD_CLIENT_ID` | Application ID |
| `DEV_GUILD_ID` | Your test server ID (optional; registers commands instantly there) |
| `PIPELINE` | `cloud` |
| `SONIOX_API_KEY` | Soniox console → API keys |
| `ELEVENLABS_API_KEY` | ElevenLabs → Developers → API keys (needs **Text to Speech** permission) |
| `PUBLIC_URL` | The Railway domain, e.g. `https://vocalink-production.up.railway.app` |

Remove `WORKER_URLS` if it is set. Railway redeploys automatically after you save.

## 3. In Discord
1. Join a voice channel.
2. `/settings set captions:en,tl`: captions in English and Tagalog.
3. `/translate start dub:en`: captions plus an English voice in the channel
   (`dub:tl` for a Tagalog voice). Each person can also open `/listen` for their own language.

The two languages a server uses (for example Tagalog and English) are translated both ways in
one stream. Up to two languages per server are supported in this version.

## 4. Picking up quiet voices
The bot boosts quiet speakers automatically (up to 6×). Discord only sends a person's audio
while *their* Discord app detects speech, so ask quiet speakers to set
**User Settings → Voice & Video → Input Sensitivity** to manual and slide it lower, and to use
**Standard** noise suppression instead of Krisp if their words get cut off.
