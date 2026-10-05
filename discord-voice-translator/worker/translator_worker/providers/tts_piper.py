"""Piper TTS (piper-tts >= 1.3, OHF-Voice/piper1-gpl).

Licence: the piper1-gpl *engine* is GPL-3.0 (we call it as a library in a
separate worker process - review GPL obligations if you redistribute the
worker image). Each *voice* has its own licence, recorded in its MODEL_CARD;
many are CC-BY or public-domain datasets, some are non-commercial.

Voices are pre-downloaded by scripts/download_models.py into
$MODELS_DIR/piper/<voice>.onnx(+.json). Missing voices for a requested
language are resolved from voices.json (prefer medium quality) and fetched on
first use if `allow_download` is on.
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
import threading
from pathlib import Path

import numpy as np

from .. import languages as L
from .base import ProviderInfo, ProviderUnavailable

log = logging.getLogger("tts.piper")
QUALITY_ORDER = {"medium": 0, "high": 1, "low": 2, "x_low": 3}


class PiperTTS:
    clones = False
    sample_rate = 22050  # default; actual rate is per voice and yielded with each chunk

    def __init__(self, voices_dir: str, preferred: dict[str, str] | None = None, *, use_cuda: bool = False,
                 allow_download: bool = True, preload: list[str] | None = None):
        try:
            from piper import PiperVoice  # type: ignore  # noqa: F401
        except Exception as e:  # pragma: no cover
            raise ProviderUnavailable(f"piper-tts not installed: {e}")
        self.dir = Path(voices_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.preferred = {**L.PIPER_PREFERRED, **(preferred or {})}
        self.use_cuda = use_cuda
        self.allow_download = allow_download
        self._voices: dict[str, object] = {}
        self._lock = threading.Lock()          # espeak-ng phonemizer is not thread-safe
        self._catalog = self._load_catalog()
        self.info = ProviderInfo("piper", "tts", local=True, license="GPL-3.0 engine; per-voice licences",
                                 commercial_ok=True, streaming=True, max_concurrency=1)
        for lang in preload or []:
            try:
                self._voice(lang)
            except Exception as e:  # noqa: BLE001
                log.warning("could not preload Piper voice for %s: %s", lang, e)

    # ------------------------------------------------------------------
    def _load_catalog(self) -> dict[str, list[str]]:
        """family -> voice keys, from a cached voices.json if present."""
        cat: dict[str, list[str]] = {}
        p = self.dir / "voices.json"
        if p.exists():
            try:
                data = json.loads(p.read_text())
                for key, v in data.items():
                    fam = v.get("language", {}).get("family")
                    if fam:
                        cat.setdefault(fam, []).append(key)
                for fam in cat:
                    cat[fam].sort(key=lambda k: QUALITY_ORDER.get(k.rsplit("-", 1)[-1], 9))
            except Exception as e:  # noqa: BLE001
                log.warning("bad voices.json: %s", e)
        return cat

    def _installed(self) -> dict[str, Path]:
        return {p.stem: p for p in self.dir.glob("*.onnx")}

    def families(self) -> set[str]:
        fams = {k.split("_")[0] for k in self._installed()}
        if self.allow_download:
            fams |= set(self._catalog) or set(L.PIPER_FAMILIES)
        return fams

    def supports(self, lang: str) -> bool:
        return lang in self.families()

    def _pick_key(self, lang: str) -> str | None:
        inst = self._installed()
        pref = self.preferred.get(lang)
        if pref and pref in inst:
            return pref
        for k in sorted(inst, key=lambda k: QUALITY_ORDER.get(k.rsplit("-", 1)[-1], 9)):
            if k.split("_")[0] == lang:
                return k
        if pref:
            return pref
        cands = self._catalog.get(lang)
        return cands[0] if cands else None

    def _voice(self, lang: str):
        if lang in self._voices:
            return self._voices[lang]
        from piper import PiperVoice  # type: ignore

        key = self._pick_key(lang)
        if not key:
            raise ProviderUnavailable(f"no Piper voice for {lang}")
        path = self.dir / f"{key}.onnx"
        if not path.exists():
            if not self.allow_download:
                raise ProviderUnavailable(f"Piper voice {key} not installed")
            log.info("downloading Piper voice %s", key)
            subprocess.run([sys.executable, "-m", "piper.download_voices", "--data-dir", str(self.dir), key],
                           check=True, timeout=600)
        v = PiperVoice.load(str(path), use_cuda=self.use_cuda)
        self._voices[lang] = v
        return v

    def warm(self, lang: str) -> None:
        self._voice(lang)

    def synthesize(self, text, lang, *, voice=None, prosody=None):
        from piper import SynthesisConfig  # type: ignore

        v = self._voice(lang)
        cfg = SynthesisConfig()
        if prosody:
            cfg.length_scale = float(1.0 / max(0.5, prosody.rate))
            cfg.volume = float(np.clip(prosody.energy, 0.7, 1.3))
        with self._lock:
            chunks = list(v.synthesize(text, syn_config=cfg)) if len(text) < 80 else None
        if chunks is not None:
            for c in chunks:
                yield np.frombuffer(c.audio_int16_bytes, dtype="<i2").astype(np.float32) / 32768.0, c.sample_rate
            return
        # long text: release the lock between sentences so other dubs interleave
        it = v.synthesize(text, syn_config=cfg)
        while True:
            with self._lock:
                c = next(it, None)
            if c is None:
                break
            yield np.frombuffer(c.audio_int16_bytes, dtype="<i2").astype(np.float32) / 32768.0, c.sample_rate
