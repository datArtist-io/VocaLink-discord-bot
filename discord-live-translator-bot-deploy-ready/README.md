# Discord Live Translator Bot

Joins a voice channel, transcribes each speaker individually, auto-detects
their language, translates into any language you choose, and posts live
captions to a text channel. Optionally also speaks the translation aloud
into the channel — in each speaker's own cloned voice, if they've enrolled it.

## Voice cloning requires consent — this is enforced, not optional

Only a person's own voice can ever be cloned, and only by that person
running `/translate enroll-voice` themselves with `consent: true`. There is
no way to enroll someone else's voice from this bot. Speakers who haven't
enrolled still get dubbed (via a generic stock voice, not a clone of
anyone), so the group experience works either way — cloning is opt-in on
top of that. This isn't just a design choice: cloning a real person's voice
without their consent violates ElevenLabs' own usage policy (they can
suspend accounts and report abuse) and is illegal in a growing number of
places — Tennessee's ELVIS Act and California's AB 1836/AB 2602 specifically
target unauthorized voice cloning. Don't build around this gate.

## What it needs

- Node.js 22.12+ (required for current DAVE/E2EE support in `@discordjs/voice`)
- A Discord bot application (free)
- A Deepgram API key (free credit to start)
- An Anthropic API key
- An ElevenLabs API key — only needed if you want spoken dubbing/cloning;
  captions-only mode works without it

## A note on Discord's end-to-end encryption (DAVE)

Since March 2026, Discord requires end-to-end encryption (the DAVE protocol)
on every voice call, bots included — there's no opting out. This doesn't
change anything you need to write: `@discordjs/voice` (v0.19+) handles DAVE
negotiation and decryption itself via `@snazzah/davey`, which is in
`package.json` here. As long as that dependency installs correctly,
`receiver.subscribe()` in `src/index.js` keeps receiving already-decrypted
Opus, same as before. If audio capture silently stops working after a
Discord update, check that `@snazzah/davey` installed and is a recent
version first — that's the most likely culprit.

## Setup

1. **Create the bot**
   Go to https://discord.com/developers/applications → New Application.
   - Under **Bot**: click Reset Token, copy it → this is `DISCORD_TOKEN`.
   - Under **Bot**, turn on nothing extra for now — this bot doesn't need
     privileged message content, just voice.
   - Under **General Information**, copy the Application ID → this is
     `DISCORD_CLIENT_ID`.

2. **Invite it to your server**
   In the Developer Portal, go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `Connect`, `Speak`, `View Channels`, `Send Messages`,
     `Embed Links`
   Open the generated URL and add the bot to your test server.

3. **Install dependencies**
   ```bash
   npm install
   ```

4. **Fill in your keys**
   ```bash
   cp .env.example .env
   ```
   Then open `.env` and paste in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`,
   `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`.

5. **Register the slash command** (once, and again any time you edit
   `src/deploy-commands.js`)
   ```bash
   npm run deploy-commands
   ```

6. **Run it**
   ```bash
   npm start
   ```

7. **Use it**
   - `/translate enroll-voice sample:<your voice memo> consent:true` — optional,
     lets people opt their own voice in for cloned dubbing. 30-60 seconds of
     clean, single-speaker audio works best.
   - `/translate voices` — see who's enrolled in this server.
   - Join a voice channel, then `/translate start target:Spanish dub:true`
     (both `target` and `dub` are optional — defaults are English, dub off).
     Speak — captions appear within a couple seconds of you pausing, and if
     `dub` is on, a spoken translation follows (in the speaker's cloned voice
     if they've enrolled, otherwise a generic voice).
   - `/translate stop` ends the session.

   Since the bot can only be in one voice channel per server at a time, dub
   audio plays into the same channel everyone's already in — including you.
   Heads up: you'll hear the original speaker, then a few seconds later the
   bot's dub, possibly overlapping the next thing they say. There's no way
   around that with a single shared channel; a cleaner (but more involved)
   setup uses a second bot account in a paired channel just for listeners
   who want the dub — worth doing once this MVP proves out.

## How it captures audio

Discord gives the bot each speaking user's audio as a separate stream — no
guessing who's talking. For each user, the bot waits for ~0.7s of silence to
mark the end of an "utterance," bundles that chunk of audio into a WAV file,
and sends it to Deepgram's transcription endpoint in one shot. This is
simpler and more robust than juggling a live streaming connection per
speaker, at the cost of the ~0.7s silence delay before you see a caption.

## Running it 24/7

For actual testing with friends beyond your own machine, deploy this to a
small always-on host:
- **Railway** or **Fly.io** — easiest, free/cheap tiers, just push the repo
- A **$5/mo VPS** (Hetzner, DigitalOcean) with `pm2` or Docker to keep it alive

Locally (`npm start` in a terminal) works fine for testing with friends while
you're online, but the bot goes offline the moment you close your laptop.

## Known limits of this MVP

- Multiple people talking at once are each transcribed independently and
  posted/spoken in whatever order they finish — no attempt at conversation
  ordering, and overlapping dubs will sound messy.
- No cost/usage caps yet — Deepgram + Claude + ElevenLabs usage all scale
  with how much people talk, and cloned-voice TTS costs more than captions
  alone. Fine for a friends server, worth adding before wider use.
- No persistence for session settings — target language/dub toggle reset if
  the bot restarts (enrolled voices in `data/voices.json` do persist).
- Dub audio and the live speaker share one channel (see the overlap note
  above) — there's no per-listener private audio yet.

## Next step: a private/paired listening channel

The overlap you get from dubbing into the same live channel is the main
rough edge left. The fix is a second bot account joined to a channel only
interested listeners sit in, playing just the dubbed audio — the original
conversation in the main channel stays clean, and listeners who want the
dub simply move to the paired channel. Worth building once you've tested
the current setup with real usage and know it's worth the extra bot setup.
