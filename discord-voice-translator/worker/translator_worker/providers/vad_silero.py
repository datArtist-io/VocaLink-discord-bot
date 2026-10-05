"""Silero VAD (v5/v6 ONNX) via onnxruntime — no torch needed.

Model file: `silero_vad.onnx` from github.com/snakers4/silero-vad
(src/silero_vad/data/silero_vad.onnx, MIT licence). scripts/download_models.py
fetches it into $MODELS_DIR/silero/silero_vad.onnx.

The v5 interface: input [B, 64 + 512] (64 samples of context + window),
state [2, B, 128], sr int64 -> output [B, 1], new state.
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np

from .base import ProviderInfo, ProviderUnavailable

CONTEXT = 64
WINDOW = 512


class _State:
    __slots__ = ("h", "ctx")

    def __init__(self) -> None:
        self.h = np.zeros((2, 1, 128), dtype=np.float32)
        self.ctx = np.zeros((1, CONTEXT), dtype=np.float32)


class SileroVAD:
    info = ProviderInfo("silero_vad", "vad", local=True, license="MIT", commercial_ok=True, max_concurrency=64)
    window = WINDOW

    def __init__(self, model_path: str | os.PathLike, threads: int = 1):
        try:
            import onnxruntime as ort  # type: ignore
        except Exception as e:  # pragma: no cover
            raise ProviderUnavailable(f"onnxruntime not installed: {e}")
        path = Path(model_path)
        if not path.exists():
            raise ProviderUnavailable(f"Silero model not found at {path}")
        so = ort.SessionOptions()
        so.inter_op_num_threads = 1
        so.intra_op_num_threads = threads
        self.sess = ort.InferenceSession(str(path), sess_options=so, providers=["CPUExecutionProvider"])
        self._sr = np.array(16000, dtype=np.int64)
        names = {i.name for i in self.sess.get_inputs()}
        if not {"input", "state", "sr"} <= names:
            raise ProviderUnavailable(f"unexpected Silero ONNX inputs {names}; need the v5/v6 model")

    def new_state(self) -> _State:
        return _State()

    def prob(self, state: _State, window: np.ndarray) -> float:
        x = window.reshape(1, -1).astype(np.float32, copy=False)
        inp = np.concatenate([state.ctx, x], axis=1)
        out, h = self.sess.run(None, {"input": inp, "state": state.h, "sr": self._sr})
        state.h = h
        state.ctx = inp[:, -CONTEXT:]
        return float(out.reshape(-1)[0])


def find_model(models_dir: str) -> Path | None:
    cands = [Path(models_dir) / "silero" / "silero_vad.onnx"]
    try:  # faster-whisper ships a copy of the Silero model in its assets
        import faster_whisper  # type: ignore
        assets = Path(faster_whisper.__file__).parent / "assets"
        cands += sorted(assets.glob("silero_vad*.onnx"), reverse=True)
    except Exception:
        pass
    for c in cands:
        if c.exists():
            return c
    return None
