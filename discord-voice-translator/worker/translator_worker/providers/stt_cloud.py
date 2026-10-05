"""Optional cloud STT plug-ins (used only when a key is configured)."""

from __future__ import annotations

import numpy as np

from .. import languages as L
from . import http
from .base import ProviderInfo, STTResult, Word

# Deepgram Nova-3 languages (conservative list; "multi" handles code-switching
# for the major ones). Check developers.deepgram.com for the current list.
DEEPGRAM_LANGS = set("en es fr de hi ru pt ja it nl ko zh sv da no fi pl tr uk id ms vi th ta bg cs el hu ro sk lt lv et ca".split())


class DeepgramSTT:
    detects_language = True

    def __init__(self, api_key: str, model: str = "nova-3"):
        self.key = api_key
        self.model = model
        self.info = ProviderInfo(f"deepgram:{model}", "stt", local=False, license="proprietary-api",
                                 commercial_ok=True, cost_per_hour_usd=0.46, max_concurrency=16)

    def languages(self) -> set[str]:
        return DEEPGRAM_LANGS

    def grade_for(self, code: str) -> str:
        return "good" if code in DEEPGRAM_LANGS else "none"

    def detect_language(self, audio: np.ndarray) -> dict[str, float]:
        r = self._call(audio, None)
        return r.language_probs or {r.language: r.language_prob}

    def transcribe(self, audio, language, *, final, prompt=None, hotwords=None) -> STTResult:
        return self._call(audio, language, hotwords)

    def _call(self, audio, language, hotwords=None) -> STTResult:
        params = {"model": self.model, "smart_format": "true", "punctuate": "true"}
        if language:
            params["language"] = language
        else:
            params["detect_language"] = "true"
        if hotwords:
            params["keyterm"] = hotwords[:200]
        r = http.request("POST", "https://api.deepgram.com/v1/listen", params=params,
                         headers={"Authorization": f"Token {self.key}", "Content-Type": "audio/wav"},
                         data=http.wav_bytes(audio), timeout=15).raise_for_status("deepgram")
        ch = r.json()["results"]["channels"][0]
        alt = ch["alternatives"][0]
        lang = L.normalize(ch.get("detected_language") or language or "en")
        lp = float(ch.get("language_confidence") or (1.0 if language else 0.5))
        conf = float(alt.get("confidence") or 0.5)
        text = alt.get("transcript", "")
        return STTResult(text=text, language=lang, language_prob=lp, language_probs={lang: lp},
                         words=[Word(w.get("punctuated_word") or w["word"], w["start"], w["end"], w.get("confidence", 1))
                                for w in alt.get("words", [])],
                         avg_logprob=float(np.log(max(conf, 1e-4))), no_speech_prob=0.0 if text else 0.9,
                         provider=self.info.name)


class OpenAICompatSTT:
    """Whisper behind an OpenAI-compatible /audio/transcriptions endpoint
    (OpenAI, Groq, a self-hosted faster-whisper-server, ...)."""

    detects_language = True

    def __init__(self, api_key: str, base_url: str, model: str, name: str, cost_per_hour: float = 0.36):
        self.key = api_key
        self.base = base_url.rstrip("/")
        self.model = model
        self.info = ProviderInfo(f"{name}:{model}", "stt", local=False, license="proprietary-api",
                                 commercial_ok=True, cost_per_hour_usd=cost_per_hour, max_concurrency=8)

    def languages(self) -> set[str]:
        return set(L.WHISPER_CODES)

    def grade_for(self, code: str) -> str:
        lang = L.get(code)
        return lang.stt_grade if lang else "none"

    def detect_language(self, audio):
        r = self.transcribe(audio, None, final=True)
        return r.language_probs or {r.language: r.language_prob}

    def transcribe(self, audio, language, *, final, prompt=None, hotwords=None) -> STTResult:
        fields = {"model": self.model, "response_format": "verbose_json", "temperature": "0"}
        if language:
            fields["language"] = language
        if prompt or hotwords:
            fields["prompt"] = " ".join(x for x in (prompt, hotwords) if x)[:800]
        body, ctype = http.multipart(fields, {"file": ("audio.wav", http.wav_bytes(audio), "audio/wav")})
        r = http.request("POST", f"{self.base}/audio/transcriptions", data=body,
                         headers={"Authorization": f"Bearer {self.key}", "Content-Type": ctype},
                         timeout=20).raise_for_status(self.info.name)
        d = r.json()
        lang_name = (d.get("language") or language or "english").lower()
        code = language or next((c for c, l in L.LANGUAGES.items() if l.name.lower() == lang_name),
                                L.normalize(lang_name))
        segs = d.get("segments") or []
        avg_lp = float(np.mean([s.get("avg_logprob", -0.3) for s in segs])) if segs else -0.3
        nsp = float(max((s.get("no_speech_prob", 0.0) for s in segs), default=0.0))
        text = d.get("text", "").strip()
        return STTResult(text=text, language=code, language_prob=0.8, language_probs={code: 0.8},
                         words=[Word(w, 0, 0) for w in text.split()], avg_logprob=avg_lp, no_speech_prob=nsp,
                         provider=self.info.name)
