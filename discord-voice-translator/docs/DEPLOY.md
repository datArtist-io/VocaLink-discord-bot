# Deploying to the cloud

You need: a Linux VM, Docker + Compose v2, a domain (for HTTPS on the web companion), and a Discord
application. No paid API keys.

## 1. Pick a server

| Use | VM | Notes |
|---|---|---|
| Captions-first, small server | 4–8 vCPU, 8–16 GB RAM (any VPS) | CPU tier: `small` Whisper, ~1.5–2.5 s, 1–3 simultaneous speakers |
| Dubbing, < 5 simultaneous speakers | 1× NVIDIA **L4 / A10G / T4 16 GB** (AWS g6/g5/g4dn, GCP g2, Azure NV, RunPod, Lambda…) | gpu8 tier: `large-v3-turbo`, cloning on |
| Best quality / many speakers | 1× 24 GB+ (L4 24 GB counts, A10G 24 GB, RTX 4090/A5000, A100) | gpu24 tier: `large-v3`, NLLB-3.3B |

Disk: 15 GB (CPU) to 40 GB (GPU with cloning + MMS + an 8B LLM). Open **no inbound ports** except 443 for the
web companion; the worker port (7700) stays on the Docker network.

GPU hosts need the NVIDIA driver and `nvidia-container-toolkit` (`docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi` must work).

## 2. Create the Discord application

1. <https://discord.com/developers/applications> → **New Application** → *Bot* → **Reset Token** → copy into `DISCORD_TOKEN`.
   Copy the **Application ID** into `DISCORD_CLIENT_ID`.
2. No privileged intents are needed (the bot uses slash commands, `Guilds` and `GuildVoiceStates`).
3. Invite URL (replace the client id):
   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=309274414080
   ```
   = View Channels, Send Messages, Read Message History, Create Public Threads, Send Messages in Threads,
   Connect, Speak, Use Voice Activity. Add **Manage Channels** (`permissions=309274414096`) only if you use
   mirror channels.
4. Mirror channels (optional): create one more application per mirror language, name them clearly
   (e.g. "Translator · French mirror"), invite each with `scope=bot&permissions=36701184` (View Channels, Connect, Speak, Use Voice Activity), and put their tokens
   in `MIRROR_BOT_TOKENS`.

## 3. Configure

```bash
git clone <your repo> translator && cd translator     # or unzip the delivered archive
cp .env.example .env
openssl rand -base64 32        # -> WORKER_TOKEN
# edit .env: DISCORD_TOKEN, DISCORD_CLIENT_ID, DEV_GUILD_ID (your test server), WORKER_TOKEN, PUBLIC_URL
```
Voice cloning (GPU only, optional): generate a key and put it in `VOICE_PROFILE_KEY` — **back it up**; losing it
makes existing voice profiles unreadable (users simply re-enroll).
```bash
docker compose --profile gpu run --rm worker-gpu python -m translator_worker --gen-voice-key
```

## 4. Download models and start

CPU server:
```bash
docker compose --profile init-cpu run --rm models-init      # ~3–6 GB, once
docker compose --profile cpu up -d --build
```
GPU server:
```bash
docker compose --profile init-gpu run --rm models-init-gpu  # ~10–20 GB, once
docker compose --profile gpu up -d --build
```
Optional local LLM (natural/cultural modes, Pidgin output, real summaries) — set in `.env`
`LLM_BASE_URL=http://ollama:11434/v1` and `LLM_MODEL=llama3.1:8b`, then:
```bash
docker compose --profile gpu --profile llm up -d
docker compose exec ollama ollama pull llama3.1:8b
docker compose restart worker-gpu
```
Check:
```bash
docker compose logs -f edge          # "discord ready", "worker ready", "slash commands registered"
docker compose exec worker python -m translator_worker --languages | head -40   # (worker-gpu on GPU)
curl -s localhost:8080/healthz
```

## 5. HTTPS for the companion and dashboard

The edge listens on `127.0.0.1:8080`. Put Caddy in front (automatic certificates):
```
# /etc/caddy/Caddyfile
translate.example.com {
    reverse_proxy 127.0.0.1:8080
    @metrics path /metrics
    respond @metrics 404          # keep Prometheus metrics private
}
```
Set `PUBLIC_URL=https://translate.example.com`. WebSockets pass through Caddy unchanged.

## 6. Phase 0 gates (do these before inviting real users)

1. **DAVE receive spike** — on the server:
   ```bash
   mkdir -p spike-out && chmod 777 spike-out
   docker compose run --rm -v "$PWD/spike-out:/app/spike-out" \
     -e SPIKE_GUILD_ID=... -e SPIKE_CHANNEL_ID=... edge node dist/dave-spike.js
   ```
   Talk with 2+ people, have someone leave/re-join mid-sentence, then read the JSON report and listen to the
   per-user WAVs in `./spike-out/`. PASS = clear audio, overall loss < 5 %,
   transition loss < 20 %. If it fails, stop and report the numbers (likely upstream issue #11441).
2. **Benchmark** — put ~10 clips per language under `./clips/<lang>/` and run:
   ```bash
   docker compose run --rm -v $PWD/clips:/clips worker-gpu python scripts/bench.py --clips /clips --targets en,fr
   ```
   It prints per-language LID accuracy, WER and p50/p90 latencies, and the estimated end-of-speech → first-audio time.
3. In your test server: `/translate start`, talk, check captions, `/translate status`, `/listen`, `/dashboard`.

## 7. Scaling

* More speakers → more workers: run several worker containers (one per GPU), list them in
  `WORKER_URLS=gpu1:7700,gpu2:7700`. Guilds are spread by rendezvous hashing and fail over automatically.
* More than ~2,500 servers → `npm run start:sharded` in the edge (`SHARD_COUNT=auto`); each shard serves the
  web companion on `WEB_PORT + shard_id` (route per shard at the proxy, or run one shard per host).
* Postgres/Redis are not needed at this size (SQLite holds settings, consent, glossary and text-free analytics).

## 8. Operations

* Updates: `git pull && docker compose --profile gpu up -d --build`.
* Backups: the `edgedata` volume (settings, glossary, consent records) and the `workerdata` volume
  (encrypted voice profiles) + your `VOICE_PROFILE_KEY`.
* Monitoring: `/healthz` (503 when no worker is reachable; `?live=1` for liveness), `/metrics` (Prometheus),
  `/dashboard` (per-stage p50/p90, tiers, providers, DAVE rejoins), worker health on `:7701`.
* Logs are JSON lines; no transcript text is logged.
