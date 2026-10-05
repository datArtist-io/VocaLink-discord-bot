"""PCM helpers, resampling and lightweight prosody features (numpy/scipy only)."""

from __future__ import annotations

from math import gcd

import numpy as np

try:
    from scipy.signal import resample_poly as _resample_poly  # type: ignore
except Exception:  # pragma: no cover - scipy is a core dependency
    _resample_poly = None


def pcm16_to_f32(b: bytes) -> np.ndarray:
    return np.frombuffer(b, dtype="<i2").astype(np.float32) / 32768.0


def f32_to_pcm16(x: np.ndarray) -> bytes:
    y = np.clip(np.asarray(x, dtype=np.float32), -1.0, 1.0)
    return (y * 32767.0).astype("<i2").tobytes()


def resample(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    if sr_in == sr_out or x.size == 0:
        return x
    g = gcd(sr_in, sr_out)
    up, down = sr_out // g, sr_in // g
    if _resample_poly is not None:
        return _resample_poly(x, up, down).astype(np.float32)
    # numpy fallback: linear interpolation (lower quality, no deps)
    n_out = int(round(x.size * sr_out / sr_in))
    t_in = np.arange(x.size, dtype=np.float64)
    t_out = np.linspace(0, x.size - 1, n_out)
    return np.interp(t_out, t_in, x).astype(np.float32)


def rms_db(x: np.ndarray) -> float:
    if x.size == 0:
        return -120.0
    r = float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))
    return 20.0 * np.log10(max(r, 1e-6))


def pitch_track(x: np.ndarray, sr: int = 16000, frame_ms: int = 40, fmin: float = 70.0,
                fmax: float = 400.0) -> np.ndarray:
    """Very small autocorrelation pitch tracker; returns Hz per voiced frame."""
    n = int(sr * frame_ms / 1000)
    if x.size < n:
        return np.zeros(0, dtype=np.float32)
    lag_min, lag_max = int(sr / fmax), int(sr / fmin)
    out = []
    for i in range(0, x.size - n, n):
        f = x[i : i + n].astype(np.float64)
        f = f - f.mean()
        e = float(np.dot(f, f))
        if e < 1e-4:
            continue
        ac = np.correlate(f, f, mode="full")[n - 1 :]
        seg = ac[lag_min : min(lag_max, n - 1)]
        if seg.size == 0:
            continue
        k = int(np.argmax(seg))
        if seg[k] / ac[0] < 0.35:  # unvoiced
            continue
        out.append(sr / (lag_min + k))
    return np.asarray(out, dtype=np.float32)


def prosody_features(audio: np.ndarray, sr: int, n_words: int) -> dict:
    """Energy, pace and pitch variability of one utterance."""
    dur = audio.size / sr if sr else 0.0
    f0 = pitch_track(audio, sr)
    if f0.size >= 3:
        st = 12.0 * np.log2(f0 / np.median(f0))
        pitch_std_st = float(np.std(st))
        pitch_med = float(np.median(f0))
    else:
        pitch_std_st, pitch_med = 0.0, 0.0
    return {
        "duration_s": round(dur, 3),
        "rms_db": round(rms_db(audio), 2),
        "words_per_s": round(n_words / dur, 3) if dur > 0.2 else 0.0,
        "pitch_hz": round(pitch_med, 1),
        "pitch_std_st": round(pitch_std_st, 2),
    }


def chunk_bytes(pcm: bytes, max_bytes: int) -> list[bytes]:
    return [pcm[i : i + max_bytes] for i in range(0, len(pcm), max_bytes)]
