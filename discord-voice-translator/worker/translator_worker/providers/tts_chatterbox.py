"""Chatterbox Multilingual (Resemble AI) zero-shot voice cloning.

Licence: MIT (commercial use OK). Output carries Resemble's imperceptible
Perth watermark. 23 languages. GPU strongly recommended (CPU is far slower
than real time). Only used for speakers who completed /voice enroll.

Conditioning (the speaker embedding) is computed once per speaker from the
decrypted reference audio and cached in GPU memory; the reference audio is
written to a RAM-backed temp file only for the duration of that call.
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
import threading
from collections import OrderedDict

import numpy as np

from .. import languages as L
from .base import ProviderInfo, ProviderUnavailable

log = logging.getLogger("tts.chatterbox")
_SPLIT = re.compile(r"(?<=[.!?。！？;])\s+")


class ChatterboxCloneTTS:
    clones = True
    sample_rate = 24000

    def __init__(self, device: str = "cuda", max_cached: int = 16):
        try:
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # type: ignore
        except Exception as e:  # pragma: no cover
            raise ProviderUnavailable(f"chatterbox-tts not installed: {e}")
        try:
            self.model = ChatterboxMultilingualTTS.from_pretrained(device=device, t3_model="v3")
        except TypeError:  # older releases without the t3_model switch
            self.model = ChatterboxMultilingualTTS.from_pretrained(device=device)
        self.sample_rate = int(getattr(self.model, "sr", 24000))
        self._default_conds = getattr(self.model, "conds", None)
        self._conds: OrderedDict[str, object] = OrderedDict()
        self._max = max_cached
        self._lock = threading.Lock()
        self.info = ProviderInfo("chatterbox_mtl", "tts", local=True, license="MIT", commercial_ok=True,
                                 streaming=False, max_concurrency=1)

    def supports(self, lang: str) -> bool:
        return lang in L.CHATTERBOX_LANGS

    def _conditionals(self, voice, expressiveness: float):
        key = f"{voice.user_id}:{voice.cache_key}"
        if key in self._conds:
            self._conds.move_to_end(key)
            return self._conds[key]
        shm = "/dev/shm" if os.path.isdir("/dev/shm") else None
        with tempfile.NamedTemporaryFile(suffix=".wav", dir=shm, delete=True) as f:
            import wave
            pcm = (np.clip(voice.reference_wav, -1, 1) * 32767).astype("<i2").tobytes()
            with wave.open(f.name, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(voice.reference_rate)
                w.writeframes(pcm)
            self.model.prepare_conditionals(f.name, exaggeration=0.5)
        conds = self.model.conds
        self._conds[key] = conds
        while len(self._conds) > self._max:
            self._conds.popitem(last=False)
        return conds

    def synthesize(self, text, lang, *, voice=None, prosody=None):
        if lang not in L.CHATTERBOX_LANGS:
            raise ProviderUnavailable(f"Chatterbox does not support {lang}")
        expr = prosody.expressiveness if prosody else 0.5
        exaggeration = float(np.clip(0.3 + 0.5 * expr, 0.25, 0.85))
        sentences = [s for s in _SPLIT.split(text.strip()) if s] or [text]
        for s in sentences:  # sentence-by-sentence so first audio comes early
            with self._lock:
                self.model.conds = self._conditionals(voice, expr) if voice and voice.reference_wav is not None \
                    else self._default_conds
                wav = self.model.generate(s, language_id=lang, exaggeration=exaggeration, cfg_weight=0.5)
            y = wav.squeeze().detach().float().cpu().numpy() if hasattr(wav, "detach") else np.asarray(wav)
            yield y.astype(np.float32), self.sample_rate
