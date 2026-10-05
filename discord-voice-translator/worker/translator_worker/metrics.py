"""Per-stage latency recording and percentiles (no external deps)."""

from __future__ import annotations

import time
from collections import Counter, defaultdict, deque

STAGES = ("vad_endpoint", "lid", "stt_partial", "stt_final", "mt", "tts_first_audio",
          "end_to_caption", "end_to_first_audio", "queue_wait")


class Metrics:
    def __init__(self, window: int = 2000):
        self.samples: dict[str, deque[float]] = defaultdict(lambda: deque(maxlen=window))
        self.counters: Counter[str] = Counter()
        self.started = time.time()

    def observe(self, stage: str, ms: float) -> None:
        self.samples[stage].append(float(ms))

    def inc(self, name: str, n: int = 1) -> None:
        self.counters[name] += n

    @staticmethod
    def _pct(xs: list[float], p: float) -> float:
        if not xs:
            return 0.0
        xs = sorted(xs)
        k = (len(xs) - 1) * p
        f = int(k)
        c = min(f + 1, len(xs) - 1)
        return xs[f] + (xs[c] - xs[f]) * (k - f)

    def summary(self) -> dict:
        out = {}
        for stage, dq in self.samples.items():
            xs = list(dq)
            out[stage] = {"n": len(xs), "p50": round(self._pct(xs, 0.5), 1),
                          "p90": round(self._pct(xs, 0.9), 1), "p99": round(self._pct(xs, 0.99), 1)}
        return {"latency_ms": out, "counters": dict(self.counters),
                "uptime_s": round(time.time() - self.started, 1)}


class StageTimer:
    """Collects timestamps for one utterance; all values in ms since t0."""

    def __init__(self, t0: float | None = None):
        self.t0 = t0 if t0 is not None else time.perf_counter()
        self.marks: dict[str, float] = {}

    def mark(self, name: str) -> float:
        ms = (time.perf_counter() - self.t0) * 1000.0
        self.marks.setdefault(name, ms)
        return ms

    def as_dict(self) -> dict[str, float]:
        return {k: round(v, 1) for k, v in self.marks.items()}
