"""Meta MMS-TTS (VITS) for languages without a Piper voice (Yoruba, Hausa,
Igbo, ...). Licence: CC-BY-NC 4.0 -> disabled when COMMERCIAL=true.
Needs torch + transformers (requirements-extras.txt). Scripts that are not
Latin need the `uroman` package for romanisation."""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict

import numpy as np

from .. import languages as L
from .base import ProviderInfo, ProviderUnavailable

log = logging.getLogger("tts.mms")


class MMSTTS:
    clones = False
    sample_rate = 16000

    def __init__(self, langs: list[str], *, device: str = "cpu", cache_dir: str | None = None, max_loaded: int = 4):
        import torch  # type: ignore
        from transformers import AutoTokenizer, VitsModel  # noqa: F401  # type: ignore

        self.torch = torch
        self.device = "cuda" if device == "cuda" and torch.cuda.is_available() else "cpu"
        self.cache_dir = cache_dir
        self._langs = {l for l in langs if L.get(l) and L.get(l).mms_iso3}
        self._models: OrderedDict[str, tuple] = OrderedDict()
        self._max = max_loaded
        self._lock = threading.Lock()
        self.info = ProviderInfo("mms_tts", "tts", local=True, license="CC-BY-NC-4.0", commercial_ok=False,
                                 streaming=False, max_concurrency=1)

    def supports(self, lang: str) -> bool:
        return lang in self._langs

    def _model(self, lang: str):
        from transformers import AutoTokenizer, VitsModel  # type: ignore

        if lang in self._models:
            self._models.move_to_end(lang)
            return self._models[lang]
        repo = f"facebook/mms-tts-{L.get(lang).mms_iso3}"
        try:
            tok = AutoTokenizer.from_pretrained(repo, cache_dir=self.cache_dir)
            model = VitsModel.from_pretrained(repo, cache_dir=self.cache_dir).to(self.device).eval()
        except Exception as e:  # noqa: BLE001
            self._langs.discard(lang)
            raise ProviderUnavailable(f"{repo} unavailable: {e}")
        self._models[lang] = (tok, model)
        while len(self._models) > self._max:
            self._models.popitem(last=False)
        return tok, model

    def warm(self, lang: str) -> None:
        with self._lock:
            self._model(lang)

    def synthesize(self, text, lang, *, voice=None, prosody=None):
        import re

        sentences = [s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s] or [text]
        for s in sentences:
            with self._lock:
                tok, model = self._model(lang)
                if prosody:
                    model.speaking_rate = float(np.clip(prosody.rate, 0.8, 1.25))
                inputs = tok(s, return_tensors="pt").to(self.device)
                with self.torch.no_grad():
                    wav = model(**inputs).waveform[0].float().cpu().numpy()
                sr = int(model.config.sampling_rate)
            yield wav.astype(np.float32), sr
