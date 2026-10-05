"""Deterministic stand-in models for tests and dry runs (FAKE_MODELS=1).

The fake TTS *encodes* "lang|text" into audio with a 16-tone FSK modem and the
fake STT *decodes* it again, so the whole real pipeline (VAD endpointing,
partials, LocalAgreement, LID smoothing, routing, MT, streaming TTS,
resampling, protocol) can be exercised end-to-end without ML models. Partial
audio decodes to a prefix of the text, exactly like a real streaming decode.
"""

from __future__ import annotations

import time
from typing import Iterator

import numpy as np

from .. import languages as L
from .base import MTResult, ProviderInfo, STTResult, Word

SYMBOL_S = 0.04
BASE_HZ = 500.0
STEP_HZ = 100.0
AMP = 0.3


# ---------------------------------------------------------------- modem
def modem_encode(text: str, sr: int, lang: str = "en", gap_s: float = 0.0) -> np.ndarray:
    data = f"{lang}|{text}".encode("utf-8")
    n = int(sr * SYMBOL_S)
    t = np.arange(n) / sr
    ramp = max(1, int(0.004 * sr))
    env = np.ones(n, dtype=np.float32)
    env[:ramp] = np.linspace(0, 1, ramp)
    env[-ramp:] = np.linspace(1, 0, ramp)
    out = []
    for b in data:
        for nib in (b >> 4, b & 0xF):
            f = BASE_HZ + STEP_HZ * nib
            out.append((AMP * np.sin(2 * np.pi * f * t) * env).astype(np.float32))
    audio = np.concatenate(out) if out else np.zeros(0, dtype=np.float32)
    if gap_s:
        audio = np.concatenate([audio, np.zeros(int(gap_s * sr), dtype=np.float32)])
    return audio


def _runs(audio: np.ndarray, sr: int) -> list[tuple[int, int]]:
    """Find contiguous non-silent regions (onset/offset), 5 ms resolution."""
    hop = max(1, int(0.005 * sr))
    frames = audio[: audio.size - audio.size % hop].reshape(-1, hop) if audio.size >= hop else np.zeros((0, hop))
    loud = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1)) > 0.02
    runs, start = [], None
    quiet = 0
    for i, l in enumerate(loud):
        if l:
            if start is None:
                start = i
            quiet = 0
        elif start is not None:
            quiet += 1
            if quiet * hop >= int(0.06 * sr):  # 60 ms of silence ends a run
                runs.append((start * hop, (i - quiet + 1) * hop))
                start, quiet = None, 0
    if start is not None:
        runs.append((start * hop, (len(loud) - quiet) * hop))
    return runs


def modem_decode_runs(audio: np.ndarray, sr: int) -> list[tuple[str, str]]:
    """Return [(lang, text)] per sound run. Incomplete trailing symbols are ignored."""
    n = int(sr * SYMBOL_S)
    out: list[tuple[str, str]] = []
    for a, b in _runs(audio, sr):
        nibbles = []
        k = a
        while k + n <= b + int(0.004 * sr):
            seg = audio[k + n // 5 : k + n - n // 5].astype(np.float64)
            if seg.size < 8:
                break
            spec = np.abs(np.fft.rfft(seg * np.hanning(seg.size), n=4096))
            freqs = np.fft.rfftfreq(4096, 1 / sr)
            f = freqs[int(np.argmax(spec))]
            nib = int(round((f - BASE_HZ) / STEP_HZ))
            if 0 <= nib <= 15:
                nibbles.append(nib)
            k += n
        if len(nibbles) % 2:
            nibbles = nibbles[:-1]
        bs = bytes((nibbles[i] << 4) | nibbles[i + 1] for i in range(0, len(nibbles), 2))
        s = bs.decode("utf-8", errors="ignore")
        if "|" in s:
            lang, text = s.split("|", 1)
            out.append((lang, text))
        elif s:
            out.append(("", ""))  # still inside the language tag
    return out


# ---------------------------------------------------------------- models
class FakeSTT:
    info = ProviderInfo("faster_whisper:fake", "stt", local=True, license="MIT", commercial_ok=True,
                        max_concurrency=8)
    detects_language = True

    def __init__(self, delay_s: float = 0.0):
        self.delay = delay_s
        self.calls = {"partial": 0, "final": 0, "detect": 0}

    def languages(self) -> set[str]:
        return set(L.WHISPER_CODES)

    def _probs(self, runs) -> dict[str, float]:
        weights: dict[str, float] = {}
        for lang, text in runs:
            if lang:
                weights[lang] = weights.get(lang, 0) + len(text) + 1
        tot = sum(weights.values())
        if not tot:
            return {"en": 0.34, "fr": 0.33, "de": 0.33}
        probs = {k: 0.92 * v / tot for k, v in weights.items()}
        probs["xx_other"] = 0.08
        return probs

    def detect_language(self, audio: np.ndarray) -> dict[str, float]:
        self.calls["detect"] += 1
        p = self._probs(modem_decode_runs(audio, 16000))
        p.pop("xx_other", None)
        return p

    def transcribe(self, audio, language, *, final, prompt=None, hotwords=None) -> STTResult:
        self.calls["final" if final else "partial"] += 1
        if self.delay:
            time.sleep(self.delay)
        runs = modem_decode_runs(audio, 16000)
        probs = self._probs(runs)
        probs.pop("xx_other", None)
        text = " ".join(t for _, t in runs if t).strip()
        detected = max(probs, key=probs.get) if probs else (language or "en")
        lang = language or detected
        words = [Word(w, 0.0, 0.0, 0.95) for w in text.split()]
        return STTResult(text=text, language=lang, language_prob=probs.get(lang, 0.0),
                         language_probs=probs if language is None else None, words=words,
                         avg_logprob=-0.2 if text else -1.5, no_speech_prob=0.01 if text else 0.9,
                         provider=self.info.name)


class FakeMT:
    info = ProviderInfo("fake_mt", "mt", local=True, license="MIT", commercial_ok=True, max_concurrency=8)
    modes = ("literal",)

    def __init__(self, delay_s: float = 0.0, unsupported: set[str] | None = None):
        self.delay = delay_s
        self.unsupported = unsupported or set()

    def supports(self, src: str, tgt: str) -> bool:
        return tgt not in self.unsupported and src not in self.unsupported

    def translate(self, texts, src, tgt, *, mode="literal", glossary=None, context=None):
        if self.delay:
            time.sleep(self.delay)
        return [MTResult(f"[{tgt}] {t}", self.info.name, "literal") for t in texts]


class FakeLLMMT(FakeMT):
    info = ProviderInfo("fake_llm_mt", "mt", local=True, license="MIT", commercial_ok=True)
    modes = ("literal", "natural", "cultural")

    def translate(self, texts, src, tgt, *, mode="literal", glossary=None, context=None):
        return [MTResult(f"[{tgt}~{mode}] {t}", self.info.name, mode) for t in texts]


class FakeTTS:
    info = ProviderInfo("fake_tts", "tts", local=True, license="MIT", commercial_ok=True, streaming=True)
    sample_rate = 22050
    clones = False

    def __init__(self, langs: set[str] | None = None, delay_s: float = 0.0):
        self.langs = langs
        self.delay = delay_s

    def supports(self, lang: str) -> bool:
        return self.langs is None or lang in self.langs

    def synthesize(self, text, lang, *, voice=None, prosody=None) -> Iterator[np.ndarray]:
        audio = modem_encode(text, self.sample_rate, lang=lang)
        half = (audio.size // 2) // 2 * 2
        if self.delay:
            time.sleep(self.delay)
        yield audio[:half]
        yield audio[half:]


class FakeCloneTTS(FakeTTS):
    info = ProviderInfo("fake_clone", "tts", local=True, license="MIT", commercial_ok=True, streaming=True)
    clones = True

    def __init__(self, langs: set[str] | None = None):
        super().__init__(langs or set(L.CHATTERBOX_LANGS))
        self.last_voice = None

    def synthesize(self, text, lang, *, voice=None, prosody=None):
        self.last_voice = voice
        yield from super().synthesize(text, lang, voice=voice, prosody=prosody)


class FakeLLM:
    info = ProviderInfo("fake_llm", "llm", local=True, license="MIT", commercial_ok=True)

    def chat(self, system, user, *, max_tokens=512, temperature=0.2, json_mode=False) -> str:
        if json_mode:
            return '{"summary": "Fake summary.", "action_items": ["Fake action"]}'
        return "Fake summary."
