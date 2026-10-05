"""Utterance endpointing on top of a frame-level VAD model.

Feed 16 kHz float32 audio in any chunk size; the endpointer runs the VAD on
fixed windows (512 samples for Silero) and emits:

    SpeechStart(t)                         speech confirmed (with pre-roll)
    SpeechEnd(audio, probs, reason, t)     utterance finished

Endpointing is adaptive: after clause-final punctuation in the latest partial
transcript the session calls `allow_fast_end()`, shortening the silence needed
to end the utterance from `endpoint_ms` to `endpoint_fast_ms`. A hard cap
(`max_utterance_s`) cuts very long monologues at the quietest recent point so
translation keeps flowing.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import numpy as np

SR = 16_000


@dataclass
class SpeechStart:
    sample: int           # absolute sample index where the utterance audio begins


@dataclass
class SpeechEnd:
    audio: np.ndarray     # float32 utterance incl. pre-roll, trailing silence trimmed
    probs: np.ndarray     # per-window speech probabilities for the utterance
    window: int           # samples per prob entry
    reason: str           # silence | silence_fast | max_length | flush
    start_sample: int
    end_sample: int       # absolute index of last speech sample
    detected_sample: int  # absolute index when the end was detected


class Endpointer:
    def __init__(self, vad, *, threshold=0.5, neg_threshold=0.35, min_speech_ms=250,
                 endpoint_ms=500, endpoint_fast_ms=250, pre_roll_ms=200, max_utterance_s=12.0,
                 start_windows=2):
        self.vad = vad
        self.state = vad.new_state()
        self.win = vad.window
        self.th = threshold
        self.neg = neg_threshold
        self.min_speech = int(SR * min_speech_ms / 1000)
        self.end_slow = int(SR * endpoint_ms / 1000)
        self.end_fast = int(SR * endpoint_fast_ms / 1000)
        self.pre_roll = int(SR * pre_roll_ms / 1000)
        self.max_len = int(SR * max_utterance_s)
        self.start_windows = start_windows

        self._pending = np.zeros(0, dtype=np.float32)
        self._t = 0                                   # samples consumed by VAD
        self._ring: deque[np.ndarray] = deque()       # recent windows for pre-roll
        self._ring_len = 0
        self.in_speech = False
        self._pos_run = 0
        self._cand: list[np.ndarray] = []             # windows while confirming start
        self._cand_probs: list[float] = []
        self._utt: list[np.ndarray] = []
        self._probs: list[float] = []
        self._utt_start = 0
        self._speech_first = 0                        # first confirmed speech sample (excl. pre-roll)
        self._last_speech = 0
        self._silence = 0
        self._fast = False

    # ------------------------------------------------------------------
    @property
    def utterance_samples(self) -> int:
        return sum(a.size for a in self._utt) if self.in_speech else 0

    def current_audio(self) -> np.ndarray:
        """Snapshot of the in-progress utterance (for partial decoding)."""
        if not self.in_speech or not self._utt:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(self._utt)

    def allow_fast_end(self, flag: bool = True) -> None:
        self._fast = flag

    def reset(self) -> None:
        self.state = self.vad.new_state()
        self._pending = np.zeros(0, dtype=np.float32)
        self._ring.clear()
        self._ring_len = 0
        self.in_speech = False
        self._pos_run = 0
        self._cand, self._cand_probs = [], []
        self._utt, self._probs = [], []
        self._silence = 0
        self._fast = False

    # ------------------------------------------------------------------
    def feed(self, audio: np.ndarray) -> list:
        events: list = []
        if audio.size:
            self._pending = np.concatenate([self._pending, audio.astype(np.float32, copy=False)])
        w = self.win
        while self._pending.size >= w:
            win = self._pending[:w]
            self._pending = self._pending[w:]
            p = float(self.vad.prob(self.state, win))
            self._t += w
            self._step(win, p, events)
        return events

    def flush(self) -> list:
        """Force-end any utterance in progress (stream closed)."""
        events: list = []
        if self.in_speech and self._speech_len() >= self.min_speech:
            events.append(self._finish("flush"))
        self.in_speech = False
        self._utt, self._probs = [], []
        return events

    # ------------------------------------------------------------------
    def _speech_len(self) -> int:
        return self._last_speech - self._speech_first

    def _push_ring(self, win: np.ndarray) -> None:
        self._ring.append(win)
        self._ring_len += win.size
        while self._ring and self._ring_len - self._ring[0].size >= self.pre_roll:
            self._ring_len -= self._ring.popleft().size

    def _step(self, win: np.ndarray, p: float, events: list) -> None:
        w = win.size
        if not self.in_speech:
            if p >= self.th:
                self._pos_run += 1
                self._cand.append(win)
                self._cand_probs.append(p)
                if self._pos_run >= self.start_windows:
                    pre = list(self._ring)
                    self._utt = pre + self._cand
                    self._probs = [0.0] * len(pre) + self._cand_probs
                    self._utt_start = self._t - sum(a.size for a in self._utt)
                    self._speech_first = self._t - sum(a.size for a in self._cand)
                    self._last_speech = self._t
                    self._silence = 0
                    self.in_speech = True
                    self._fast = False
                    self._ring.clear()
                    self._ring_len = 0
                    self._cand, self._cand_probs, self._pos_run = [], [], 0
                    events.append(SpeechStart(self._utt_start))
            else:
                # candidate windows that didn't confirm become pre-roll
                for c in self._cand:
                    self._push_ring(c)
                self._cand, self._cand_probs, self._pos_run = [], [], 0
                self._push_ring(win)
            return

        # in speech
        self._utt.append(win)
        self._probs.append(p)
        if p >= self.neg:
            self._last_speech = self._t
            self._silence = 0
        else:
            self._silence += w
        need = self.end_fast if self._fast else self.end_slow
        if self._silence >= need:
            if self._speech_len() >= self.min_speech:
                events.append(self._finish("silence_fast" if self._fast else "silence"))
            else:  # too short: a click or cough
                self._abort()
            return
        total = sum(a.size for a in self._utt)
        if total >= self.max_len:
            events.append(self._cut_long())

    def _abort(self) -> None:
        self.in_speech = False
        self._utt, self._probs = [], []
        self._silence = 0

    def _finish(self, reason: str) -> SpeechEnd:
        audio = np.concatenate(self._utt)
        probs = np.asarray(self._probs, dtype=np.float32)
        # trim trailing silence but keep ~120 ms tail for natural decoding
        keep = (self._last_speech - self._utt_start) + int(0.12 * SR)
        audio = audio[: max(1, min(audio.size, keep))]
        ev = SpeechEnd(audio=audio, probs=probs, window=self.win, reason=reason,
                       start_sample=self._utt_start, end_sample=self._last_speech,
                       detected_sample=self._t)
        self.in_speech = False
        self._utt, self._probs = [], []
        self._silence = 0
        self._fast = False
        return ev

    def _cut_long(self) -> SpeechEnd:
        """Cut at the quietest window in the last 1.5 s; carry the rest over."""
        probs = np.asarray(self._probs, dtype=np.float32)
        look = max(1, int(1.5 * SR / self.win))
        tail = probs[-look:]
        k_rel = int(np.argmin(tail))
        cut = len(probs) - look + k_rel + 1 if tail[k_rel] < self.th else len(probs)
        cut = max(1, min(cut, len(probs)))
        head_w, tail_w = self._utt[:cut], self._utt[cut:]
        head_p, tail_p = self._probs[:cut], self._probs[cut:]
        audio = np.concatenate(head_w)
        end_sample = self._utt_start + audio.size
        ev = SpeechEnd(audio=audio, probs=np.asarray(head_p, dtype=np.float32), window=self.win,
                       reason="max_length", start_sample=self._utt_start, end_sample=end_sample,
                       detected_sample=self._t)
        # continue the utterance with the remainder
        self._utt, self._probs = list(tail_w), list(tail_p)
        self._utt_start = end_sample
        self._speech_first = end_sample
        self._fast = False
        return ev


def split_on_pauses(audio: np.ndarray, probs: np.ndarray, window: int, *, min_chunk_s: float = 2.0,
                    pause_windows: int = 4, neg: float = 0.35) -> list[tuple[int, int]]:
    """Split an utterance at internal pauses into chunks >= min_chunk_s.

    Returns sample ranges. Used for per-chunk language re-detection
    (code-switching) on long utterances.
    """
    n = probs.size
    if n == 0:
        return [(0, audio.size)]
    cuts: list[int] = []
    run = 0
    last_cut = 0
    min_w = int(min_chunk_s * SR / window)
    for i in range(n):
        if probs[i] < neg:
            run += 1
        else:
            if run >= pause_windows and (i - run // 2) - last_cut >= min_w and n - (i - run // 2) >= min_w:
                c = i - run // 2
                cuts.append(c)
                last_cut = c
            run = 0
    edges = [0] + [c * window for c in cuts] + [audio.size]
    return [(edges[i], min(edges[i + 1], audio.size)) for i in range(len(edges) - 1) if edges[i] < audio.size]
