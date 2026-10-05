"""Unit tests for the worker's core algorithms."""

from __future__ import annotations

import base64
import os
import tempfile
import unittest

import numpy as np

import util  # noqa: F401  (sys.path)
from translator_worker import config as C
from translator_worker import glossary as G
from translator_worker import hardware as H
from translator_worker import languages as L
from translator_worker import protocol as P
from translator_worker import registry as R
from translator_worker import textutil as T
from translator_worker.breaker import CircuitBreaker
from translator_worker.lid import LanguageSmoother
from translator_worker.metrics import Metrics
from translator_worker.providers.base import GlossaryTerm, ProviderInfo
from translator_worker.providers.fake import FakeMT, FakeSTT, FakeTTS
from translator_worker.providers.vad_energy import EnergyVAD
from translator_worker.router import NoProvider, Providers, Router
from translator_worker.vad import Endpointer, SpeechEnd, SpeechStart, split_on_pauses
from translator_worker.voices import VoiceStore


class ProtocolTests(unittest.TestCase):
    def test_roundtrip_and_fragmentation(self):
        frames = (P.encode_json({"type": "x", "v": "ẹ́"}) + P.encode_audio_in(7, 42, b"\x01\x02" * 10)
                  + P.encode_blob({"type": "b"}, b"data"))
        d = P.FrameDecoder()
        out = []
        for i in range(0, len(frames), 3):  # worst-case fragmentation
            out += d.feed(frames[i:i + 3])
        self.assertEqual(out[0].json(), {"type": "x", "v": "ẹ́"})
        self.assertEqual(out[1].audio(), (7, 42, b"\x01\x02" * 10))
        self.assertEqual(out[2].blob(), ({"type": "b"}, b"data"))

    def test_rejects_oversized(self):
        d = P.FrameDecoder()
        with self.assertRaises(P.ProtocolError):
            d.feed((P.MAX_FRAME + 10).to_bytes(4, "big") + b"\x01")


def tone(sec, amp=0.3, sr=16000):
    t = np.arange(int(sec * sr)) / sr
    return (amp * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def silence(sec, sr=16000):
    return np.zeros(int(sec * sr), np.float32)


class EndpointerTests(unittest.TestCase):
    def ep(self, **kw):
        args = dict(endpoint_ms=500, endpoint_fast_ms=250, min_speech_ms=250, max_utterance_s=12.0)
        args.update(kw)
        return Endpointer(EnergyVAD(), **args)

    def run_audio(self, ep, audio, chunk=320):
        evs = []
        for i in range(0, audio.size, chunk):
            evs += ep.feed(audio[i:i + chunk])
        return evs

    def test_single_utterance_timing(self):
        ep = self.ep()
        evs = self.run_audio(ep, np.concatenate([silence(0.5), tone(1.0), silence(1.0)]))
        starts = [e for e in evs if isinstance(e, SpeechStart)]
        ends = [e for e in evs if isinstance(e, SpeechEnd)]
        self.assertEqual(len(starts), 1)
        self.assertEqual(len(ends), 1)
        e = ends[0]
        self.assertEqual(e.reason, "silence")
        # endpoint latency ~= configured silence (within one VAD window)
        lat_ms = (e.detected_sample - e.end_sample) / 16
        self.assertGreaterEqual(lat_ms, 500)
        self.assertLess(lat_ms, 500 + 64)
        # utterance includes ~200 ms pre-roll + 1 s speech + 120 ms tail
        self.assertAlmostEqual(e.audio.size / 16000, 1.0 + 0.2 + 0.12, delta=0.1)

    def test_fast_endpoint(self):
        ep = self.ep()
        evs = self.run_audio(ep, np.concatenate([silence(0.3), tone(0.8)]))
        ep.allow_fast_end(True)
        evs += self.run_audio(ep, silence(0.6))
        end = [e for e in evs if isinstance(e, SpeechEnd)][0]
        self.assertEqual(end.reason, "silence_fast")
        self.assertLess((end.detected_sample - end.end_sample) / 16, 250 + 64)

    def test_short_click_ignored(self):
        ep = self.ep()
        evs = self.run_audio(ep, np.concatenate([silence(0.5), tone(0.1), silence(1.0)]))
        self.assertFalse([e for e in evs if isinstance(e, SpeechEnd)])

    def test_max_length_cut_continues(self):
        ep = self.ep(max_utterance_s=3.0)
        audio = np.concatenate([silence(0.3), tone(2.5), silence(0.15), tone(2.0), silence(1.0)])
        evs = self.run_audio(ep, audio)
        ends = [e for e in evs if isinstance(e, SpeechEnd)]
        self.assertEqual([e.reason for e in ends], ["max_length", "silence"])
        self.assertLessEqual(ends[0].audio.size, 3.0 * 16000 + 512)

    def test_split_on_pauses(self):
        ep = self.ep(endpoint_ms=800)
        audio = np.concatenate([silence(0.3), tone(2.2), silence(0.4), tone(2.4), silence(1.2)])
        end = [e for e in self.run_audio(ep, audio) if isinstance(e, SpeechEnd)][0]
        ranges = split_on_pauses(end.audio, end.probs, end.window)
        self.assertEqual(len(ranges), 2)


class LIDTests(unittest.TestCase):
    def test_resists_flip_flop_on_short_utterances(self):
        s = LanguageSmoother()
        for _ in range(3):
            s.update({"es": 0.9, "pt": 0.1}, 3.0)
        d = s.update({"pt": 0.7, "es": 0.3}, 0.6)  # short, confusable
        self.assertEqual(d.lang, "es")
        self.assertFalse(d.switched)

    def test_confident_long_utterance_switches_immediately(self):
        s = LanguageSmoother()
        s.update({"en": 0.95}, 3.0)
        d = s.update({"yo": 0.93, "en": 0.05}, 3.0)
        self.assertTrue(d.switched)
        self.assertEqual(d.lang, "yo")

    def test_confusable_requires_sustained_evidence(self):
        s = LanguageSmoother()
        for _ in range(3):
            s.update({"hi": 0.9, "ur": 0.1}, 3.0)
        d1 = s.update({"ur": 0.97, "hi": 0.03}, 3.0)
        self.assertEqual(d1.lang, "hi")  # one utterance is not enough for a confusable pair
        d2 = s.update({"ur": 0.97, "hi": 0.03}, 3.0)
        d3 = s.update({"ur": 0.97, "hi": 0.03}, 3.0)
        self.assertEqual(d3.lang, "ur")
        self.assertTrue(d2.switched or d3.switched)

    def test_forced_and_allowed(self):
        s = LanguageSmoother(forced="ig")
        self.assertEqual(s.update({"yo": 0.9}, 3).lang, "ig")
        self.assertFalse(s.wants_detection())
        s2 = LanguageSmoother(allowed={"en", "yo"})
        self.assertEqual(s2.update({"sw": 0.6, "yo": 0.3, "en": 0.1}, 3).lang, "yo")

    def test_recheck_when_locked(self):
        s = LanguageSmoother(recheck_every=3)
        for _ in range(3):
            s.update({"fr": 0.95}, 3)
        self.assertTrue(s.locked)
        pattern = [s.wants_detection() for _ in range(6)]
        self.assertEqual(pattern, [False, False, True, False, False, True])


class TextTests(unittest.TestCase):
    def test_local_agreement(self):
        a = T.LocalAgreement("en")
        self.assertEqual(a.update("hello there"), ([], ["hello", "there"]))
        new, tent = a.update("hello there my")
        self.assertEqual(new, ["hello", "there"])
        self.assertEqual(tent, ["my"])
        new, _ = a.update("Hello, there my friend")  # punctuation/case differences still agree
        self.assertEqual(new, ["my"])
        self.assertEqual(a.text, "hello there my")

    def test_local_agreement_cjk(self):
        a = T.LocalAgreement("zh")
        a.update("你好世")
        new, tent = a.update("你好世界")
        self.assertEqual("".join(new), "你好世")
        self.assertEqual(tent, ["界"])

    def test_clauses(self):
        self.assertEqual(T.split_clauses("Hi, how are you today, my friend? Fine."),
                         ["Hi, how are you today,", "my friend?", "Fine."])
        self.assertEqual(T.stable_clauses("We start now. Then we"), ["We start now."])

    def test_remainder(self):
        self.assertEqual(T.remainder_after("we start now.", "We start now. Then we finish."), "Then we finish.")
        self.assertEqual(T.remainder_after("", "abc"), "abc")

    def test_hallucination_filter(self):
        self.assertTrue(T.is_hallucination("Thank you.", 0.8, -1.0, 0.5))
        self.assertFalse(T.is_hallucination("Thank you so much for joining us today", 2.5, -0.3, 0.05))
        self.assertTrue(T.is_hallucination("the the the the the the the the", 3, -0.2, 0.1))


class GlossaryTests(unittest.TestCase):
    def test_pre_post_verify(self):
        terms = [GlossaryTerm("Ade", "Adé"), GlossaryTerm("New York City", "NYC"), GlossaryTerm("New York", "NY"),
                 GlossaryTerm("banque", "rive", "en", "fr", "fix")]
        pre = G.pre_translate("Ade lives in New York City.", "en", "fr", terms)
        self.assertEqual(pre.text, "Adé lives in NYC.")
        self.assertEqual(G.post_translate("à la banque", "en", "fr", terms).text, "à la rive")
        self.assertEqual(G.verify("Il vit à NYC", pre.used, "fr")[0].source, "Ade")
        self.assertEqual(G.hotwords(terms, "en"), "Ade New York City New York")

    def test_learn_from_correction_ignores_rewrites(self):
        self.assertEqual(G.learn_from_correction("a b c d e f g h", "z y x w v u t s", "en", "fr"), [])


class RouterTests(unittest.TestCase):
    class Cloud(FakeMT):
        info = ProviderInfo("cloud_mt", "mt", local=False, license="proprietary-api", commercial_ok=True)

    class NC(FakeMT):
        info = ProviderInfo("nc_mt", "mt", local=True, license="CC-BY-NC-4.0", commercial_ok=False)

    def test_policy_ordering(self):
        p = Providers(stt=[FakeSTT()], mt=[self.Cloud(), FakeMT()], tts=[FakeTTS()])
        self.assertEqual([x.info.name for x in Router(p, mode="local").mt_chain("en", "fr")], ["fake_mt"])
        self.assertEqual([x.info.name for x in Router(p, mode="hybrid").mt_chain("en", "fr")], ["fake_mt", "cloud_mt"])
        self.assertEqual([x.info.name for x in Router(p, mode="cloud").mt_chain("en", "fr")], ["cloud_mt", "fake_mt"])
        r = Router(p, mode="hybrid", hybrid_langs=["yo"])
        self.assertEqual(r.mt_chain("yo", "en")[0].info.name, "cloud_mt")
        self.assertEqual(Router(p, mode="auto").mode, "hybrid")
        self.assertEqual(Router(Providers(mt=[FakeMT()]), mode="auto").mode, "local")

    def test_commercial_filter(self):
        p = Providers(mt=[self.NC(), FakeMT()])
        self.assertEqual([x.info.name for x in Router(p, commercial=True).mt_chain("en", "fr")], ["fake_mt"])

    def test_breaker_fallback(self):
        class Bad(FakeMT):
            info = ProviderInfo("bad", "mt", local=True, license="MIT", commercial_ok=True)

            def translate(self, *a, **k):
                raise RuntimeError("boom")

        r = Router(Providers(mt=[Bad(), FakeMT()]), mode="local")
        chain = r.mt_chain("en", "fr")
        for _ in range(3):
            res = r.call(chain, lambda p: p.translate(["x"], "en", "fr"))
            self.assertEqual(res.provider.info.name, "fake_mt")
        self.assertEqual(r.breakers["bad"].state, "open")
        res = r.call(chain, lambda p: p.translate(["x"], "en", "fr"))
        self.assertIn("bad:open", res.fallbacks)
        with self.assertRaises(NoProvider):
            Router(Providers(mt=[Bad()])).call([Bad()], lambda p: p.translate(["x"], "en", "fr"))

    def test_breaker_half_open(self):
        now = [0.0]
        b = CircuitBreaker("x", failures_to_open=1, cooldown_s=10, clock=lambda: now[0])
        b.failure("e")
        self.assertFalse(b.allow())
        now[0] = 11
        self.assertTrue(b.allow())
        b.failure("e")  # half-open failure doubles the cooldown
        self.assertEqual(b.current_cooldown, 20)


class RegistryTests(unittest.TestCase):
    def test_tiers_with_fakes(self):
        from translator_worker.providers.fake import FakeCloneTTS
        p = Providers(stt=[FakeSTT()], mt=[FakeMT(unsupported={"la"})], tts=[FakeTTS(langs={"en", "fr", "yo"})],
                      clone=[FakeCloneTTS()])
        caps = R.build(Router(p), whisper_size="large-v3")
        self.assertEqual(caps["fr"].tier, 1)        # clone supports fr
        self.assertEqual(caps["yo"].tier, 2)        # house voice only
        self.assertEqual(caps["ha"].tier, 3)        # no voice -> captions
        self.assertEqual(caps["la"].tier, 0)        # no MT
        self.assertEqual(caps["ig"].stt_grade, "none")
        self.assertEqual(caps["pcm"].stt_grade, "fair")
        self.assertTrue(caps["pcm"].auto_detect)     # via the transcript-level detector
        self.assertEqual(caps["pcm"].tier, 1)       # spoken with a (cloned) English voice
        self.assertTrue(any("English voice" in r for r in caps["pcm"].reasons))
        self.assertEqual(caps["yo"].stt_grade, "poor")
        small = R.build(Router(p), whisper_size="small")
        self.assertEqual(small["sw"].stt_grade, "poor")   # fair downgraded on small model
        self.assertEqual(small["yo"].stt_grade, "poor")   # floor: still recognisable
        self.assertTrue(any("CPU-tier" in r for r in small["yo"].reasons))
        self.assertEqual(small["en"].stt_grade, "good")


class ConfigHardwareTests(unittest.TestCase):
    def test_env_overrides(self):
        cfg = C.load(None, env={"COMMERCIAL": "true", "PIPELINE_MODE": "hybrid", "TW__PIPELINE__ENDPOINT_MS": "400",
                                "DEEPL_API_KEY": "k:fx"})
        self.assertTrue(cfg.policy.commercial)
        self.assertEqual(cfg.policy.mode, "hybrid")
        self.assertEqual(cfg.pipeline.endpoint_ms, 400)
        self.assertEqual(cfg.cloud.deepl_api_key, "k:fx")

    def test_yaml_and_validation(self):
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
            f.write("pipeline:\n  endpoint_ms: 600\ntts:\n  voices:\n    en: en_GB-alan-medium\nllm:\n  base_url: ${LLM_URL:-http://ollama:11434/v1}\n")
        cfg = C.load(f.name, env={})
        self.assertEqual(cfg.pipeline.endpoint_ms, 600)
        self.assertEqual(cfg.tts.voices["en"], "en_GB-alan-medium")
        self.assertEqual(cfg.llm.base_url, "http://ollama:11434/v1")
        with self.assertRaises(ValueError):
            C.load(None, env={"TW__PIPELINE__ENDPOINT_FAST_MS": "900"})
        os.unlink(f.name)

    def test_plans(self):
        cfg = C.Config()
        cpu = H.plan(H.HardwareInfo("cpu", "cpu", cpu_cores=4, ram_gb=8), cfg)
        self.assertEqual((cpu.stt_model, cpu.stt_compute, cpu.clone_enabled, cpu.partials), ("small", "int8", False, False))
        g8 = H.plan(H.HardwareInfo("gpu8", "cuda", vram_gb=16), cfg)
        self.assertEqual(g8.stt_model, "large-v3-turbo")
        self.assertTrue(g8.clone_enabled and g8.incremental_dub)
        g24 = H.plan(H.HardwareInfo("gpu24", "cuda", vram_gb=24), cfg)
        self.assertEqual(g24.stt_model, "large-v3")
        cfg.policy.commercial = True
        self.assertEqual(H.plan(H.HardwareInfo("gpu24", "cuda", vram_gb=24), cfg).mt_family, "madlad")
        self.assertEqual(H.tier_for_vram(23.6), "gpu24")
        self.assertEqual(H.tier_for_vram(15.0), "gpu8")
        self.assertEqual(H.tier_for_vram(4.0), "cpu")


class VoiceStoreTests(unittest.TestCase):
    def test_encrypt_roundtrip_and_delete(self):
        d = tempfile.mkdtemp()
        key = base64.b64encode(os.urandom(32)).decode()
        vs = VoiceStore(d, key)
        audio = (np.sin(np.arange(16000) / 10) * 0.5).astype(np.float32)
        vs.save("123", audio, 16000, {"consent_version": "v1"})
        self.assertTrue(vs.has("123"))
        # file name does not reveal the user id and content is not plaintext
        files = os.listdir(d)
        self.assertFalse(any("123" in f for f in files))
        with open(os.path.join(d, files[0]), "rb") as fh:
            raw = fh.read()
        self.assertNotIn(b"consent_version", raw)
        ref = vs.load("123")
        self.assertLess(np.max(np.abs(ref.reference_wav - audio)), 1e-3)
        # wrong key cannot read it
        other = VoiceStore(d, base64.b64encode(os.urandom(32)).decode())
        self.assertFalse(other.has("123"))
        self.assertTrue(vs.delete("123"))
        self.assertFalse(vs.has("123"))

    def test_disabled_without_key(self):
        vs = VoiceStore(tempfile.mkdtemp(), "")
        self.assertFalse(vs.enabled)
        self.assertIn("disabled", vs.reason)


class LanguageTableTests(unittest.TestCase):
    def test_coverage(self):
        self.assertEqual(len(L.WHISPER_CODES), 100)
        for c in ("yo", "ha", "ig", "pcm"):
            self.assertIn(c, L.LANGUAGES)
        self.assertEqual(L.normalize("eng_Latn"), "en")
        self.assertEqual(L.normalize("en-US"), "en")
        self.assertEqual(L.normalize("ibo"), "ig")
        self.assertTrue(L.pidgin_score("abeg wetin dey happen") > 0.5)
        self.assertEqual(L.pidgin_score("what is happening here"), 0.0)


class MetricsTests(unittest.TestCase):
    def test_percentiles(self):
        m = Metrics()
        for i in range(1, 101):
            m.observe("mt", i)
        s = m.summary()["latency_ms"]["mt"]
        self.assertEqual(s["n"], 100)
        self.assertAlmostEqual(s["p50"], 50.5, delta=0.6)
        self.assertAlmostEqual(s["p90"], 90.1, delta=0.6)


if __name__ == "__main__":
    unittest.main()
