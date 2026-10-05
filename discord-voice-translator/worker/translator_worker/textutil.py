"""Text helpers: word units, LocalAgreement commit policy, clause splitting,
hallucination filtering and fuzzy matching."""

from __future__ import annotations

import difflib
import re
import unicodedata

# Languages written without spaces between words: work on characters.
NO_SPACE = {"zh", "ja", "yue", "th", "lo", "km", "my", "bo"}

CLAUSE_END = re.compile(r"([.!?;:。！？；：…]+|,|，|、)(\s+|$)")
SENTENCE_END = re.compile(r"[.!?。！？…]\s*$")
_PUNCT = re.compile(r"[\W_]+", re.UNICODE)

# Whisper's well-known hallucinations on silence / noise.
HALLUCINATIONS = {
    "thank you", "thank you.", "thanks for watching", "thanks for watching!", "thank you for watching",
    "subtitles by the amara.org community", "you", "bye", "bye.", "so", "okay.", ".", "...",
    "please subscribe", "like and subscribe", "music", "[music]", "(music)", "♪",
    "sous-titres réalisés par la communauté d'amara.org", "untertitel der amara.org-community",
    "ご視聴ありがとうございました", "谢谢观看", "字幕由amara.org社区提供",
}


def units(text: str, lang: str) -> list[str]:
    if lang in NO_SPACE:
        return [c for c in text if not c.isspace()]
    return text.split()


def join_units(us: list[str], lang: str) -> str:
    return ("" if lang in NO_SPACE else " ").join(us)


def norm_unit(u: str) -> str:
    u = unicodedata.normalize("NFKC", u).lower()
    return _PUNCT.sub("", u)


def normalize_text(t: str) -> str:
    return " ".join(norm_unit(u) for u in t.split() if norm_unit(u))


class LocalAgreement:
    """LocalAgreement-2: commit the longest prefix shared by two consecutive
    hypotheses. Committed units never change (they may be refined by the
    final decode, which replaces everything)."""

    def __init__(self, lang: str = "en"):
        self.lang = lang
        self.committed: list[str] = []
        self.prev: list[str] = []

    def reset(self, lang: str | None = None) -> None:
        if lang:
            self.lang = lang
        self.committed, self.prev = [], []

    def update(self, hypothesis: str) -> tuple[list[str], list[str]]:
        hyp = units(hypothesis, self.lang)
        n = len(self.committed)
        # the hypothesis must still agree with what we already committed
        if [norm_unit(u) for u in hyp[:n]] != [norm_unit(u) for u in self.committed]:
            self.prev = hyp
            return [], hyp[n:] if len(hyp) > n else []
        new: list[str] = []
        i = n
        while i < len(hyp) and i < len(self.prev) and norm_unit(hyp[i]) == norm_unit(self.prev[i]):
            new.append(hyp[i])
            i += 1
        self.committed.extend(new)
        self.prev = hyp
        return new, hyp[len(self.committed):]

    @property
    def text(self) -> str:
        return join_units(self.committed, self.lang)


def split_clauses(text: str, *, min_units: int = 3, lang: str = "en") -> list[str]:
    """Split into clauses ending with punctuation. Short comma-clauses are merged."""
    parts: list[str] = []
    last = 0
    for m in CLAUSE_END.finditer(text):
        end = m.end()
        seg = text[last:end].strip()
        if not seg:
            continue
        is_comma = m.group(1) in (",", "，", "、")
        if is_comma and len(units(seg, lang)) < min_units:
            continue  # keep accumulating
        parts.append(seg)
        last = end
    rest = text[last:].strip()
    if rest:
        parts.append(rest)
    return parts


def stable_clauses(committed: str, lang: str = "en") -> list[str]:
    """Clauses of committed text that are complete (end with punctuation)."""
    cl = split_clauses(committed, lang=lang)
    if cl and not CLAUSE_END.search(cl[-1] + " "):
        cl = cl[:-1]
    return cl


def ends_clause(text: str) -> bool:
    return bool(re.search(r"[.!?;:。！？；：…,，、]\s*$", text.strip()))


def is_hallucination(text: str, duration_s: float, avg_logprob: float, no_speech_prob: float) -> bool:
    t = text.strip().lower()
    if not t:
        return True
    if t in HALLUCINATIONS and (duration_s < 2.5 or no_speech_prob > 0.4 or avg_logprob < -0.8):
        return True
    if no_speech_prob > 0.7 and avg_logprob < -1.0:
        return True
    # pathological repetition ("the the the the ...")
    toks = t.split()
    if len(toks) >= 8 and len(set(toks)) <= 2:
        return True
    return False


def similarity(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, normalize_text(a), normalize_text(b)).ratio()


def remainder_after(spoken: str, final: str, lang: str = "en") -> str:
    """Return the part of `final` not yet covered by already-dubbed `spoken` text."""
    if not spoken.strip():
        return final
    s = [norm_unit(u) for u in units(spoken, lang)]
    f_units = units(final, lang)
    f = [norm_unit(u) for u in f_units]
    sm = difflib.SequenceMatcher(None, s, f, autojunk=False)
    # find furthest position in final aligned with the end of spoken
    best = 0
    for blk in sm.get_matching_blocks():
        if blk.size and blk.a + blk.size >= len(s) - 1:
            best = max(best, blk.b + blk.size)
    if best == 0:
        m = sm.find_longest_match(0, len(s), 0, len(f))
        best = m.b + m.size if m.size >= max(2, len(s) // 2) else 0
    return join_units(f_units[best:], lang)
