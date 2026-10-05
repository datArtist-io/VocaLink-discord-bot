"""One speaker's live pipeline: VAD -> (partials) -> LID + STT -> MT -> TTS.

Discord delivers a separate audio stream per user, so every speaker gets an
independent session with its own endpointer, language smoother and
LocalAgreement state. Utterances of one speaker are finalised in order; dubs
run as independent tasks so the next utterance's STT is never blocked by TTS.
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import math
import time
from dataclasses import dataclass, field

import numpy as np

from . import languages as L
from . import textutil as T
from .audio import pcm16_to_f32, prosody_features
from .glossary import hotwords as glossary_hotwords
from .guild import GuildState
from .lid import LanguageSmoother, LIDDecision
from .metrics import StageTimer
from .pipeline import CancelToken, Pipeline
from .providers.base import Prosody, STTResult
from .router import NoProvider
from .vad import SR, Endpointer, SpeechEnd, SpeechStart, split_on_pauses

log = logging.getLogger("session")

FRAME_SAMPLES = 320  # 20 ms at 16 kHz


@dataclass
class Utterance:
    id: int
    t_start: float
    audio: np.ndarray | None = None
    probs: np.ndarray | None = None
    window: int = 512
    reason: str = ""
    endpoint_ms: float = 0.0
    t_endpoint: float = 0.0
    finalized: bool = False
    spoken_src: str = ""        # source text already dubbed incrementally
    n_clauses: int = 0
    spec_units: int = 0         # committed units at last speculative caption translation
    incremental_dubs: list = field(default_factory=list)


class SpeakerSession:
    def __init__(self, *, sid: int, conn, guild: GuildState, user_id: str, name: str,
                 speak_lang: str | None, pipeline: Pipeline, cfg, voices=None):
        self.sid = sid
        self.conn = conn
        self.guild = guild
        self.user_id = str(user_id)
        self.name = name
        self.p = pipeline
        self.cfg = cfg
        self.voices = voices
        pc = cfg.pipeline
        self.endpointer = Endpointer(
            pipeline.vad, threshold=pc.vad_threshold, neg_threshold=pc.vad_neg_threshold,
            min_speech_ms=pc.min_speech_ms, endpoint_ms=pc.endpoint_ms,
            endpoint_fast_ms=pc.endpoint_fast_ms, pre_roll_ms=pc.pre_roll_ms,
            max_utterance_s=pc.max_utterance_s)
        forced = L.normalize(speak_lang) if speak_lang and speak_lang != "auto" else None
        self.smoother = LanguageSmoother(forced=forced, allowed=guild.expected_langs,
                                         recheck_every=pc.lid_recheck_every)
        self.agreement = T.LocalAgreement(forced or "en")
        self._ids = itertools.count(1)
        self.utt: Utterance | None = None
        self._final_q: asyncio.Queue[Utterance | None] = asyncio.Queue()
        self._final_task = asyncio.create_task(self._final_loop(), name=f"final-{sid}")
        self._partial_task: asyncio.Task | None = None
        self._last_partial = 0.0
        self._dub_tasks: set[asyncio.Task] = set()
        self._expected_seq: int | None = None
        self._wps_base = 0.0
        self._rms_base = 0.0
        self.closed = False
        self.stats = {"utterances": 0, "dropped_frames": 0, "hallucinations": 0}

    # ------------------------------------------------------------------ input
    def set_speak_lang(self, lang: str | None) -> None:
        forced = L.normalize(lang) if lang and lang != "auto" else None
        self.smoother.set_forced(forced)

    def set_allowed(self, allowed: set[str] | None) -> None:
        self.smoother.set_allowed(allowed)

    def feed(self, pcm: bytes, seq: int) -> None:
        if self.closed:
            return
        audio = pcm16_to_f32(pcm)
        # Concealed gaps: the edge numbers 20 ms frames; insert silence for
        # frames lost in transit (e.g. DAVE key transitions) so timing stays real.
        if self._expected_seq is not None and seq != self._expected_seq:
            gap = (seq - self._expected_seq) & 0xFFFFFFFF
            if 0 < gap <= 50:  # up to 1 s
                self.stats["dropped_frames"] += gap
                audio = np.concatenate([np.zeros(gap * FRAME_SAMPLES, dtype=np.float32), audio])
        self._expected_seq = (seq + 1) & 0xFFFFFFFF
        for ev in self.endpointer.feed(audio):
            if isinstance(ev, SpeechStart):
                self._on_start()
            elif isinstance(ev, SpeechEnd):
                self._on_end(ev)
        self._maybe_partial()

    def _on_start(self) -> None:
        self.utt = Utterance(next(self._ids), time.perf_counter())
        self.agreement.reset(self.smoother.hint() or "en")
        self._last_partial = time.perf_counter()
        self.conn.emit({"type": "speech_start", "sid": self.sid, "utt_id": self.utt.id}, droppable=True)

    def _on_end(self, ev: SpeechEnd) -> None:
        utt = self.utt or Utterance(next(self._ids), time.perf_counter())
        utt.audio, utt.probs, utt.window, utt.reason = ev.audio, ev.probs, ev.window, ev.reason
        utt.endpoint_ms = (ev.detected_sample - ev.end_sample) * 1000.0 / SR
        utt.t_endpoint = time.perf_counter()
        utt.finalized = True
        self.p.metrics.observe("vad_endpoint", utt.endpoint_ms)
        self._final_q.put_nowait(utt)
        if ev.reason == "max_length":  # utterance continues
            self.utt = Utterance(next(self._ids), time.perf_counter())
            self.agreement.reset(self.smoother.hint() or "en")
        else:
            self.utt = None

    # ------------------------------------------------------------------ partials
    def _partials_enabled(self) -> bool:
        return bool(self.p.plan.partials)

    def _incremental_enabled(self) -> bool:
        if self.guild.incremental_dub is not None:
            return self.guild.incremental_dub and self._partials_enabled()
        return bool(self.p.plan.incremental_dub)

    def _maybe_partial(self) -> None:
        if not (self.utt and self.endpointer.in_speech and self._partials_enabled()):
            return
        if self._partial_task and not self._partial_task.done():
            return
        now = time.perf_counter()
        if (now - self._last_partial) * 1000 < self.p.plan.partial_interval_ms:
            return
        if self.endpointer.utterance_samples < int(0.6 * SR):
            return
        if not self.p.can_run_partial():
            self.p.metrics.inc("partials_shed")
            return
        self._last_partial = now
        utt = self.utt
        audio = self.endpointer.current_audio()
        self._partial_task = asyncio.create_task(self._partial(utt, audio))

    async def _partial(self, utt: Utterance, audio: np.ndarray) -> None:
        lang = self.smoother.hint()
        stt_lang = "en" if lang == "pcm" else lang
        try:
            res = await self.p.stt(audio, stt_lang, final=False,
                                   hotwords=glossary_hotwords(self.guild.glossary, lang or "en"))
        except Exception as e:  # noqa: BLE001
            log.debug("partial failed: %s", e)
            return
        if utt.finalized or self.closed or not res.text:
            return
        work_lang = lang or res.language
        if self.agreement.lang != work_lang:
            self.agreement.reset(work_lang)
        _, tentative = self.agreement.update(res.text)
        committed = self.agreement.text
        self.endpointer.allow_fast_end(T.ends_clause(res.text))
        self.conn.emit({"type": "partial", "sid": self.sid, "utt_id": utt.id, "lang": work_lang,
                        "committed": committed, "tentative": T.join_units(tentative, work_lang)},
                       droppable=True)
        n_units = len(self.agreement.committed)
        targets = sorted(self.guild.all_targets() - {work_lang})
        # speculative caption translation when committed text grew enough
        if targets and n_units - utt.spec_units >= 3:
            utt.spec_units = n_units
            asyncio.create_task(self._speculative_caption(utt, committed, work_lang, targets))
        # incremental dubbing of newly stable clauses
        if self._incremental_enabled():
            clauses = T.stable_clauses(committed, work_lang)
            for clause in clauses[utt.n_clauses:]:
                utt.n_clauses += 1
                utt.spoken_src = (utt.spoken_src + " " + clause).strip()
                for tgt in sorted(self.guild.audio_targets - {work_lang}):
                    task = asyncio.create_task(self._dub_text(utt, clause, work_lang, tgt, StageTimer(),
                                                             incremental=True))
                    utt.incremental_dubs.append(task)

    async def _speculative_caption(self, utt, text, src, targets) -> None:
        out = {}
        for tgt in targets:
            try:
                tr = await self.p.translate([text], src, tgt, mode="literal", glossary=self.guild.glossary)
                out[tgt] = tr[0].text
            except Exception:  # noqa: BLE001
                continue
        if out and not utt.finalized:
            self.conn.emit({"type": "partial_translation", "sid": self.sid, "utt_id": utt.id, "lang": src,
                            "translations": out}, droppable=True)

    # ------------------------------------------------------------------ finals
    async def _final_loop(self) -> None:
        while True:
            utt = await self._final_q.get()
            if utt is None:
                return
            try:
                await self._final(utt)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.exception("final processing failed")
                self.conn.emit({"type": "error", "sid": self.sid, "utt_id": utt.id, "stage": "final",
                                "message": str(e)[:300]})

    async def _stt_lid(self, audio: np.ndarray) -> tuple[STTResult, LIDDecision]:
        dur = audio.size / SR
        hw = glossary_hotwords(self.guild.glossary, self.smoother.hint() or "en")
        if self.smoother.forced:
            lang = self.smoother.forced
            res = await self.p.stt(audio, "en" if lang == "pcm" else lang, final=True, hotwords=hw)
            return res, LIDDecision(lang, 1.0, reason="forced")
        if self.smoother.wants_detection():
            res = await self.p.stt(audio, None, final=True, hotwords=hw)
            probs = res.language_probs or {res.language: max(res.language_prob, 0.5)}
            dec = self.smoother.update(probs, dur)
            if dec.lang != L.normalize(res.language):
                self.p.metrics.inc("lid_redecode")
                res = await self.p.stt(audio, dec.lang, final=True, hotwords=hw)
            return res, dec
        lang = self.smoother.current or "en"
        res = await self.p.stt(audio, lang, final=True, hotwords=hw)
        return res, LIDDecision(lang, self.smoother.prior.get(lang, 0.0), reason="locked")

    async def _final(self, utt: Utterance) -> None:
        timer = StageTimer(utt.t_endpoint)
        audio = utt.audio if utt.audio is not None else np.zeros(0, dtype=np.float32)
        dur = audio.size / SR
        if self._partial_task and not self._partial_task.done():
            self._partial_task.cancel()

        # 1) language + transcript; long utterances are split for code-switching
        ranges = [(0, audio.size)]
        if dur >= self.cfg.pipeline.long_utterance_s and not self.smoother.forced and utt.probs is not None:
            ranges = split_on_pauses(audio, utt.probs, utt.window)
        pieces: list[tuple[str, STTResult, LIDDecision]] = []
        try:
            for a, b in ranges:
                res, dec = await self._stt_lid(audio[a:b])
                if dec.switched:
                    self.conn.emit({"type": "lang_switch", "sid": self.sid, "utt_id": utt.id,
                                    "from": dec.previous, "to": dec.lang, "reason": dec.reason})
                pieces.append((dec.lang, res, dec))
        except NoProvider as e:
            self.conn.emit({"type": "notice", "sid": self.sid, "level": "warn", "code": "stt_unavailable",
                            "message": str(e)})
            return
        timer.mark("stt")

        # merge adjacent pieces in the same language
        merged: list[list] = []
        for lang, res, dec in pieces:
            text = res.text.strip()
            if not text:
                continue
            if merged and merged[-1][0] == lang:
                merged[-1][1] = (merged[-1][1] + " " + text).strip()
                merged[-1][2].append(res)
            else:
                merged.append([lang, text, [res], dec])
        full_text = " ".join(m[1] for m in merged).strip()
        main = max(merged, key=lambda m: len(m[1])) if merged else None
        avg_lp = float(np.mean([r.avg_logprob for m in merged for r in m[2]])) if merged else -9.0
        nsp = float(np.max([r.no_speech_prob for m in merged for r in m[2]])) if merged else 1.0
        if not main or T.is_hallucination(full_text, dur, avg_lp, nsp):
            self.stats["hallucinations"] += 1
            self.p.metrics.inc("discarded_utterances")
            self.conn.emit({"type": "discard", "sid": self.sid, "utt_id": utt.id, "reason": "no-speech"},
                           droppable=True)
            return

        # 2) Nigerian Pidgin second pass on English transcripts
        for m in merged:
            if m[0] == "en" and not self.smoother.forced and self._pidgin_allowed():
                if len(m[1].split()) >= 5 and L.pidgin_score(m[1]) >= 0.12:
                    m[0] = "pcm"
        src_lang = main[0]

        lid_prob = main[3].prob if main[3] else 0.0
        confidence = max(0.0, min(1.0, math.exp(avg_lp) * (1.0 - nsp)))
        flags = []
        if avg_lp < self.cfg.pipeline.low_confidence_logprob or confidence < 0.45:
            flags.append("low_confidence")
        if L.get(src_lang) and L.get(src_lang).stt_grade == "poor":
            flags.append("weak_language")

        # 3) translate into every target the guild needs. A code-switched utterance is also
        #    translated into its main language (its foreign parts are new to those listeners).
        multilingual = len({m[0] for m in merged}) > 1
        targets = sorted(self.guild.all_targets() - (set() if multilingual else {src_lang}))
        context = self.guild.remember_context(self.sid, full_text)
        translations: dict[str, dict] = {}

        async def tr_target(tgt: str):
            parts, foreign, notes, provider, mode = [], [], [], "", self.guild.mode
            for lang, text, _, _ in merged:
                if lang == tgt:
                    parts.append(text)
                    continue
                try:
                    r = (await self.p.translate([text], lang, tgt, mode=self.guild.mode,
                                                glossary=self.guild.glossary, context=context))[0]
                except NoProvider as e:
                    notes.append(str(e))
                    return tgt, None
                parts.append(r.text)
                foreign.append(r.text)
                provider, mode = r.provider, r.mode
                if r.note:
                    notes.append(r.note)
            return tgt, {"text": " ".join(parts).strip(), "provider": provider or "passthrough", "mode": mode,
                         "note": "; ".join(dict.fromkeys(notes)), "_dub": " ".join(foreign).strip()}

        for tgt, tr in await asyncio.gather(*(tr_target(t) for t in targets)):
            if tr is None:
                translations[tgt] = {"text": None, "provider": None, "mode": None,
                                     "note": f"no translation model for {src_lang}->{tgt}"}
            else:
                translations[tgt] = tr
        timer.mark("mt")
        self.p.metrics.observe("end_to_caption", utt.endpoint_ms + timer.marks["mt"])

        # 4) tiers for audio targets
        clone_ok = self._clone_allowed()
        tiers = {}
        for tgt in self.guild.audio_targets - (set() if multilingual else {src_lang}):
            if translations.get(tgt, {}).get("text") is None:
                tiers[tgt] = 3 if tgt in translations else 0
            elif clone_ok and self.p.tts_available(tgt, clone=True) and self._clone_supports(tgt):
                tiers[tgt] = 1
            elif self.p.tts_available(tgt):
                tiers[tgt] = 2
            else:
                tiers[tgt] = 3

        self.stats["utterances"] += 1
        self.p.metrics.inc("utterances")
        self.p.metrics.inc(f"src_lang:{src_lang}")
        english = translations.get("en", {}).get("text") if src_lang != "en" else full_text
        self.guild.add_transcript(user_id=self.user_id, name=self.name, lang=src_lang, text=full_text,
                                  english=english)
        public_tr = {k: {kk: vv for kk, vv in v.items() if not kk.startswith("_")} for k, v in translations.items()}
        self.conn.emit({
            "type": "final", "sid": self.sid, "utt_id": utt.id, "user_id": self.user_id,
            "lang": src_lang, "lang_prob": round(lid_prob, 3), "lid_reason": main[3].reason if main[3] else "",
            "segments": [{"lang": m[0], "text": m[1]} for m in merged],
            "text": full_text, "confidence": round(confidence, 3), "flags": flags,
            "translations": public_tr, "tiers": tiers, "stt_provider": main[2][0].provider,
            "duration_s": round(dur, 2), "endpoint_reason": utt.reason,
            "latency": {"vad_endpoint": round(utt.endpoint_ms, 1), **timer.as_dict()},
        })

        # 5) dubs (independent tasks; the next utterance can proceed)
        prosody = self._prosody(audio, full_text)
        for tgt, tier in tiers.items():
            tr = translations.get(tgt) or {}
            if not tr.get("text") or tier == 0 or tier == 3:
                continue
            # listeners of the main language already heard its parts: dub only the foreign parts
            text = tr.get("_dub") if tgt == src_lang else tr["text"]
            if not text:
                continue
            if utt.spoken_src and tgt != src_lang:
                # incremental dubbing already spoke part of it: only dub the rest
                rest_src = T.remainder_after(utt.spoken_src, full_text, src_lang)
                if not rest_src.strip():
                    continue
                try:
                    text = (await self.p.translate([rest_src], src_lang, tgt, mode=self.guild.mode,
                                                   glossary=self.guild.glossary))[0].text
                except NoProvider:
                    continue
            task = asyncio.create_task(self._dub_text(utt, text, src_lang, tgt, timer, tier=tier,
                                                      prosody=prosody, translated=True))
            self._dub_tasks.add(task)
            task.add_done_callback(self._dub_tasks.discard)

    # ------------------------------------------------------------------ dubbing
    def _pidgin_allowed(self) -> bool:
        ex = self.guild.expected_langs
        return ex is None or "pcm" in ex

    def _clone_allowed(self) -> bool:
        return (self.guild.voice_mode == "clone" and self.user_id in self.guild.clone_users
                and self.voices is not None and self.voices.has(self.user_id))

    def _clone_supports(self, lang: str) -> bool:
        return any(getattr(p, "clones", False) and p.supports(lang) for p in self.p.router.p.clone)

    def _prosody(self, audio: np.ndarray, text: str) -> Prosody:
        if not self.cfg.tts.speed_match:
            return Prosody()
        f = prosody_features(audio, SR, len(text.split()))
        wps, rms = f["words_per_s"], f["rms_db"]
        if wps > 0:
            self._wps_base = wps if not self._wps_base else 0.8 * self._wps_base + 0.2 * wps
        self._rms_base = rms if not self._rms_base else 0.9 * self._rms_base + 0.1 * rms
        rate = (wps / self._wps_base) if (wps and self._wps_base) else 1.0
        energy = 10 ** ((rms - self._rms_base) / 40.0)
        expr = (f["pitch_std_st"] - 1.0) / 4.0
        return Prosody(rate=float(np.clip(rate, 0.85, 1.2)), energy=float(np.clip(energy, 0.8, 1.25)),
                       expressiveness=float(np.clip(expr, 0.0, 1.0)))

    async def _dub_text(self, utt: Utterance, text: str, src: str, tgt: str, timer: StageTimer, *,
                        tier: int | None = None, prosody: Prosody | None = None, incremental: bool = False,
                        translated: bool = False) -> None:
        if not translated:
            try:
                text = (await self.p.translate([text], src, tgt, mode=self.guild.mode,
                                               glossary=self.guild.glossary))[0].text
            except NoProvider:
                return
        # incremental clause dubs must finish before the final remainder is spoken
        if not incremental and utt.incremental_dubs:
            await asyncio.gather(*utt.incremental_dubs, return_exceptions=True)
        stale_s = getattr(self.cfg.pipeline, "stale_dub_s", 0) or 0
        waited = time.perf_counter() - (utt.t_endpoint or utt.t_start)
        if not incremental and stale_s and waited > stale_s:
            self.p.metrics.inc("dubs_dropped_stale")
            self.conn.emit({"type": "notice", "sid": self.sid, "utt_id": utt.id, "level": "info",
                            "code": "dub_stale", "message": f"dub to {tgt} dropped (late by {waited:.1f}s)"},
                           droppable=True)
            return
        voice = None
        if self._clone_allowed() and self._clone_supports(tgt):
            voice = await self.p.run_misc(self.voices.load, self.user_id)
        token = CancelToken()
        dub_id = self.conn.new_dub_id()
        self.conn.register_dub(dub_id, token)
        info: dict = {}
        seq = 0
        started = False
        try:
            async for pcm in self.p.synth(text, tgt, voice=voice, prosody=prosody, token=token, info=info):
                if not started:
                    started = True
                    first_ms = timer.mark("tts_first_audio")
                    if not incremental:
                        self.p.metrics.observe("tts_first_audio", first_ms - timer.marks.get("mt", first_ms))
                        self.p.metrics.observe("end_to_first_audio", utt.endpoint_ms + first_ms)
                    self.conn.emit({"type": "tts_start", "dub_id": dub_id, "sid": self.sid, "utt_id": utt.id,
                                    "user_id": self.user_id, "lang": tgt, "text": text,
                                    "tier": 1 if info.get("voice") == "clone" else 2,
                                    "voice": info.get("voice"), "provider": info.get("provider"),
                                    "incremental": incremental, "sample_rate": 48000})
                self.conn.emit_audio(dub_id, seq, pcm)
                seq += 1
        except NoProvider as e:
            self.conn.emit({"type": "notice", "sid": self.sid, "utt_id": utt.id, "level": "warn",
                            "code": "tts_unavailable", "message": str(e)})
        except Exception as e:  # noqa: BLE001
            log.warning("dub failed: %s", e)
            self.conn.emit({"type": "notice", "sid": self.sid, "utt_id": utt.id, "level": "warn",
                            "code": "tts_failed", "message": str(e)[:200]})
        finally:
            self.conn.unregister_dub(dub_id)
            if started:
                self.conn.emit({"type": "tts_end", "dub_id": dub_id, "cancelled": token.cancelled
                                and token.reason not in ("", "closed"), "reason": token.reason,
                                "truncated": info.get("truncated"), "frames": seq,
                                "latency": timer.as_dict()})

    # ------------------------------------------------------------------ close
    async def close(self) -> None:
        if self.closed:
            return
        for ev in self.endpointer.flush():
            if isinstance(ev, SpeechEnd):
                self._on_end(ev)
        self.closed = True
        await self._final_q.put(None)
        try:
            await asyncio.wait_for(self._final_task, timeout=30)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            self._final_task.cancel()
        if self._dub_tasks:
            await asyncio.wait(self._dub_tasks, timeout=30)
