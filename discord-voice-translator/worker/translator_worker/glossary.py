"""Per-guild glossaries.

* "term" entries make a source term come out as a fixed target string. For
  NMT models we substitute the source term with the desired target string
  before translation (NLLB/MADLAD copy foreign tokens through reliably) and
  verify afterwards; for LLM translation the glossary goes into the prompt.
* "fix" entries are post-edits on the output, learned from /correct.
* Source terms also become Whisper `hotwords`, so names are recognised.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .providers.base import GlossaryTerm
from .textutil import NO_SPACE


@dataclass
class GlossaryApplied:
    text: str
    used: list[GlossaryTerm]


def _applies(t: GlossaryTerm, src: str, tgt: str) -> bool:
    return (t.src_lang in ("*", src)) and (t.tgt_lang in ("*", tgt))


def _pattern(term: str, lang: str) -> re.Pattern:
    esc = re.escape(term)
    if lang in NO_SPACE:
        return re.compile(esc, re.IGNORECASE)
    return re.compile(rf"(?<!\w){esc}(?!\w)", re.IGNORECASE | re.UNICODE)


def pre_translate(text: str, src: str, tgt: str, terms: list[GlossaryTerm]) -> GlossaryApplied:
    used: list[GlossaryTerm] = []
    out = text
    # longest terms first so "New York City" wins over "New York"
    for t in sorted((t for t in terms if t.kind == "term" and _applies(t, src, tgt)),
                    key=lambda t: -len(t.source)):
        pat = _pattern(t.source, src)
        if pat.search(out):
            out = pat.sub(t.target, out)
            used.append(t)
    return GlossaryApplied(out, used)


def post_translate(text: str, src: str, tgt: str, terms: list[GlossaryTerm]) -> GlossaryApplied:
    used: list[GlossaryTerm] = []
    out = text
    for t in sorted((t for t in terms if t.kind == "fix" and _applies(t, src, tgt)),
                    key=lambda t: -len(t.source)):
        pat = _pattern(t.source, tgt)
        if pat.search(out):
            out = pat.sub(t.target, out)
            used.append(t)
    return GlossaryApplied(out, used)


def verify(text: str, used: list[GlossaryTerm], tgt: str) -> list[GlossaryTerm]:
    """Return term entries whose target string did not survive translation."""
    return [t for t in used if t.kind == "term" and not _pattern(t.target, tgt).search(text)]


def hotwords(terms: list[GlossaryTerm], lang: str, limit: int = 40) -> str | None:
    words = [t.source for t in terms if t.kind == "term" and t.src_lang in ("*", lang)]
    return " ".join(words[:limit]) if words else None


def prompt_block(terms: list[GlossaryTerm], src: str, tgt: str) -> str:
    rows = [f'- "{t.source}" => "{t.target}"' for t in terms if t.kind == "term" and _applies(t, src, tgt)]
    return ("Always translate these terms exactly as given:\n" + "\n".join(rows)) if rows else ""


def learn_from_correction(original: str, corrected: str, src_lang: str, tgt_lang: str,
                          max_span: int = 4) -> list[GlossaryTerm]:
    """Derive small post-edit rules from a user's corrected translation.

    Only short substitutions (<= max_span words on each side) are learned, so a
    full rewrite does not create a pile of junk rules.
    """
    import difflib

    a, b = original.split(), corrected.split()
    sm = difflib.SequenceMatcher(None, [w.lower() for w in a], [w.lower() for w in b], autojunk=False)
    out: list[GlossaryTerm] = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op != "replace":
            continue
        if (i2 - i1) > max_span or (j2 - j1) > max_span:
            continue
        wrong = " ".join(a[i1:i2]).strip(".,!?;:")
        right = " ".join(b[j1:j2]).strip(".,!?;:")
        if wrong and right and wrong.lower() != right.lower():
            out.append(GlossaryTerm(source=wrong, target=right, src_lang=src_lang, tgt_lang=tgt_lang, kind="fix"))
    return out
