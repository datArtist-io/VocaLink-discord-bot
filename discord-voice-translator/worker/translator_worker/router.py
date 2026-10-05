"""Provider routing with policy (local / hybrid / cloud), licence filtering and
circuit breakers. Local providers are always the final fallback."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence, TypeVar

from .breaker import CircuitBreaker
from .providers.base import ProviderUnavailable

log = logging.getLogger("router")
T = TypeVar("T")

# Speak these languages with another language's voice when no native voice exists.
TTS_VOICE_FALLBACK = {"pcm": "en"}


@dataclass
class Providers:
    vad: Any = None
    stt: list = field(default_factory=list)
    mt: list = field(default_factory=list)
    tts: list = field(default_factory=list)      # house voices
    clone: list = field(default_factory=list)    # voice-cloning TTS
    s2s: list = field(default_factory=list)
    llm: list = field(default_factory=list)

    def all(self) -> list:
        out = [self.vad] if self.vad else []
        return out + self.stt + self.mt + self.tts + self.clone + self.s2s + self.llm


class NoProvider(RuntimeError):
    pass


@dataclass
class CallResult:
    value: Any
    provider: Any
    fallbacks: list[str]


class Router:
    def __init__(self, providers: Providers, *, mode: str = "local", commercial: bool = False,
                 hybrid_langs: Sequence[str] = ()):
        self.p = providers
        self.commercial = commercial
        self.hybrid_langs = set(hybrid_langs)
        has_cloud = any(not x.info.local for x in providers.all())
        self.mode = ("hybrid" if has_cloud else "local") if mode == "auto" else mode
        self.breakers: dict[str, CircuitBreaker] = {}

    # ------------------------------------------------------------------
    def breaker(self, prov) -> CircuitBreaker:
        name = prov.info.name
        if name not in self.breakers:
            self.breakers[name] = CircuitBreaker(name)
        return self.breakers[name]

    def _allowed(self, prov) -> bool:
        if self.commercial and not prov.info.commercial_ok:
            return False
        if self.mode == "local" and not prov.info.local:
            return False
        return True

    def _order(self, provs: list, lang: str | None) -> list:
        provs = [p for p in provs if self._allowed(p)]
        local = [p for p in provs if p.info.local]
        cloud = [p for p in provs if not p.info.local]
        if self.mode == "cloud":
            return cloud + local
        if self.mode == "hybrid" and lang in self.hybrid_langs:
            return cloud + local
        return local + cloud

    # ------------------------------------------------------------------ chains
    def stt_chain(self, lang: str | None) -> list:
        cands = [p for p in self.p.stt if lang is None or lang in p.languages()]
        if lang is None:  # auto-detect needs a model with LID
            cands = [p for p in cands if getattr(p, "detects_language", True)]
        return self._order(cands, lang)

    def mt_chain(self, src: str, tgt: str, mode: str = "literal") -> list:
        literal = [p for p in self.p.mt if "literal" in p.modes and p.supports(src, tgt)]
        if mode == "literal":
            # NMT first; LLM-based providers declare "literal" too but come last
            nmt = [p for p in literal if "natural" not in p.modes]
            llm = [p for p in literal if "natural" in p.modes]
            return self._order(nmt, src) + self._order(llm, src)
        styled = [p for p in self.p.mt if mode in p.modes and p.supports(src, tgt)]
        return self._order(styled, src)

    def tts_chain(self, lang: str, *, clone: bool = False) -> list:
        voice_lang = TTS_VOICE_FALLBACK.get(lang, lang)
        chain: list = []
        if clone:
            chain += self._order([p for p in self.p.clone if p.supports(voice_lang)], voice_lang)
        chain += self._order([p for p in self.p.tts if p.supports(voice_lang)], voice_lang)
        return chain

    def llm_chain(self) -> list:
        return self._order(list(self.p.llm), None)

    # ------------------------------------------------------------------ calls
    def call(self, chain: list, fn: Callable[[Any], T], *, what: str = "") -> CallResult:
        """Try providers in order; skip open breakers; raise NoProvider if all fail."""
        tried: list[str] = []
        last: BaseException | None = None
        for prov in chain:
            br = self.breaker(prov)
            if not br.allow():
                tried.append(f"{prov.info.name}:open")
                continue
            try:
                value = fn(prov)
            except ProviderUnavailable as e:  # e.g. unsupported pair discovered at call time
                br.failure(e)
                tried.append(f"{prov.info.name}:unavailable")
                last = e
                continue
            except Exception as e:  # noqa: BLE001 - provider bugs must not kill the pipeline
                br.failure(e)
                log.warning("provider %s failed for %s: %s", prov.info.name, what, e)
                tried.append(f"{prov.info.name}:error")
                last = e
                continue
            br.success()
            return CallResult(value, prov, tried)
        raise NoProvider(f"no provider succeeded for {what or 'call'} (tried {tried}): {last}")

    def snapshot(self) -> dict:
        return {"mode": self.mode, "commercial": self.commercial,
                "breakers": {k: v.snapshot() for k, v in self.breakers.items()}}
