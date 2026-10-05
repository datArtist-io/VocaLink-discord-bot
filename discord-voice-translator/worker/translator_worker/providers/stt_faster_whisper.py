"""faster-whisper (CTranslate2) speech recognition + language identification.

Licence: MIT (code and Whisper weights). Runs on CPU (int8) or CUDA.
"""

from __future__ import annotations

import logging

import numpy as np

from .. import languages as L
from .base import ProviderInfo, STTResult, Word

log = logging.getLogger("stt.faster_whisper")


class FasterWhisperSTT:
    detects_language = True

    def __init__(self, model: str, *, device: str = "auto", compute_type: str = "default",
                 cpu_threads: int = 0, num_workers: int = 1, download_root: str | None = None,
                 beam_final: int = 5, beam_partial: int = 1):
        from faster_whisper import WhisperModel  # type: ignore

        self.model_name = model
        self.model = WhisperModel(model, device=device, compute_type=compute_type, cpu_threads=cpu_threads,
                                  num_workers=max(1, num_workers), download_root=download_root)
        self.multilingual = bool(getattr(self.model.model, "is_multilingual", True))
        self.beam_final = beam_final
        self.beam_partial = beam_partial
        langs = set(L.WHISPER_CODES) if self.multilingual else {"en"}
        if "large-v3" not in model and "turbo" not in model:
            langs.discard("yue")  # Cantonese token only exists in large-v3 vocabularies
        self._langs = langs
        self.info = ProviderInfo(f"faster_whisper:{model}", "stt", local=True, license="MIT",
                                 commercial_ok=True, max_concurrency=max(1, num_workers))

    def languages(self) -> set[str]:
        return self._langs

    def detect_language(self, audio: np.ndarray) -> dict[str, float]:
        audio = audio[: 30 * 16000]
        try:  # faster-whisper >= 1.1
            lang, prob, all_probs = self.model.detect_language(audio)
            if all_probs:
                return {L.normalize(k): float(v) for k, v in all_probs}
            return {L.normalize(lang): float(prob)}
        except (AttributeError, TypeError):
            segs, info = self.model.transcribe(audio, language=None, beam_size=1, without_timestamps=True,
                                               max_new_tokens=1, condition_on_previous_text=False)
            for _ in segs:
                break
            if info.all_language_probs:
                return {L.normalize(k): float(v) for k, v in info.all_language_probs}
            return {L.normalize(info.language): float(info.language_probability)}

    def transcribe(self, audio: np.ndarray, language: str | None, *, final: bool, prompt: str | None = None,
                   hotwords: str | None = None) -> STTResult:
        kwargs = dict(
            language=language, task="transcribe",
            beam_size=self.beam_final if final else self.beam_partial,
            best_of=self.beam_final if final else 1,
            temperature=[0.0, 0.2, 0.4] if final else 0.0,
            condition_on_previous_text=False,
            without_timestamps=True,
            word_timestamps=False,
            vad_filter=False,              # our own endpointer already did this
            initial_prompt=prompt,
            no_speech_threshold=0.6,
            log_prob_threshold=-1.0,
            compression_ratio_threshold=2.4,
        )
        if hotwords:
            kwargs["hotwords"] = hotwords
        try:
            segments, info = self.model.transcribe(audio, **kwargs)
        except TypeError:  # older faster-whisper without `hotwords`
            kwargs.pop("hotwords", None)
            segments, info = self.model.transcribe(audio, **kwargs)
        segs = list(segments)
        text = "".join(s.text for s in segs).strip()
        if segs:
            weights = np.array([max(1, len(s.tokens)) for s in segs], dtype=np.float64)
            avg_lp = float(np.average([s.avg_logprob for s in segs], weights=weights))
            nsp = float(max(s.no_speech_prob for s in segs))
        else:
            avg_lp, nsp = -2.0, 1.0
        probs = None
        if getattr(info, "all_language_probs", None):
            probs = {L.normalize(k): float(v) for k, v in info.all_language_probs}
        words = [Word(w, 0.0, 0.0) for w in text.split()]
        return STTResult(text=text, language=L.normalize(info.language), language_prob=float(info.language_probability),
                         language_probs=probs, words=words, avg_logprob=avg_lp, no_speech_prob=nsp,
                         provider=self.info.name)
