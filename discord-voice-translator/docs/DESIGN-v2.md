# VocaLink v2: system design (draft for discussion)

Status: **draft, nothing built yet.** Decisions marked ✅ are agreed. Items marked 🔬 must be proven by the
Phase 0 benchmark before we commit to them.

## 1. Goal and rules

Anyone who talks in a Discord voice channel is heard by every other person **in that person's own
language, as speech, with the lowest latency we can achieve**. Filipino (Tagalog and Taglish) is the first
priority. The product must be sellable.

Design rules:

1. **Latency first.** Any part that adds latency without a clear reason gets cut.
2. **Stream everything.** No stage waits for a whole sentence if it can start on a partial one.
3. **Fewest hops.** Every process boundary, queue and model hand-off has to justify itself.
4. **Measure, don't estimate.** Every number in this doc is a target until the benchmark measures it.
5. **Only use components we're allowed to sell.** No non-commercial model licences in the product.

## 2. Decisions so far

| | Decision |
|---|---|
| ✅ Listening | **Per-person companion**: a Discord Activity (falling back to a web page), where each listener hears their own language |
| ✅ Hosting | **Cloud streaming APIs for v1** for speech recognition, translation and the Filipino voice; self-host later where it improves margins |
| ✅ Voice | **Kokoro** (open source, Apache-2.0, very fast) for the languages it covers (English, Spanish, French, Japanese, Chinese, Hindi, Italian, Portuguese). Kokoro has **no Filipino voice**, so Filipino output uses a cloud voice |
| ✅ Region | Run in **Singapore**, close to Filipino users and the vendors' Asia endpoints |

## 3. Why v1 was slow (what we're fixing)

| v1 | v2 |
|---|---|
| Whisper doesn't stream: it re-decodes the growing clip every 0.5 s | A **streaming** speech-recognition API that returns words as they're spoken |
| Waits for 0.5 s of silence before anything is final | Translates at **clause boundaries** while the person is still talking |
| 4 separate model steps (speech-to-text → language ID → translation → voice) in a Python worker behind a TCP hop | Speech-to-text and translation in **one stream**; the Python worker is **off the hot path** |
| Per-speaker language lock (breaks on Taglish) | **Per-word language tags**; no locking |
| Filipino: "fair" accuracy, no voice, non-commercial licences | Filipino-capable streaming speech-to-text and a commercial Filipino voice |
| Cloning, mirrors, summaries and glossaries built before the core worked | **v1 scope = the core path only** (§9) |

## 4. Architecture

```
 Discord voice channel (DAVE-encrypted, one Opus stream per speaker)
        │
┌───────▼──────────────────────────────────────────────────────────────┐
│ EDGE  (TypeScript, discord.js + @discordjs/voice) — Singapore        │
│                                                                      │
│  per speaker:  Opus → PCM 16 kHz ──WebSocket──► STT+Translate stream │──► cloud (e.g. Soniox)
│                                   ◄── words + lang tags + translation│
│                                                                      │
│  Segmenter: cuts the translated text into speakable clauses          │
│  Fan-out:   only into languages that a listener in the channel wants │
│                                                                      │
│  per (speaker, target language):  clause ──► streaming TTS ──► Opus  │──► Kokoro (local GPU)
│                                                                      │──► cloud voice (Filipino)
│  Listener hub: per-listener mix + captions                           │
└───────┬──────────────────────────────────────────────────────────────┘
        │ WebSocket (Opus frames + caption events), via Discord's Activity proxy
        ▼
 Discord Activity (each listener): plays their language, shows captions
```

What's kept from the current repo: the Discord voice layer (DAVE handling, auto-rejoin, per-user streams,
silence fill), consent/opt-out, the SQLite store, circuit breakers and the provider-interface idea. The
`/listen` web companion becomes the Activity.

What leaves the hot path: the Python worker, Whisper, NLLB/MADLAD, Piper, MMS, Chatterbox. The worker can
come back later as a self-hosted provider behind the same interface.

## 5. Per-utterance flow

1. Discord sends a 20 ms Opus packet → the edge decodes it to 16 kHz PCM and sends it straight to the speaker's
   speech-recognition stream. There is no VAD of our own; the vendor handles endpointing. 🔬 Check whether the
   vendor accepts raw Opus and lets us skip the decode.
2. Words come back **as they're spoken**, each with a language tag (`tl` / `en` / …) and a "final" flag.
3. **Translation.** Inside the same stream if the vendor supports our language pair. For any other listener
   language, a fast streaming text translator (LLM or MT API) runs on the final words. 🔬
4. **Segmenter.** Tagalog is verb-first and English is subject-first, so word-by-word translation produces
   nonsense. We wait for a *clause* (punctuation, a conjunction, or about 300 ms of pause) and then speak it.
   **This trade-off between waiting and making sense is the biggest latency lever, and we'll tune it on real
   audio.**
5. **Who needs it?** A listener who understands every language in the clause (e.g. a Filipino listener
   hearing Taglish) gets nothing extra and hears the original. Everyone else gets the translation.
6. **TTS.** One streaming voice per (speaker, target language). Audio starts after the first few words. Each
   speaker keeps a consistent house voice per language.
7. **Delivery.** The edge sends Opus frames to each listener's Activity over WebSocket with a small jitter
   buffer (60–80 ms). Captions travel on the same socket.

## 6. Latency budget (targets, measured as speaker's mouth → listener's ear)

| Stage | Target |
|---|---|
| Discord → edge (network + DAVE decrypt) | 60–100 ms |
| Edge → STT vendor (Singapore) | 20–40 ms |
| Word recognised as final | 300–500 ms |
| Wait for a speakable clause | 200–600 ms (depends on the sentence) |
| Translation of the clause (in stream / separate MT) | 50–150 ms / 150–300 ms |
| TTS first audio (Kokoro local / cloud Filipino) | 50–100 ms / 150–300 ms |
| Edge → Activity + jitter buffer | 80–120 ms |
| **Target: translated speech starts** | **≈ 1.0–1.5 s behind the speaker (p50), < 2 s (p90)** |

This is "behind the speaker", like a UN interpreter, not "after they stop talking". Anything above these
numbers in the benchmark is a defect to chase, not something we accept.

## 7. Filipino and Taglish

* Taglish is the normal case, not an edge case. We never lock a speaker to one language. We keep per-word tags
  and translate whole clauses, so mixed clauses are handled by a translator that sees both languages.
* Listener preference is a **set**: "I understand Tagalog and English" means Taglish isn't dubbed for them.
* Names, gaming terms and slang ("lods", "pare", in-game callouts) go through a per-server glossary that's
  passed to translation as context. This is cheap and comes later.
* 🔬 Candidates to compare on our own Taglish clips: **Soniox** (streaming STT + built-in translation, claims
  mid-sentence language switching) vs **Deepgram** (streaming Tagalog STT, no translation). Filipino voice:
  Soniox TTS, ElevenLabs, Azure `fil-PH` and Google `fil-PH`. All vendor accuracy claims are unverified until
  we test them.

## 8. Companion (Discord Activity)

* Launched from the voice channel, so there's no link to share, and it works on desktop and mobile.
* The listener picks the languages they understand and the language they want to hear, and gets per-speaker
  volume controls.
* **Known limit:** an Activity can't mute the original voices in Discord. The listener lowers the speakers'
  *User Volume* in Discord, or keeps both like simultaneous interpretation. We'll find the best UX in testing.
* A plain web page is kept as a fallback for servers that don't allow Activities.

## 9. v1 scope

**In:** voice receive, streaming STT + translation, segmenter, fan-out, Kokoro + cloud Filipino voice,
Activity with audio + captions, `/translate start|stop`, language settings, `/optout`, consent notice,
latency metrics.

**Later:** voice cloning, mirror channels, summaries, glossary learning, `/whisper`, self-hosted STT/MT.

## 10. Selling it

* **Cost scales with speaking minutes × target languages.** Fan-out only to languages someone is actually
  listening in. Translate once per language, not once per listener.
* Pricing: free tier (captions, limited minutes), then paid per server by monthly voice-minutes.
* Needed before public launch: a privacy policy that names our sub-processors (the STT/TTS vendors), a
  data-processing note, a visible join notice, and no audio storage. See POLICY.md; most of it carries over.
* Must comply with Discord's Developer Policy (no training on user audio) and get approval for the Activity.

## 11. Phase 0: benchmark before building

1. **Clips:** 10–20 short recordings each of Tagalog, Taglish, and English with a Filipino accent, from people
   who agreed to it, plus reference transcripts.
2. **Harness:** replays the clips in real time through each candidate stack and records per-stage timestamps
   and the total mouth→ear latency, plus accuracy (WER) and translation quality.
3. **DAVE check:** run the existing `dave-spike` on your server to measure packet loss. This is still an open
   upstream risk.
4. **Output:** a table of p50/p90 latency and accuracy per stack. We choose the stack from data, then build.

Needs from you: API keys for the candidate vendors (free tiers should be enough) and the clips.

## 11a. First measurements (18 Nov 2026, from a US cloud container, synthetic voice clips)

| Test | Result |
|---|---|
| ElevenLabs `eleven_flash_v2_5`, Filipino, time to first audio | 0.24 s warm (0.58 s cold) |
| Deepgram `nova-3` `language=tl`, whole-file transcription | exact transcript, 0.77 s for a 3 s clip |
| Soniox `stt-rt-v6` real-time + one-way translation → English, streamed at 1× | transcript of Taglish correct; words first seen p50 1.25 s / p90 2.0 s, final p50 1.55 s / p90 2.5 s after spoken; first translated word ~2.1 s into the clip |
| Deepgram live streaming | not measurable from the cloud session (its proxy does not pass WebSocket upgrades); run from Railway |

Findings:
* **Taglish passthrough:** in one-way translation to English, Soniox does *not* re-emit the English parts of a
  Taglish sentence as translation tokens (they come back with translation status `none`). The dub for an
  English listener must interleave the untranslated English words with the translated Tagalog ones, in order.
  Reading only translation tokens drops half the sentence.
* **Soniox lag is above target.** Next tries: endpoint/latency settings (`max_endpoint_delay`, endpoint latency
  adjustment), a Soniox project in an Asia region, and running from Singapore. Compare with Deepgram streaming +
  separate MT measured from Railway.
* Clips were computer-generated voices; real Discord audio is still needed.

## 12. Open questions

1. Which Discord servers will be the first test servers, and how many people are usually in a call?
2. What languages besides Filipino and English do your users speak?
3. Budget for v1 testing (cloud API spend + a small GPU for Kokoro)?
4. Should the bot also play the dub into the voice channel for one chosen language, for people who won't open
   the Activity?
