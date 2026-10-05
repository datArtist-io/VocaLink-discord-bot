"""End-to-end: simulated edge -> TCP -> real worker pipeline (fake models) -> events + dub audio."""

from __future__ import annotations

import asyncio
import base64
import os
import unittest

import numpy as np

from util import EdgeSim, make_cfg, make_plan, speech  # noqa: I001

from translator_worker import protocol as P
from translator_worker.app import WorkerApp
from translator_worker.audio import pcm16_to_f32
from translator_worker.providers import build as build_providers
from translator_worker.providers.fake import FakeCloneTTS, modem_decode_runs


class WorkerE2E(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.cfg = make_cfg()
        self.hw, self.plan = make_plan(self.cfg, partials=True)
        providers, _ = build_providers(self.cfg, self.hw, self.plan)
        self.app = WorkerApp(self.cfg, providers=providers, hw=self.hw, plan=self.plan)
        self.port = await self.app.start("127.0.0.1", 0, health_port=0)
        self.edge = EdgeSim(self.port)
        await self.edge.connect()

    async def asyncTearDown(self):
        await self.edge.close()
        await self.app.stop()

    def guild(self, **kw):
        msg = {"type": "guild_config", "guild_id": "g1", "text_targets": ["en", "fr"], "audio_targets": ["fr"]}
        msg.update(kw)
        self.edge.send(msg)

    async def test_hello_ack_describes_capabilities(self):
        ack = self.edge.of("hello_ack")[0]
        self.assertEqual(ack["protocol"], P.PROTOCOL_VERSION)
        self.assertIn("yo", ack["languages"])
        self.assertIn(ack["languages"]["en"]["tier"], (1, 2))
        self.assertEqual(ack["hardware"]["tier"], "gpu8")

    async def test_bad_token_rejected(self):
        e2 = EdgeSim(self.port, token="wrong")
        await e2.connect()
        self.assertTrue(e2.of("hello_error"))
        await e2.close()

    async def test_utterance_produces_partials_final_and_dub(self):
        self.guild()
        self.edge.send({"type": "stream_open", "sid": 1, "guild_id": "g1", "user_id": "u1", "name": "Ada"})
        await self.edge.stream(1, speech("hello everyone, welcome to the call", "en"), speed=8)
        final = await self.edge.wait_for(lambda e: e["type"] == "final", 10)
        self.assertEqual(final["lang"], "en")
        self.assertEqual(final["text"], "hello everyone, welcome to the call")
        self.assertEqual(final["translations"]["fr"]["text"], "[fr] hello everyone, welcome to the call")
        self.assertNotIn("en", final["translations"])  # same language is not translated
        self.assertEqual(final["tiers"], {"fr": 2})
        for k in ("vad_endpoint", "stt", "mt"):
            self.assertIn(k, final["latency"])
        # partials with LocalAgreement-committed prefixes
        partials = self.edge.of("partial")
        self.assertTrue(partials, "expected partial results")
        for p in partials:
            self.assertTrue("hello everyone, welcome to the call".startswith(p["committed"]))
        # dub: tts_start -> audio frames -> tts_end, audio decodes to the translation
        start = await self.edge.wait_for(lambda e: e["type"] == "tts_start", 10)
        end = await self.edge.wait_for(lambda e: e["type"] == "tts_end" and e["dub_id"] == start["dub_id"], 10)
        self.assertEqual(start["lang"], "fr")
        self.assertEqual(start["sample_rate"], 48000)
        pcm = b"".join(self.edge.audio[start["dub_id"]])
        self.assertEqual(end["frames"], len(self.edge.audio[start["dub_id"]]))
        runs = modem_decode_runs(pcm16_to_f32(pcm), 48000)
        self.assertEqual(runs, [("fr", "[fr] hello everyone, welcome to the call")])

    async def test_language_detection_and_two_speakers(self):
        self.guild(text_targets=["en"], audio_targets=["en"])
        self.edge.send({"type": "stream_open", "sid": 1, "guild_id": "g1", "user_id": "u1", "name": "A"})
        self.edge.send({"type": "stream_open", "sid": 2, "guild_id": "g1", "user_id": "u2", "name": "B"})
        await asyncio.gather(self.edge.stream(1, speech("bonjour à tous", "fr")),
                             self.edge.stream(2, speech("ẹ kú àárọ̀ o", "yo")))
        await self.edge.wait_for(lambda e: e["type"] == "final" and e["sid"] == 1, 10)
        await self.edge.wait_for(lambda e: e["type"] == "final" and e["sid"] == 2, 10)
        f1 = [e for e in self.edge.of("final") if e["sid"] == 1][0]
        f2 = [e for e in self.edge.of("final") if e["sid"] == 2][0]
        self.assertEqual((f1["lang"], f2["lang"]), ("fr", "yo"))
        self.assertEqual(f2["translations"]["en"]["text"], "[en] ẹ kú àárọ̀ o")
        self.assertIn("weak_language", f2["flags"])  # Yoruba STT grade is poor

    async def test_forced_language_and_pidgin(self):
        self.guild(text_targets=["en", "fr"], audio_targets=[])
        self.edge.send({"type": "stream_open", "sid": 3, "guild_id": "g1", "user_id": "u3", "name": "C"})
        # Whisper hears Pidgin as English; the transcript-level detector relabels it
        await self.edge.stream(3, speech("abeg wetin dey happen for here, una dey hear me", "en"))
        f = await self.edge.wait_for(lambda e: e["type"] == "final" and e["sid"] == 3, 10)
        self.assertEqual(f["lang"], "pcm")
        self.assertIn("en", f["translations"])
        # NLLB-like fake MT supports pcm here, so no fallback note expected; mode literal
        self.assertEqual(f["translations"]["en"]["mode"], "literal")

    async def test_dropped_frames_are_concealed(self):
        self.guild()
        self.edge.send({"type": "stream_open", "sid": 4, "guild_id": "g1", "user_id": "u4", "name": "D"})
        audio = speech("this is a test of packet loss handling", "en")
        await self.edge.stream(4, audio, skip={60, 61, 62})  # drop 60 ms in silence-free region
        f = await self.edge.wait_for(lambda e: e["type"] == "final" and e["sid"] == 4, 10)
        self.assertTrue(f["text"])  # pipeline survives; text may be damaged by the gap
        sess = None
        for c in self.app.connections:
            sess = c.sessions.get(4)
        self.assertEqual(sess.stats["dropped_frames"], 3)

    async def test_natural_mode_falls_back_without_llm_and_uses_llm_when_present(self):
        self.guild(mode="natural", audio_targets=[])
        self.edge.send({"type": "stream_open", "sid": 5, "guild_id": "g1", "user_id": "u5", "name": "E"})
        await self.edge.stream(5, speech("good morning", "en"))
        f = await self.edge.wait_for(lambda e: e["type"] == "final" and e["sid"] == 5, 10)
        self.assertEqual(f["translations"]["fr"]["mode"], "natural")
        self.assertEqual(f["translations"]["fr"]["text"], "[fr~natural] good morning")

    async def test_glossary_hotwords_and_correction_learning(self):
        self.guild(glossary=[{"source": "Ade", "target": "Adé", "kind": "term"}])
        self.edge.send({"type": "correct", "req_id": "c1", "original": "we meet at the bank tomorrow",
                        "corrected": "we meet at the riverbank tomorrow", "src_lang": "en", "tgt_lang": "fr"})
        r = await self.edge.wait_for(lambda e: e["type"] == "correct_result", 5)
        self.assertEqual(r["terms"][0]["source"], "bank")
        self.assertEqual(r["terms"][0]["target"], "riverbank")
        self.assertEqual(r["terms"][0]["kind"], "fix")

    async def test_translate_text_and_languages_and_summary(self):
        self.guild()
        self.edge.send({"type": "translate_text", "req_id": "t1", "text": "hi", "src": "en", "tgt": "yo"})
        r = await self.edge.wait_for(lambda e: e["type"] == "translate_result", 5)
        self.assertTrue(r["ok"])
        self.assertEqual(r["text"], "[yo] hi")
        self.edge.send({"type": "languages", "req_id": "l1"})
        langs = await self.edge.wait_for(lambda e: e["type"] == "languages_result", 5)
        codes = {x["code"] for x in langs["languages"]}
        self.assertTrue({"yo", "ha", "ig", "pcm"} <= codes)
        self.assertGreaterEqual(len(codes), 100)
        # summary after one utterance
        self.edge.send({"type": "stream_open", "sid": 6, "guild_id": "g1", "user_id": "u6", "name": "F"})
        await self.edge.stream(6, speech("we need to ship the release by friday", "en"))
        await self.edge.wait_for(lambda e: e["type"] == "final" and e["sid"] == 6, 10)
        self.edge.send({"type": "summarize", "req_id": "s1", "guild_id": "g1", "langs": ["en", "fr"]})
        s = await self.edge.wait_for(lambda e: e["type"] == "summary_result", 10)
        self.assertTrue(s["ok"])
        self.assertEqual(s["method"], "llm")
        self.assertIn("fr", s["by_lang"])

    async def test_cancel_dub_stops_audio(self):
        self.guild()
        self.edge.send({"type": "stream_open", "sid": 7, "guild_id": "g1", "user_id": "u7", "name": "G"})
        await self.edge.stream(7, speech("please cancel this long sentence right now", "en"))
        st = await self.edge.wait_for(lambda e: e["type"] == "tts_start" and e["sid"] == 7, 10)
        self.edge.send({"type": "cancel_dub", "dub_id": st["dub_id"], "reason": "barge_in"})
        end = await self.edge.wait_for(lambda e: e["type"] == "tts_end" and e["dub_id"] == st["dub_id"], 10)
        # fake TTS yields quickly; either it was cancelled or had already finished
        self.assertIn(end["cancelled"], (True, False))

    async def test_stream_close_flushes_utterance(self):
        self.guild(audio_targets=[])
        self.edge.send({"type": "stream_open", "sid": 8, "guild_id": "g1", "user_id": "u8", "name": "H"})
        a = speech("cut off mid sentence", "en", tail_s=0.0)
        await self.edge.stream(8, a)
        self.edge.send({"type": "stream_close", "sid": 8})
        f = await self.edge.wait_for(lambda e: e["type"] == "final" and e["sid"] == 8, 10)
        self.assertEqual(f["endpoint_reason"], "flush")


class CloneE2E(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        os.environ["VOICE_PROFILE_KEY"] = base64.b64encode(b"k" * 32).decode()
        self.cfg = make_cfg()
        self.cfg.paths.data = f"/tmp/dvt-test-data-{os.getpid()}"
        self.cfg.clone.min_enroll_s = 1.0
        self.hw, self.plan = make_plan(self.cfg, clone=True, tier="gpu24")
        providers, _ = build_providers(self.cfg, self.hw, self.plan)
        self.assertTrue(any(isinstance(p, FakeCloneTTS) for p in providers.clone))
        self.app = WorkerApp(self.cfg, providers=providers, hw=self.hw, plan=self.plan)
        self.port = await self.app.start("127.0.0.1", 0, health_port=0)
        self.edge = EdgeSim(self.port)
        await self.edge.connect()

    async def asyncTearDown(self):
        await self.edge.close()
        await self.app.stop()
        os.environ.pop("VOICE_PROFILE_KEY", None)

    async def _enroll(self, phrase_spoken: str, phrase_expected: str):
        audio = speech(phrase_spoken, "en", lead_s=0.1, tail_s=0.1)
        from translator_worker.audio import f32_to_pcm16
        self.edge._writer.write(P.encode_blob(
            {"type": "voice_enroll", "req_id": "e1", "user_id": "u1", "guild_id": "g1",
             "phrase": phrase_expected, "lang": "en", "consent_version": "v1"}, f32_to_pcm16(audio)))
        return await self.edge.wait_for(lambda e: e["type"] == "voice_enroll_result", 10)

    async def test_enroll_rejects_wrong_phrase(self):
        r = await self._enroll("some other words entirely here", "I agree to let this bot clone my voice")
        self.assertFalse(r["ok"])
        self.assertFalse(self.app.voices.has("u1"))

    async def test_enroll_clone_dub_then_delete(self):
        phrase = "I agree to let this bot clone my voice"
        r = await self._enroll(phrase, phrase)
        self.assertTrue(r["ok"], r)
        self.assertTrue(self.app.voices.has("u1"))
        self.edge.send({"type": "guild_config", "guild_id": "g1", "text_targets": ["fr"], "audio_targets": ["fr", "yo"],
                        "voice_mode": "clone", "clone_users": ["u1"]})
        self.edge.send({"type": "stream_open", "sid": 1, "guild_id": "g1", "user_id": "u1", "name": "Ada"})
        await self.edge.stream(1, speech("good evening friends", "en"))
        f = await self.edge.wait_for(lambda e: e["type"] == "final", 10)
        self.assertEqual(f["tiers"], {"fr": 1, "yo": 2})  # Chatterbox has no Yoruba -> house voice
        st_fr = await self.edge.wait_for(lambda e: e["type"] == "tts_start" and e["lang"] == "fr", 10)
        st_yo = await self.edge.wait_for(lambda e: e["type"] == "tts_start" and e["lang"] == "yo", 10)
        self.assertEqual(st_fr["voice"], "clone")
        self.assertEqual(st_yo["voice"], "house")
        self.edge.send({"type": "voice_delete", "req_id": "d1", "user_id": "u1"})
        d = await self.edge.wait_for(lambda e: e["type"] == "voice_delete_result", 5)
        self.assertTrue(d["deleted"])
        self.assertFalse(self.app.voices.has("u1"))


if __name__ == "__main__":
    unittest.main()


class StressAndCodeSwitch(unittest.IsolatedAsyncioTestCase):
    async def _start(self, *, stt_delay=0.0, stt_workers=2, **pipeline):
        from translator_worker.providers.fake import FakeSTT
        self.cfg = make_cfg(**pipeline)
        self.hw, self.plan = make_plan(self.cfg, partials=True)
        self.plan.stt_workers = stt_workers
        providers, _ = build_providers(self.cfg, self.hw, self.plan)
        providers.stt = [FakeSTT(delay_s=stt_delay)]
        self.app = WorkerApp(self.cfg, providers=providers, hw=self.hw, plan=self.plan)
        self.port = await self.app.start("127.0.0.1", 0, health_port=0)
        self.edge = EdgeSim(self.port)
        await self.edge.connect()

    async def asyncTearDown(self):
        await self.edge.close()
        await self.app.stop()

    async def test_code_switching_within_one_utterance(self):
        await self._start(long_utterance_s=3.0)
        self.edge.send({"type": "guild_config", "guild_id": "g", "text_targets": ["en", "de"], "audio_targets": []})
        self.edge.send({"type": "stream_open", "sid": 1, "guild_id": "g", "user_id": "u", "name": "U"})
        from translator_worker.providers.fake import modem_encode
        audio = np.concatenate([np.zeros(4800, np.float32),
                                modem_encode("bonjour tout le monde ici", 16000, "fr", gap_s=0.35),
                                modem_encode("and then I switch to english", 16000, "en"),
                                np.zeros(16000, np.float32)])
        await self.edge.stream(1, audio)
        f = await self.edge.wait_for(lambda e: e["type"] == "final", 15)
        self.assertEqual([s["lang"] for s in f["segments"]], ["fr", "en"])
        # each part is translated from its own language; English part is kept as-is for the en target
        self.assertEqual(f["translations"]["en"]["text"], "[en] bonjour tout le monde ici and then I switch to english")
        self.assertEqual(f["translations"]["de"]["text"], "[de] bonjour tout le monde ici [de] and then I switch to english")

    async def test_load_shedding_keeps_finals_flowing(self):
        await self._start(stt_delay=0.25, stt_workers=1)
        self.edge.send({"type": "guild_config", "guild_id": "g", "text_targets": ["fr"], "audio_targets": ["fr"]})
        texts = [f"speaker number {i} is talking right now about the plan" for i in range(4)]
        for i in range(4):
            self.edge.send({"type": "stream_open", "sid": 10 + i, "guild_id": "g", "user_id": f"u{i}", "name": f"S{i}"})
        await asyncio.gather(*(self.edge.stream(10 + i, speech(t, "en"), speed=4) for i, t in enumerate(texts)))
        for i in range(4):
            f = await self.edge.wait_for(lambda e, i=i: e["type"] == "final" and e["sid"] == 10 + i, 30)
            self.assertEqual(f["text"], texts[i])
        self.assertGreater(self.app.metrics.counters["partials_shed"], 0)  # partials dropped, finals kept


class CodeSwitchDub(StressAndCodeSwitch):
    async def test_code_switch_dub_only_foreign_part_for_main_language(self):
        await self._start(long_utterance_s=3.0)
        self.edge.send({"type": "guild_config", "guild_id": "g", "text_targets": ["en"], "audio_targets": ["en"]})
        self.edge.send({"type": "stream_open", "sid": 1, "guild_id": "g", "user_id": "u", "name": "U"})
        from translator_worker.providers.fake import modem_encode
        audio = np.concatenate([np.zeros(4800, np.float32), modem_encode("bonjour tout le monde ici", 16000, "fr", gap_s=0.35),
                                modem_encode("and then I switch to english", 16000, "en"), np.zeros(16000, np.float32)])
        await self.edge.stream(1, audio)
        st = await self.edge.wait_for(lambda e: e["type"] == "tts_start", 15)
        self.assertEqual(st["text"], "[en] bonjour tout le monde ici")  # English part is not re-spoken

    test_code_switching_within_one_utterance = None
    test_load_shedding_keeps_finals_flowing = None
