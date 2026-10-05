"""Async facade over the (blocking) model providers.

* Separate thread pools per stage so a slow TTS never blocks STT.
* Final decodes have priority: partial decodes are shed whenever STT capacity
  is busy or a final is waiting (load shedding instead of queueing).
* All provider calls go through the Router (policy, licence filter, circuit
  breakers, fallbacks).
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import AsyncIterator

import numpy as np

from . import glossary as G
from .audio import f32_to_pcm16, resample
from .metrics import Metrics
from .providers.base import GlossaryTerm, MTResult, Prosody, STTResult, VoiceRef
from .router import NoProvider, Router

log = logging.getLogger("pipeline")

OUT_RATE = 48_000
OUT_CHUNK_BYTES = 9_600  # 100 ms of 48 kHz mono s16


class CancelToken:
    __slots__ = ("cancelled", "reason")

    def __init__(self) -> None:
        self.cancelled = False
        self.reason = ""

    def cancel(self, reason: str = "") -> None:
        self.cancelled = True
        self.reason = reason


@dataclass
class Translation:
    text: str
    provider: str
    mode: str
    note: str = ""
    glossary_hits: int = 0
    glossary_misses: int = 0


class Pipeline:
    def __init__(self, router: Router, plan, metrics: Metrics, *, vad, stt_workers: int = 1,
                 mt_workers: int = 2, tts_workers: int = 2, beam_final: int = 5, beam_partial: int = 1):
        self.router = router
        self.plan = plan
        self.metrics = metrics
        self.vad = vad
        self.stt_workers = max(1, stt_workers)
        self.stt_pool = ThreadPoolExecutor(self.stt_workers, thread_name_prefix="stt")
        self.mt_pool = ThreadPoolExecutor(max(1, mt_workers), thread_name_prefix="mt")
        self.tts_pool = ThreadPoolExecutor(max(1, tts_workers), thread_name_prefix="tts")
        self.misc_pool = ThreadPoolExecutor(2, thread_name_prefix="misc")
        self.beam_final = beam_final
        self.beam_partial = beam_partial
        self._stt_inflight = 0
        self._finals_waiting = 0
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ STT
    def can_run_partial(self) -> bool:
        return self._finals_waiting == 0 and self._stt_inflight < self.stt_workers

    async def stt(self, audio: np.ndarray, lang: str | None, *, final: bool, prompt: str | None = None,
                  hotwords: str | None = None) -> STTResult:
        loop = asyncio.get_running_loop()
        chain = self.router.stt_chain(lang)
        if not chain:
            raise NoProvider(f"no speech recognition available for '{lang}'")

        def run():
            with self._lock:
                self._stt_inflight += 1
            try:
                t = time.perf_counter()
                r = self.router.call(chain, lambda p: p.transcribe(audio, lang, final=final, prompt=prompt,
                                                                     hotwords=hotwords), what="stt")
                self.metrics.observe("stt_final" if final else "stt_partial", (time.perf_counter() - t) * 1000)
                res: STTResult = r.value
                res.provider = r.provider.info.name
                return res
            finally:
                with self._lock:
                    self._stt_inflight -= 1

        if final:
            self._finals_waiting += 1
        try:
            return await loop.run_in_executor(self.stt_pool, run)
        finally:
            if final:
                self._finals_waiting -= 1

    async def detect_language(self, audio: np.ndarray) -> dict[str, float]:
        loop = asyncio.get_running_loop()
        chain = self.router.stt_chain(None)

        def run():
            t = time.perf_counter()
            r = self.router.call(chain, lambda p: p.detect_language(audio), what="lid")
            self.metrics.observe("lid", (time.perf_counter() - t) * 1000)
            return r.value

        return await loop.run_in_executor(self.stt_pool, run)

    # ------------------------------------------------------------------ MT
    async def translate(self, texts: list[str], src: str, tgt: str, *, mode: str = "literal",
                        glossary: list[GlossaryTerm] | None = None,
                        context: list[str] | None = None) -> list[Translation]:
        loop = asyncio.get_running_loop()
        terms = glossary or []
        note = ""
        src_eff = src
        chain = self.router.mt_chain(src, tgt, mode)
        if not chain and mode != "literal":
            note = f"{mode} mode needs an LLM (none configured) - showing a literal translation"
            mode = "literal"
            chain = self.router.mt_chain(src, tgt, "literal")
        if not chain and src == "pcm":
            note = (note + "; " if note else "") + "Nigerian Pidgin translated as English"
            src_eff = "en"
            chain = self.router.mt_chain("en", tgt, mode)
        if not chain:
            raise NoProvider(f"no translation available {src}->{tgt}")

        def run():
            t = time.perf_counter()
            llm_based = None
            prepared, used_terms = [], []
            for tx in texts:
                pre = G.pre_translate(tx, src_eff, tgt, terms)
                prepared.append(pre.text)
                used_terms.append(pre.used)

            def call(p):
                nonlocal llm_based
                llm_based = "natural" in p.modes
                # LLM providers get the raw text + glossary in the prompt
                inp = texts if llm_based else prepared
                return p.translate(inp, src_eff, tgt, mode=mode, glossary=terms, context=context)

            r = self.router.call(chain, call, what=f"mt {src_eff}->{tgt}")
            self.metrics.observe("mt", (time.perf_counter() - t) * 1000)
            out: list[Translation] = []
            for i, res in enumerate(r.value):
                res: MTResult
                post = G.post_translate(res.text, src_eff, tgt, terms)
                misses = G.verify(post.text, used_terms[i], tgt) if not llm_based else []
                n = note
                if r.fallbacks:
                    n = (n + "; " if n else "") + "fallback after " + ",".join(r.fallbacks)
                if res.note:
                    n = (n + "; " if n else "") + res.note
                out.append(Translation(post.text, r.provider.info.name, res.mode or mode, n,
                                       glossary_hits=len(used_terms[i]) - len(misses) + len(post.used),
                                       glossary_misses=len(misses)))
            return out

        return await loop.run_in_executor(self.mt_pool, run)

    # ------------------------------------------------------------------ TTS
    def tts_available(self, lang: str, clone: bool = False) -> bool:
        return bool(self.router.tts_chain(lang, clone=clone))

    async def synth(self, text: str, lang: str, *, voice: VoiceRef | None, prosody: Prosody | None,
                    token: CancelToken, info: dict) -> AsyncIterator[bytes]:
        """Yield 48 kHz mono s16le chunks as soon as the provider produces audio.

        `info` is filled with provider/voice details before the first chunk.
        """
        loop = asyncio.get_running_loop()
        chain = self.router.tts_chain(lang, clone=voice is not None)
        if not chain:
            raise NoProvider(f"no voice available for '{lang}'")
        q: asyncio.Queue = asyncio.Queue(maxsize=64)
        DONE = object()

        def put(item):
            fut = asyncio.run_coroutine_threadsafe(q.put(item), loop)
            try:
                fut.result(timeout=30)
            except Exception:
                token.cancel("consumer gone")

        def produce():
            def gen(p):
                use_voice = voice if getattr(p, "clones", False) else None
                first = True
                try:
                    for chunk in p.synthesize(text, lang, voice=use_voice, prosody=prosody):
                        if first:
                            info.update(provider=p.info.name, voice="clone" if use_voice else "house",
                                        license=p.info.license)
                            first = False
                        if token.cancelled:
                            return True
                        # providers may yield (audio, sample_rate) when the rate varies per voice
                        arr, sr = chunk if isinstance(chunk, tuple) else (chunk, p.sample_rate)
                        y = resample(np.asarray(arr, dtype=np.float32), int(sr), OUT_RATE)
                        pcm = f32_to_pcm16(y)
                        for i in range(0, len(pcm), OUT_CHUNK_BYTES):
                            put(pcm[i : i + OUT_CHUNK_BYTES])
                            if token.cancelled:
                                return True
                except Exception as e:  # noqa: BLE001
                    if first:
                        raise  # nothing played yet: let the router fall back
                    # audio already went out; falling back would repeat it
                    info["truncated"] = str(e)[:200]
                    return True
                if first:
                    raise RuntimeError("provider produced no audio")
                return True

            try:
                self.router.call(chain, gen, what=f"tts {lang}")
            except Exception as e:  # noqa: BLE001
                put(e)
            finally:
                put(DONE)

        fut = loop.run_in_executor(self.tts_pool, produce)
        try:
            while True:
                item = await q.get()
                if item is DONE:
                    break
                if isinstance(item, Exception):
                    raise item
                if token.cancelled:
                    continue  # drain
                yield item
        finally:
            token.cancel(token.reason or "closed")
            # drain so the producer thread can finish
            while not fut.done():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    await asyncio.sleep(0.005)

    async def warm_tts(self, langs) -> None:
        """Load voices for languages a guild will need before anyone speaks."""
        loop = asyncio.get_running_loop()
        for lang in langs:
            for prov in self.router.tts_chain(lang)[:1]:
                if hasattr(prov, "warm"):
                    try:
                        await loop.run_in_executor(self.misc_pool, prov.warm, lang)
                    except Exception as e:  # noqa: BLE001
                        log.warning("warm-up of %s voice for %s failed: %s", prov.info.name, lang, e)

    # ------------------------------------------------------------------ LLM
    async def llm(self, system: str, user: str, *, max_tokens: int = 800, json_mode: bool = False) -> str:
        loop = asyncio.get_running_loop()
        chain = self.router.llm_chain()
        if not chain:
            raise NoProvider("no LLM configured")
        r = await loop.run_in_executor(
            self.misc_pool,
            lambda: self.router.call(chain, lambda p: p.chat(system, user, max_tokens=max_tokens,
                                                             json_mode=json_mode), what="llm"))
        return r.value

    async def run_misc(self, fn, *args):
        return await asyncio.get_running_loop().run_in_executor(self.misc_pool, fn, *args)

    def shutdown(self) -> None:
        for pool in (self.stt_pool, self.mt_pool, self.tts_pool, self.misc_pool):
            pool.shutdown(wait=False, cancel_futures=True)
