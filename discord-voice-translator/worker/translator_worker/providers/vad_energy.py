"""Energy-based VAD with an adaptive noise floor.

Used as a fallback when the Silero ONNX model is unavailable, and in tests.
Much weaker than Silero on noisy audio (keyboard, music), so the worker logs a
warning when it is active in production.
"""

from __future__ import annotations

import math

import numpy as np

from .base import ProviderInfo


class _State:
    __slots__ = ("floor_db", "n")

    def __init__(self) -> None:
        self.floor_db = -60.0
        self.n = 0


class EnergyVAD:
    info = ProviderInfo("energy_vad", "vad", local=True, license="MIT", commercial_ok=True, max_concurrency=64)
    window = 512

    def __init__(self, margin_db: float = 14.0, abs_floor_db: float = -50.0):
        self.margin = margin_db
        self.abs_floor = abs_floor_db

    def new_state(self) -> _State:
        return _State()

    def prob(self, state: _State, window: np.ndarray) -> float:
        r = float(np.sqrt(np.mean(np.square(window, dtype=np.float64))))
        db = 20.0 * math.log10(max(r, 1e-7))
        # track the noise floor: fast down, slow up
        if state.n == 0:
            state.floor_db = min(db, -45.0)
        elif db < state.floor_db:
            state.floor_db = 0.7 * state.floor_db + 0.3 * db
        else:
            state.floor_db = 0.995 * state.floor_db + 0.005 * db
        state.n += 1
        x = (db - max(state.floor_db, -70.0) - self.margin) / 3.0
        p = 1.0 / (1.0 + math.exp(-x))
        if db < self.abs_floor:
            p = min(p, 0.05)
        return p
