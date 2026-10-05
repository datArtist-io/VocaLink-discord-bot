"""Provider interfaces. Every pipeline stage is swappable behind one of these.

All model calls are synchronous and run inside thread pools owned by the
pipeline; CTranslate2 / ONNX Runtime / PyTorch release the GIL while working.
Providers must be thread-safe for concurrent calls or declare
`max_concurrency = 1`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator, Protocol, runtime_checkable

import numpy as np


@dataclass(frozen=True)
class ProviderInfo:
    name: str
    stage: str                  # vad | stt | mt | tts | s2s | llm | lid
    local: bool                 # runs on our hardware (no network)
    license: str                # SPDX-ish id of the *weights* ("MIT", "CC-BY-NC-4.0", "proprietary-api")
    commercial_ok: bool
    streaming: bool = False
    cost_per_hour_usd: float = 0.0   # rough, for budgeting cloud providers
    max_concurrency: int = 4


# --------------------------------------------------------------------- VAD
@runtime_checkable
class VADModel(Protocol):
    info: ProviderInfo
    window: int                 # samples per call at 16 kHz

    def new_state(self) -> object: ...
    def prob(self, state: object, window: np.ndarray) -> float: ...


# --------------------------------------------------------------------- STT
@dataclass
class Word:
    text: str
    start: float
    end: float
    prob: float = 1.0


@dataclass
class STTResult:
    text: str
    language: str
    language_prob: float = 0.0
    language_probs: dict[str, float] | None = None
    words: list[Word] | None = None
    avg_logprob: float = 0.0
    no_speech_prob: float = 0.0
    provider: str = ""


@runtime_checkable
class STTModel(Protocol):
    info: ProviderInfo

    def languages(self) -> set[str]: ...
    def detect_language(self, audio: np.ndarray) -> dict[str, float]: ...
    def transcribe(self, audio: np.ndarray, language: str | None, *, final: bool,
                   prompt: str | None = None, hotwords: str | None = None) -> STTResult: ...


# --------------------------------------------------------------------- MT
@dataclass
class MTResult:
    text: str
    provider: str
    mode: str = "literal"       # literal | natural | cultural
    note: str = ""              # e.g. cultural explanation or fallback reason


@dataclass
class GlossaryTerm:
    """kind="term": source-language term -> required target rendering.
    kind="fix":  wrong target-language output -> corrected output (post-edit),
                 typically learned from /correct."""
    source: str
    target: str
    src_lang: str = "*"
    tgt_lang: str = "*"
    kind: str = "term"


@runtime_checkable
class MTModel(Protocol):
    info: ProviderInfo
    modes: tuple[str, ...]      # which modes it can do

    def supports(self, src: str, tgt: str) -> bool: ...
    def translate(self, texts: list[str], src: str, tgt: str, *, mode: str = "literal",
                  glossary: list[GlossaryTerm] | None = None,
                  context: list[str] | None = None) -> list[MTResult]: ...


# --------------------------------------------------------------------- TTS
@dataclass
class Prosody:
    rate: float = 1.0           # 1.0 = provider default pace; >1 faster
    energy: float = 1.0         # relative loudness / intensity
    expressiveness: float = 0.5 # 0..1 (maps to e.g. Chatterbox `exaggeration`)


@dataclass
class VoiceRef:
    """A consented, enrolled voice. `reference_wav` is decrypted in memory only."""
    user_id: str
    reference_wav: np.ndarray | None = None   # float32 mono @ reference_rate
    reference_rate: int = 16000
    cache_key: str = ""


@runtime_checkable
class TTSModel(Protocol):
    info: ProviderInfo
    sample_rate: int
    clones: bool                # supports VoiceRef

    def supports(self, lang: str) -> bool: ...
    def synthesize(self, text: str, lang: str, *, voice: VoiceRef | None = None,
                   prosody: Prosody | None = None) -> Iterator[np.ndarray]: ...


# --------------------------------------------------------------------- S2S
@runtime_checkable
class S2SModel(Protocol):
    """Optional end-to-end speech-to-speech translation (e.g. SeamlessStreaming)."""
    info: ProviderInfo
    sample_rate: int

    def supports(self, src: str, tgt: str) -> bool: ...
    def translate_speech(self, audio: np.ndarray, src: str | None, tgt: str) -> Iterator[np.ndarray]: ...


# --------------------------------------------------------------------- LLM
@runtime_checkable
class LLMModel(Protocol):
    info: ProviderInfo

    def chat(self, system: str, user: str, *, max_tokens: int = 512, temperature: float = 0.2,
             json_mode: bool = False) -> str: ...


class ProviderUnavailable(RuntimeError):
    """Raised when a provider cannot serve a request (missing model, bad key, outage)."""
