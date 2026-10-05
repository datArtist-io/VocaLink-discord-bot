# Phase plan and status

You asked me to skip the approval stops and build everything. All phases are implemented. Each phase still has
a **gate you run** on real Discord + real models (this build environment could not run either; see TESTING.md).

| Phase | Scope | Built | Verified here | Gate you run |
|---|---|---|---|---|
| **0 – Spike** | DAVE receive → per-user WAV, send path (beep), join/leave key transitions, hardware probe, model download, benchmark | `edge/src/dave-spike.ts`, `worker/scripts/download_models.py`, `bench.py`, `--plan` | probe/plan unit-tested; bench script run with stand-in models | `dave-spike` PASS; `bench.py --clips` numbers |
| **1 – MVP** | edge + worker, local pipeline, captions in a thread, house-voice dubbing, capability registry + tier notices, join notice, `/optout`, `/mylang`, per-stage latency, worker-crash survival, optional cloud plug-ins | ✅ | ✅ end-to-end through the real worker process (stand-in models), incl. kill -9 of the worker | `/translate start` in your server |
| **2 – Multi-pipeline** | partial captions (LocalAgreement), speculative translation, edit-in-place, incremental dubbing, mirror channels, glossary + `/correct` learning, literal/natural/cultural, confidence flags + "say that again?", `/whisper`, barge-in/cross-talk, multi-worker failover, sharding | ✅ | ✅ except mirror channels (Discord-only) | mirror bots in your server |
| **3 – Web companion** | per-listener language + translated audio stream + volume/per-speaker mute; Activity-ready protocol | ✅ | ✅ server + WebSocket tests; page rendered in headless Chromium with no errors | open `/listen` on a phone |
| **4 – Voice cloning** | consent flow, live-phrase enrollment, encrypted profiles, Chatterbox, prosody/emotion transfer (pace, energy, pitch variability → expressiveness), `/voice delete` | ✅ | ✅ enrollment/consent/clone-routing/delete with a stand-in clone model; encryption tested | GPU + `requirements-clone` |
| **5 – Analytics & summaries** | dashboard (per-stage p50/p90, tiers, languages, flags, providers, workers), multilingual post-call summary with action items (LLM or labelled extractive fallback) | ✅ | ✅ summary path + dashboard rendered | `/dashboard`, `/translate stop` |

Not built (deliberately):
* A Discord **Activity** wrapper — the companion uses signed links; adding the Embedded App SDK needs your
  app's OAuth2 setup and URL mappings in the portal.
* Postgres/Redis — SQLite is sufficient until multi-host edges; the `Store` class is the only place to swap.
* True emotion transfer — we transfer pace, loudness and pitch variability (honest "prosody transfer").
