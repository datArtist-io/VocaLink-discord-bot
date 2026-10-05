"""Glue tests for real providers.

The ML libraries are replaced by small stand-in modules that record how they
are called, so these tests check OUR side of each integration (argument
names, token formats, sample-rate handling, HTTP request shapes). They do not
prove the real libraries behave identically - that needs the Phase 0 run with
real models (docs/TESTING.md).
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np

import util  # noqa: F401
from translator_worker.providers import http as H
from translator_worker.providers.base import GlossaryTerm, Prosody


# ------------------------------------------------------------------ stand-in modules
def install_fake_faster_whisper(calls):
    mod = types.ModuleType("faster_whisper")

    class Seg:
        def __init__(self, text):
            self.text, self.tokens, self.avg_logprob, self.no_speech_prob = text, [1, 2, 3], -0.25, 0.02

    class Info:
        language, language_probability = "fr", 0.91
        all_language_probs = [("fr", 0.91), ("en", 0.05)]

    class WhisperModel:
        def __init__(self, name, **kw):
            calls["init"] = (name, kw)
            self.model = types.SimpleNamespace(is_multilingual=True)

        def transcribe(self, audio, **kw):
            calls.setdefault("transcribe", []).append(kw)
            return iter([Seg(" Bonjour"), Seg(" à tous.")]), Info()

        def detect_language(self, audio):
            return "fr", 0.91, [("fr", 0.91), ("en", 0.05)]

    mod.WhisperModel = WhisperModel
    sys.modules["faster_whisper"] = mod


def install_fake_ct2(calls):
    ct2 = types.ModuleType("ctranslate2")
    spm = types.ModuleType("sentencepiece")

    class Translator:
        def __init__(self, path, **kw):
            calls["init"] = (path, kw)

        def translate_batch(self, src, target_prefix=None, **kw):
            calls.setdefault("batches", []).append((src, target_prefix, kw))
            out = []
            for i, s in enumerate(src):
                body = [t for t in s if t not in ("</s>",) and not t.endswith("_Latn") and not t.startswith("▁<2")]
                hyp = (target_prefix[i] if target_prefix else []) + [t.upper() for t in body]
                out.append(types.SimpleNamespace(hypotheses=[hyp]))
            return out

    class SentencePieceProcessor:
        def __init__(self, model_file):
            calls["spm"] = model_file

        def encode(self, text, out_type=str):
            return ["▁" + w for w in text.split()]

        def decode(self, toks):
            return " ".join(t.lstrip("▁") for t in toks)

    ct2.Translator = Translator
    spm.SentencePieceProcessor = SentencePieceProcessor
    sys.modules["ctranslate2"] = ct2
    sys.modules["sentencepiece"] = spm


def install_fake_piper(calls):
    mod = types.ModuleType("piper")

    class SynthesisConfig:
        def __init__(self):
            self.length_scale, self.volume = None, None

    class Chunk:
        def __init__(self, n, sr):
            self.audio_int16_bytes = (np.ones(n, dtype="<i2") * 1000).tobytes()
            self.sample_rate = sr

    class PiperVoice:
        @staticmethod
        def load(path, use_cuda=False):
            calls.setdefault("load", []).append(path)
            v = PiperVoice()
            v.sr = 16000 if "low" in path else 22050
            return v

        def synthesize(self, text, syn_config=None):
            calls.setdefault("syn", []).append((text, syn_config.length_scale, syn_config.volume))
            for _ in text.split(". "):
                yield Chunk(2205, self.sr)

    mod.PiperVoice, mod.SynthesisConfig = PiperVoice, SynthesisConfig
    sys.modules["piper"] = mod


class FasterWhisperGlue(unittest.TestCase):
    def test_args_and_result(self):
        calls = {}
        install_fake_faster_whisper(calls)
        from translator_worker.providers.stt_faster_whisper import FasterWhisperSTT
        stt = FasterWhisperSTT("small", device="cpu", compute_type="int8", num_workers=2)
        self.assertNotIn("yue", stt.languages())  # Cantonese needs large-v3
        r = stt.transcribe(np.zeros(16000, np.float32), None, final=True, hotwords="Adé")
        kw = calls["transcribe"][-1]
        self.assertEqual(kw["beam_size"], 5)
        self.assertFalse(kw["vad_filter"])
        self.assertFalse(kw["condition_on_previous_text"])
        self.assertEqual(kw["hotwords"], "Adé")
        self.assertEqual(r.text, "Bonjour à tous.")
        self.assertEqual(r.language, "fr")
        self.assertAlmostEqual(r.language_probs["fr"], 0.91)
        stt.transcribe(np.zeros(16000, np.float32), "fr", final=False)
        self.assertEqual(calls["transcribe"][-1]["beam_size"], 1)
        self.assertEqual(stt.detect_language(np.zeros(16000, np.float32))["fr"], 0.91)


class CT2Glue(unittest.TestCase):
    def setUp(self):
        self.calls = {}
        install_fake_ct2(self.calls)
        self.dir = tempfile.mkdtemp()
        Path(self.dir, "model.bin").write_bytes(b"x")
        Path(self.dir, "sentencepiece.bpe.model").write_bytes(b"x")

    def test_nllb_token_format(self):
        from translator_worker.providers.mt_ct2 import CT2Translator
        mt = CT2Translator("nllb", self.dir, "facebook/nllb-200-distilled-600M", models_dir="/tmp")
        out = mt.translate(["Hello there. How are you?"], "en", "yo")
        src, prefix, kw = self.calls["batches"][-1]
        self.assertEqual(src[0], ["eng_Latn", "▁Hello", "▁there.", "</s>"])   # sentence split
        self.assertEqual(src[1], ["eng_Latn", "▁How", "▁are", "▁you?", "</s>"])
        self.assertEqual(prefix, [["yor_Latn"], ["yor_Latn"]])
        self.assertEqual(out[0].text, "HELLO THERE. HOW ARE YOU?")      # target lang token stripped
        self.assertFalse(mt.info.commercial_ok)
        self.assertFalse(mt.supports("pcm", "en"))
        self.assertTrue(mt.supports("ig", "ha"))

    def test_madlad_token_format(self):
        Path(self.dir, "sentencepiece.bpe.model").unlink()
        Path(self.dir, "spiece.model").write_bytes(b"x")
        from translator_worker.providers.mt_ct2 import CT2Translator
        mt = CT2Translator("madlad", self.dir, "x", models_dir="/tmp")
        mt.translate(["Good morning"], "en", "ha")
        src, prefix, _ = self.calls["batches"][-1]
        self.assertEqual(src[0], ["▁<2ha>", "▁Good", "▁morning", "</s>"])
        self.assertIsNone(prefix)
        self.assertTrue(self.calls["spm"].endswith("spiece.model"))
        self.assertTrue(mt.info.commercial_ok)


class PiperGlue(unittest.TestCase):
    def test_voice_pick_rate_and_prosody(self):
        calls = {}
        install_fake_piper(calls)
        from translator_worker.providers.tts_piper import PiperTTS
        d = tempfile.mkdtemp()
        for k in ("en_US-lessac-medium", "sw_CD-lanfrica-low"):
            Path(d, f"{k}.onnx").write_bytes(b"x")
        tts = PiperTTS(d, allow_download=False)
        self.assertTrue(tts.supports("sw"))
        self.assertFalse(tts.supports("yo"))
        chunks = list(tts.synthesize("Habari. Karibu", "sw", prosody=Prosody(rate=1.25, energy=1.0)))
        self.assertEqual([sr for _, sr in chunks], [16000, 16000])  # per-voice rate is reported
        self.assertTrue(calls["load"][0].endswith("sw_CD-lanfrica-low.onnx"))
        self.assertAlmostEqual(calls["syn"][0][1], 0.8)  # length_scale = 1/rate


# ------------------------------------------------------------------ HTTP plug-ins
class Mock(BaseHTTPRequestHandler):
    log_message = lambda *a: None  # noqa: E731
    seen: list = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        Mock.seen.append((self.path, dict(self.headers), body))
        p = self.path
        if p.startswith("/v1/listen"):
            out = {"results": {"channels": [{"detected_language": "en", "language_confidence": 0.97,
                   "alternatives": [{"transcript": "hello there", "confidence": 0.9,
                                     "words": [{"word": "hello", "start": 0, "end": 0.4}]}]}]}}
        elif p.endswith("/audio/transcriptions"):
            out = {"text": "bonjour", "language": "french", "segments": [{"avg_logprob": -0.2, "no_speech_prob": 0.01}]}
        elif p.endswith("/chat/completions"):
            req = json.loads(body)
            if "response_format" in req and "nojson" in req["model"]:
                self.send_response(400)
                self.end_headers()
                return
            out = {"choices": [{"message": {"content": "Salut tout le monde [idiom: x = y]"}}]}
        elif p.startswith("/v2/translate"):
            out = {"translations": [{"text": "Hallo"}]}
        elif p.startswith("/language/translate/v2"):
            out = {"data": {"translations": [{"translatedText": "Ẹ n l&#39;ẹ"}]}}
        elif p.endswith("/audio/speech") or "/text-to-speech/" in p:
            data = (np.ones(24000, dtype="<i2") * 500).tobytes()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        else:
            self.send_response(404)
            self.end_headers()
            return
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class CloudGlue(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), Mock)
        cls.base = f"http://127.0.0.1:{cls.srv.server_port}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls._req, cls._stream = H.request, H.stream

        def rewrite(url):
            for host in ("https://api.deepgram.com", "https://api-free.deepl.com", "https://api.deepl.com",
                         "https://translation.googleapis.com", "https://api.elevenlabs.io"):
                url = url.replace(host, cls.base)
            return url

        H.request = lambda m, url, **kw: cls._req(m, rewrite(url), **kw)
        H.stream = lambda m, url, **kw: cls._stream(m, rewrite(url), **kw)

    @classmethod
    def tearDownClass(cls):
        H.request, H.stream = cls._req, cls._stream
        cls.srv.shutdown()

    def test_deepgram(self):
        from translator_worker.providers.stt_cloud import DeepgramSTT
        r = DeepgramSTT("KEY").transcribe(np.zeros(8000, np.float32), None, final=True, hotwords="Adé")
        self.assertEqual((r.text, r.language), ("hello there", "en"))
        path, headers, body = Mock.seen[-1]
        self.assertIn("detect_language=true", path)
        self.assertEqual(headers["Authorization"], "Token KEY")
        self.assertTrue(body.startswith(b"RIFF"))

    def test_openai_compatible_stt_llm_tts(self):
        from translator_worker.providers.llm import LLMTranslator, OpenAIChatLLM
        from translator_worker.providers.stt_cloud import OpenAICompatSTT
        from translator_worker.providers.tts_cloud import OpenAITTS
        stt = OpenAICompatSTT("K", self.base + "/openai", "whisper-large-v3", "groq")
        r = stt.transcribe(np.zeros(8000, np.float32), None, final=True)
        self.assertEqual((r.text, r.language), ("bonjour", "fr"))
        self.assertIn(b'name="model"', Mock.seen[-1][2])
        llm = OpenAIChatLLM(self.base + "/openai", "qwen", "K")
        self.assertTrue(llm.info.local)  # 127.0.0.1 counts as local infrastructure
        mt = LLMTranslator(llm)
        out = mt.translate(["Hello everyone"], "en", "fr", mode="cultural",
                           glossary=[GlossaryTerm("Ade", "Adé")], context=["prev line"])
        self.assertEqual(out[0].text, "Salut tout le monde")
        self.assertEqual(out[0].note, "idiom: x = y")
        req = json.loads(Mock.seen[-1][2])
        self.assertIn('"Ade" => "Adé"', req["messages"][0]["content"])
        self.assertIn("prev line", req["messages"][1]["content"])
        # server without JSON mode: falls back transparently
        self.assertTrue(OpenAIChatLLM(self.base + "/openai", "nojson").chat("s", "u", json_mode=True))
        chunks = list(OpenAITTS("K", self.base + "/openai").synthesize("hi", "en"))
        self.assertEqual(sum(c.size for c, _ in chunks), 24000)
        self.assertEqual(chunks[0][1], 24000)

    def test_deepl_google_elevenlabs(self):
        from translator_worker.providers.mt_cloud import DeepLTranslator, GoogleTranslator
        from translator_worker.providers.tts_cloud import ElevenLabsTTS
        self.assertEqual(DeepLTranslator("x:fx").translate(["Hi"], "en", "de")[0].text, "Hallo")
        self.assertEqual(json.loads(Mock.seen[-1][2])["target_lang"], "DE")
        self.assertEqual(GoogleTranslator("g").translate(["Hi"], "en", "yo")[0].text, "Ẹ n l'ẹ")
        self.assertIn("key=g", Mock.seen[-1][0])
        chunks = list(ElevenLabsTTS("e", "voice1").synthesize("hi", "en"))
        self.assertEqual(sum(c.size for c, _ in chunks), 24000)
        self.assertIn("output_format=pcm_24000", Mock.seen[-1][0])


if __name__ == "__main__":
    unittest.main()
