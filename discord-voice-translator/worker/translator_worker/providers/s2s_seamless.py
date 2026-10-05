"""EXPERIMENTAL end-to-end speech-to-speech translation with SeamlessM4T v2.

Implements the S2SModel interface so a direct speech->speech model can be
swapped in for the STT->MT->TTS cascade. Not enabled by default: it is
CC-BY-NC 4.0, large (2.3B), not streaming in this form, and loses the
per-stage captions/glossary control the cascade gives. Enable with
`TW__S2S__ENABLED=1` once evaluated on your languages (see docs/ARCHITECTURE.md).
"""

from __future__ import annotations

import threading

import numpy as np

from .. import languages as L
from .base import ProviderInfo


class SeamlessS2S:
    sample_rate = 16000

    def __init__(self, device: str = "cuda", repo: str = "facebook/seamless-m4t-v2-large"):
        import torch  # type: ignore
        from transformers import AutoProcessor, SeamlessM4Tv2Model  # type: ignore

        self.torch = torch
        self.device = device if torch.cuda.is_available() else "cpu"
        self.processor = AutoProcessor.from_pretrained(repo)
        self.model = SeamlessM4Tv2Model.from_pretrained(repo).to(self.device).eval()
        self._lock = threading.Lock()
        self.info = ProviderInfo("seamless_m4t_v2", "s2s", local=True, license="CC-BY-NC-4.0",
                                 commercial_ok=False, max_concurrency=1)

    def supports(self, src: str, tgt: str) -> bool:
        l = L.get(tgt)
        return bool(l and l.mms_iso3)  # SeamlessM4T uses ISO-639-3 codes; speech output covers ~35 langs

    def translate_speech(self, audio: np.ndarray, src, tgt):
        code = L.get(tgt).mms_iso3
        with self._lock:
            inputs = self.processor(audios=audio, sampling_rate=16000, return_tensors="pt").to(self.device)
            with self.torch.no_grad():
                out = self.model.generate(**inputs, tgt_lang=code)[0]
        yield out.cpu().numpy().squeeze().astype(np.float32), 16000
