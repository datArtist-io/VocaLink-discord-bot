"""Optional cloud TTS plug-ins (house voices only - we never upload user voices)."""

from __future__ import annotations

import numpy as np

from .. import languages as L
from . import http
from .base import ProviderInfo

ELEVEN_FLASH_LANGS = set("en ja zh de hi fr ko pt it es id nl tr tl pl sv bg ro ar cs el fi hr ms sk da ta uk ru hu no vi".split())


def _pcm_chunks(it, rate: int, min_bytes: int = 4800):
    buf = b""
    for b in it:
        buf += b
        if len(buf) >= min_bytes:
            n = len(buf) // 2 * 2
            yield np.frombuffer(buf[:n], dtype="<i2").astype(np.float32) / 32768.0, rate
            buf = buf[n:]
    if len(buf) >= 2:
        n = len(buf) // 2 * 2
        yield np.frombuffer(buf[:n], dtype="<i2").astype(np.float32) / 32768.0, rate


class ElevenLabsTTS:
    clones = False
    sample_rate = 24000

    def __init__(self, api_key: str, voice_id: str, model: str = "eleven_flash_v2_5"):
        self.key = api_key
        self.voice = voice_id
        self.model = model
        self.info = ProviderInfo(f"elevenlabs:{model}", "tts", local=False, license="proprietary-api",
                                 commercial_ok=True, streaming=True, cost_per_hour_usd=1.5, max_concurrency=4)

    def supports(self, lang):
        return lang in ELEVEN_FLASH_LANGS

    def synthesize(self, text, lang, *, voice=None, prosody=None):
        url = (f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice}/stream"
               f"?output_format=pcm_{self.sample_rate}")
        body = {"text": text, "model_id": self.model, "language_code": lang}
        if prosody:
            body["voice_settings"] = {"speed": float(np.clip(prosody.rate, 0.8, 1.2))}
        yield from _pcm_chunks(http.stream("POST", url, json=body, headers={"xi-api-key": self.key}, timeout=20),
                               self.sample_rate)


class OpenAITTS:
    clones = False
    sample_rate = 24000

    def __init__(self, api_key: str, base_url: str = "https://api.openai.com/v1", model: str = "gpt-4o-mini-tts",
                 voice: str = "alloy"):
        self.key = api_key
        self.base = base_url.rstrip("/")
        self.model = model
        self.voice = voice
        self.info = ProviderInfo(f"openai_tts:{model}", "tts", local=False, license="proprietary-api",
                                 commercial_ok=True, streaming=True, cost_per_hour_usd=0.9, max_concurrency=4)

    def supports(self, lang):
        l = L.get(lang)
        return bool(l and l.whisper and l.stt_grade in ("good", "fair"))

    def synthesize(self, text, lang, *, voice=None, prosody=None):
        body = {"model": self.model, "voice": self.voice, "input": text, "response_format": "pcm"}
        if prosody:
            body["speed"] = float(np.clip(prosody.rate, 0.8, 1.2))
        yield from _pcm_chunks(http.stream("POST", f"{self.base}/audio/speech", json=body,
                                           headers={"Authorization": f"Bearer {self.key}"}, timeout=20),
                               self.sample_rate)
