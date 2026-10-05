"""Per-speaker spoken-language smoothing.

Whisper's language ID is per-utterance and noisy on short clips and between
close languages (es/pt, hi/ur, id/ms, no/da/sv, sr/hr/bs ...). The smoother
keeps a per-speaker prior (EMA of past posteriors) and only switches language
when the evidence is clear:

* one long (>= 2 s) utterance with p >= 0.9 for a non-confusable language, or
* a margin over the current language on two consecutive utterances
  (a much larger margin when the two languages are in a confusable group).

Short utterances are weighted toward the prior, so "ok", "sí", "ja" do not
flip the speaker's language.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from . import languages as L


@dataclass
class LIDDecision:
    lang: str
    prob: float
    switched: bool = False
    previous: str | None = None
    reason: str = ""
    posterior: dict[str, float] = field(default_factory=dict)


class LanguageSmoother:
    def __init__(self, *, forced: str | None = None, allowed: set[str] | None = None,
                 ema: float = 0.6, switch_margin: float = 0.15, confusable_margin: float = 0.35,
                 confident_p: float = 0.9, confident_dur: float = 2.0, recheck_every: int = 3):
        self.forced = forced or None
        self.allowed = set(allowed) if allowed else None
        self.ema = ema
        self.switch_margin = switch_margin
        self.confusable_margin = confusable_margin
        self.confident_p = confident_p
        self.confident_dur = confident_dur
        self.recheck_every = max(1, recheck_every)
        self.current: str | None = None
        self.prior: dict[str, float] = {}
        self._pending: tuple[str, int] | None = None
        self._streak = 0           # consecutive utterances agreeing with current
        self._since_check = 0

    # ------------------------------------------------------------------
    def set_forced(self, lang: str | None) -> None:
        self.forced = lang or None
        if lang:
            self.current = lang

    def set_allowed(self, allowed: set[str] | None) -> None:
        self.allowed = set(allowed) if allowed else None

    @property
    def locked(self) -> bool:
        return bool(self.forced) or (self.current is not None and self._streak >= 3)

    def wants_detection(self) -> bool:
        """Should the next decode run language detection (vs. forcing current)?"""
        if self.forced:
            return False
        if not self.locked:
            return True
        self._since_check += 1
        if self._since_check >= self.recheck_every:
            self._since_check = 0
            return True
        return False

    def hint(self) -> str | None:
        return self.forced or self.current

    # ------------------------------------------------------------------
    def _restrict(self, probs: dict[str, float]) -> dict[str, float]:
        p = {L.normalize(k): float(v) for k, v in probs.items() if v > 0}
        if self.allowed:
            q = {k: v for k, v in p.items() if k in self.allowed}
            if sum(q.values()) > 1e-6:
                p = q
        s = sum(p.values())
        return {k: v / s for k, v in p.items()} if s > 0 else {}

    def update(self, probs: dict[str, float], duration_s: float) -> LIDDecision:
        if self.forced:
            return LIDDecision(self.forced, 1.0, reason="forced")
        p = self._restrict(probs)
        if not p:
            lang = self.current or "en"
            return LIDDecision(lang, 0.0, reason="no-evidence")

        # reliability of this utterance's evidence
        w = min(1.0, max(0.2, duration_s / 3.0))
        keys = set(p) | set(self.prior)
        scores = {}
        for k in keys:
            lp = math.log(p.get(k, 0.0) + 1e-4)
            lq = math.log(self.prior.get(k, 0.0) + 0.02) if self.prior else 0.0
            scores[k] = w * lp + (1.0 - w) * lq
        m = max(scores.values())
        ex = {k: math.exp(v - m) for k, v in scores.items()}
        z = sum(ex.values())
        post = {k: v / z for k, v in ex.items()}
        cand = max(post, key=post.get)

        decision: LIDDecision
        if self.current is None:
            decision = LIDDecision(cand, post[cand], switched=False, reason="initial")
            self.current = cand
            self._streak = 1
        elif cand == self.current:
            self._pending = None
            self._streak += 1
            decision = LIDDecision(cand, post[cand], reason="stable")
        else:
            conf = L.confusable(cand, self.current)
            margin = post[cand] - post.get(self.current, 0.0)
            need = self.confusable_margin if conf else self.switch_margin
            clear = (not conf and p.get(cand, 0) >= self.confident_p and duration_s >= self.confident_dur)
            if clear:
                decision = self._switch(cand, post, "confident")
            elif margin >= need:
                if self._pending and self._pending[0] == cand:
                    decision = self._switch(cand, post, "sustained")
                else:
                    self._pending = (cand, 1)
                    decision = LIDDecision(self.current, post.get(self.current, 0.0),
                                           reason=f"pending:{cand}")
            else:
                self._pending = None
                decision = LIDDecision(self.current, post.get(self.current, 0.0),
                                       reason=f"held-against:{cand}")
        decision.posterior = dict(sorted(post.items(), key=lambda kv: -kv[1])[:5])
        # update prior (EMA)
        for k in keys:
            self.prior[k] = self.ema * self.prior.get(k, 0.0) + (1 - self.ema) * post.get(k, 0.0)
        # prune tiny entries
        self.prior = {k: v for k, v in self.prior.items() if v > 1e-3}
        return decision

    def _switch(self, cand: str, post: dict[str, float], why: str) -> LIDDecision:
        prev = self.current
        self.current = cand
        self._pending = None
        self._streak = 1
        self._since_check = 0
        return LIDDecision(cand, post[cand], switched=True, previous=prev, reason=why)
