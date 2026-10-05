"""Meta MMS-1b-all CTC speech recognition with per-language adapters.

Used for languages Whisper cannot recognise (Igbo). Licence: CC-BY-NC 4.0
(non-commercial). Needs torch + transformers (requirements-extras.txt).
No language identification: speakers must set /mylang speak:ig.
"""

from __future__ import annotations

import threading

import numpy as np

from .. import languages as L
from .base import ProviderInfo, STTResult, Word


class MMSASR:
    detects_language = False

    def __init__(self, langs: list[str], device: str = "cpu", repo: str = "facebook/mms-1b-all",
                 cache_dir: str | None = None):
        import torch  # type: ignore
        from transformers import AutoProcessor, Wav2Vec2ForCTC  # type: ignore

        self.torch = torch
        self.device = "cuda" if device == "cuda" and torch.cuda.is_available() else "cpu"
        self.processor = AutoProcessor.from_pretrained(repo, cache_dir=cache_dir)
        self.model = Wav2Vec2ForCTC.from_pretrained(repo, cache_dir=cache_dir).to(self.device).eval()
        self._langs = {l for l in langs if L.get(l) and L.get(l).mms_iso3}
        self._current = None
        self._lock = threading.Lock()
        self.info = ProviderInfo("mms_asr", "stt", local=True, license="CC-BY-NC-4.0", commercial_ok=False,
                                 max_concurrency=1)

    def languages(self) -> set[str]:
        return self._langs

    def grade_for(self, code: str) -> str:
        return "fair" if code in self._langs else "none"

    def detect_language(self, audio):
        raise NotImplementedError("MMS ASR has no language identification")

    def transcribe(self, audio: np.ndarray, language, *, final, prompt=None, hotwords=None) -> STTResult:
        if language not in self._langs:
            from .base import ProviderUnavailable
            raise ProviderUnavailable(f"MMS ASR not configured for {language}")
        iso = L.get(language).mms_iso3
        with self._lock:
            if self._current != iso:
                self.processor.tokenizer.set_target_lang(iso)
                self.model.load_adapter(iso)
                self._current = iso
            inputs = self.processor(audio, sampling_rate=16000, return_tensors="pt").to(self.device)
            with self.torch.no_grad():
                logits = self.model(**inputs).logits
            ids = self.torch.argmax(logits, dim=-1)[0]
            text = self.processor.decode(ids)
            probs = self.torch.softmax(logits, dim=-1).max(dim=-1).values.mean().item()
        return STTResult(text=text.strip(), language=language, language_prob=1.0, words=[Word(w, 0, 0) for w in text.split()],
                         avg_logprob=float(np.log(max(probs, 1e-6))), no_speech_prob=0.0, provider=self.info.name)
