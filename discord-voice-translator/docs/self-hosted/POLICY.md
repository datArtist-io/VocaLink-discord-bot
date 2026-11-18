# Safety, privacy and Discord policy

Not legal advice — have a lawyer review before running this publicly, especially voice cloning.

## What the bot does with data

| Data | Stored? | Where / how long | User control |
|---|---|---|---|
| Call audio | **Never** (`policy.store_audio: false`) | processed in RAM only | `/optout` stops processing at the edge — audio is not even decoded |
| Live transcript | RAM only, while the session runs, if summaries are on | worker memory; cleared after the summary | server setting `summaries:false` |
| Captions | as Discord messages in the caption thread | Discord | server admins manage the channel |
| Caption index (for `/correct`) | message id, speaker id, original + translations | edge SQLite, **24 h** | — |
| Analytics | **no text**: languages, tiers, latencies, flags | edge SQLite, **30 days** | — |
| Settings, glossary, `/mylang` prefs | yes | edge SQLite | `/glossary remove`, `/mylang` |
| Voice profile (cloning) | encrypted reference audio (~10 s) | worker volume, AES-256-GCM, keyed-hash filename, until deleted | `/voice delete` (immediate overwrite + unlink) |
| Consent record | version, timestamp, phrase | edge SQLite | removed by `/voice delete` |

Nothing is used to train models, by this bot or by any provider it calls in local mode. If you enable cloud
plug-ins, audio/text goes to that vendor under its terms — say so in your privacy policy.

## Built-in safeguards

* **Visible notice** every time translation starts: who is processed, that audio isn't stored, how to opt out,
  link to your privacy policy (`PRIVACY_URL`).
* **`/optout`** is global and instant: the edge never subscribes to that user's stream.
* **Cloning is opt-in twice**: the speaker enrolls themselves (consent screen + live random phrase verified by
  speech recognition, so nobody can upload someone else's recording), *and* the server admin sets `voice: clone`.
  Without a `VOICE_PROFILE_KEY`, cloning is disabled. Cloned dubs are marked 🗣️ and watermarked by Chatterbox.
* Bots and the bot itself are never translated. `@everyone` / mentions are neutralised in captions.
* Web links are HMAC-signed, scoped (`listen` vs `admin`), expiring, served with `Referrer-Policy: no-referrer`
  and a strict nonce-based CSP.

## Discord Developer Policy — flags in this design

1. **Mirror channels need extra bots.** Use only separate, clearly named bot *applications* you own, invited by
   the server admin. **Never user accounts** (self-bots violate Discord's Terms). Don't present mirror bots as
   anything other than what they are (Developer Policy: no impersonation/deception).
2. **API limits.** "You agree to, and will not attempt to circumvent, such limitations." The caption writer stays
   under per-channel rate limits by design; mirror bots must not be used to dodge limits on servers you don't run.
3. **No training on API data** (Developer Policy §21). This bot doesn't. Keep it that way if you add analytics.
4. **Privacy policy required.** Your bot processes voice — publish a privacy policy describing the table above
   and link it via `PRIVACY_URL` and the Developer Portal.
5. **Voice cloning and impersonation.** Discord's rules prohibit impersonation; the self-enrollment + live phrase
   flow and labelling are there to prevent it. Do not add an "upload a voice sample" feature.
6. **Minors.** Discord's minimum age varies by country; biometric (voice) processing of minors needs extra care —
   consider disabling cloning in servers with younger members.

## Privacy policy starter (edit before use)

> **Live Translation Bot — Privacy.** When translation is active in a voice channel, the bot processes the
> speech of participants who have not opted out to produce captions, translations and synthetic speech. Audio
> is processed in memory and never stored. Captions are posted to the server's caption thread. A temporary
> in-memory transcript is used to produce an optional end-of-call summary and then discarded. We store,
> without any speech content, language and latency statistics for 30 days, and a caption index for 24 hours to
> allow corrections. If you create a voice profile, we store an encrypted ~10-second recording that you made
> for that purpose until you run `/voice delete`. We do not sell data or use it to train models. Type `/optout`
> at any time to stop all processing of your voice. Contact: …
