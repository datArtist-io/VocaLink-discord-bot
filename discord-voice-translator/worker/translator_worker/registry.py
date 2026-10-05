"""Capability registry: which languages reach which tier, generated at startup
from the providers that are actually loaded (and allowed by policy/licence).

Target tiers (what a *listener* gets in language X)
    1  cloned-voice speech   (MT into X + a cloning TTS for X + speaker consent)
    2  standard-voice speech (MT into X + any house TTS voice for X)
    3  captions only         (MT into X, no usable voice)
    0  unsupported

Source support (what a *speaker* can speak) is the best STT grade available.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from . import languages as L
from .router import TTS_VOICE_FALLBACK, Router

_SIZE_PENALTY = {"tiny": 2, "base": 2, "small": 1, "medium": 0, "large-v3-turbo": 0, "large-v3": 0,
                 "large-v2": 0, "turbo": 0}


@dataclass
class LangCapability:
    code: str
    name: str
    stt_grade: str
    stt_provider: str | None
    auto_detect: bool
    mt_provider: str | None
    tts_provider: str | None
    clone_provider: str | None
    tier: int
    tier_label: str
    reasons: list[str]
    notes: str = ""


TIER_LABEL = {1: "cloned voice", 2: "standard voice", 3: "captions only", 0: "unsupported"}


def _stt_grade(router: Router, code: str, whisper_size: str) -> tuple[str, str | None, bool]:
    lang = L.get(code)
    best, best_p, auto = "none", None, False
    for p in router.stt_chain(code if code != "pcm" else "en"):
        if p.info.name.startswith("faster_whisper"):
            if code == "pcm":
                g = "fair"   # transcribed as English, relabelled by the transcript-level Pidgin detector
            else:
                g = lang.stt_grade if lang else "none"
                pen = _SIZE_PENALTY.get(whisper_size, 0)
                if g != "good" or pen >= 2:
                    g = L.downgrade(g, pen)
                if g == "none" and lang and lang.whisper:
                    g = "poor"  # still recognisable, just very inaccurate on small models
            a = True
        else:
            g = getattr(p, "grade_for", lambda c: "fair")(code)
            a = bool(getattr(p, "detects_language", False))
        if L.GRADE_ORDER.get(g, 0) > L.GRADE_ORDER.get(best, 0):
            best, best_p, auto = g, p.info.name, a
    return best, best_p, auto


def build(router: Router, *, whisper_size: str = "large-v3", codes: list[str] | None = None) -> dict[str, LangCapability]:
    out: dict[str, LangCapability] = {}
    for code in codes or list(L.LANGUAGES):
        lang = L.LANGUAGES[code]
        grade, stt_p, auto = _stt_grade(router, code, whisper_size)
        src_for_mt = "en" if code != "en" else "fr"
        mt = router.mt_chain(src_for_mt, code, "literal")
        mt_p = mt[0].info.name if mt else None
        tts = router.tts_chain(code, clone=False)
        tts_p = tts[0].info.name if tts else None
        clone = [p for p in router.tts_chain(code, clone=True) if getattr(p, "clones", False)]
        clone_p = clone[0].info.name if clone else None
        reasons: list[str] = []
        if not mt_p:
            tier = 0
            reasons.append("no translation model covers this language")
        elif clone_p:
            tier = 1
        elif tts_p:
            tier = 2
            reasons.append("no voice-cloning model supports this language" if router.p.clone
                           else "voice cloning is not enabled on this hardware tier")
        else:
            tier = 3
            reasons.append("no speech voice installed for this language"
                           + (" (MMS-TTS is non-commercial and commercial mode is on)"
                              if router.commercial and lang.mms_iso3 else ""))
        if code in TTS_VOICE_FALLBACK and tts_p:
            reasons.append(f"spoken with the {L.display(TTS_VOICE_FALLBACK[code])} voice")
        if code == "pcm":
            reasons.append("detected from English-like transcripts; /mylang speak:pcm is more reliable")
        if lang.whisper and _SIZE_PENALTY.get(whisper_size, 0) and lang.stt_grade in ("fair", "poor"):
            reasons.append(f"recognition is less accurate on the CPU-tier '{whisper_size}' Whisper model")
        if grade == "none":
            reasons.append("cannot be recognised as a spoken (source) language with the loaded STT models")
        elif grade == "poor":
            reasons.append("speech recognition accuracy is low; captions may contain errors")
        if not auto and grade != "none":
            reasons.append("not auto-detected; speakers should set /mylang speak:" + code)
        out[code] = LangCapability(code, lang.name, grade, stt_p, auto, mt_p, tts_p, clone_p, tier,
                                   TIER_LABEL[tier], reasons, lang.notes)
    return out


def summary(caps: dict[str, LangCapability]) -> dict:
    by_tier: dict[int, list[str]] = {1: [], 2: [], 3: [], 0: []}
    for c in caps.values():
        by_tier[c.tier].append(c.code)
    src = {g: [c.code for c in caps.values() if c.stt_grade == g] for g in ("good", "fair", "poor", "none")}
    return {"targets_by_tier": {str(k): v for k, v in by_tier.items()}, "sources_by_grade": src,
            "counts": {f"tier{k}": len(v) for k, v in by_tier.items()}}


def as_json(caps: dict[str, LangCapability]) -> list[dict]:
    return [asdict(c) for c in caps.values()]
