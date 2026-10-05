"""Per-guild state pushed by the edge (settings, glossary, consented voices)
plus the in-RAM transcript used for post-call summaries."""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field

from . import languages as L
from .providers.base import GlossaryTerm


@dataclass
class GuildState:
    guild_id: str
    text_targets: set[str] = field(default_factory=lambda: {"en"})
    audio_targets: set[str] = field(default_factory=set)
    mode: str = "literal"                  # literal | natural | cultural
    voice_mode: str = "house"              # house | clone
    expected_langs: set[str] | None = None # restrict auto-detect (improves accuracy)
    glossary: list[GlossaryTerm] = field(default_factory=list)
    clone_users: set[str] = field(default_factory=set)
    summaries: bool = True
    incremental_dub: bool | None = None    # None = worker default
    transcript: deque = field(default_factory=lambda: deque(maxlen=2000))
    context: dict[str, deque] = field(default_factory=dict)  # per-speaker recent sentences

    def update(self, msg: dict) -> None:
        if "text_targets" in msg:
            self.text_targets = {L.normalize(x) for x in msg["text_targets"] if x}
        if "audio_targets" in msg:
            self.audio_targets = {L.normalize(x) for x in msg["audio_targets"] if x}
        if "mode" in msg and msg["mode"] in ("literal", "natural", "cultural"):
            self.mode = msg["mode"]
        if "voice_mode" in msg and msg["voice_mode"] in ("house", "clone"):
            self.voice_mode = msg["voice_mode"]
        if "expected_langs" in msg:
            ex = msg["expected_langs"]
            self.expected_langs = {L.normalize(x) for x in ex} if ex else None
        if "glossary" in msg:
            self.glossary = [GlossaryTerm(source=g["source"], target=g["target"],
                                          src_lang=g.get("src_lang", "*") or "*",
                                          tgt_lang=g.get("tgt_lang", "*") or "*",
                                          kind=g.get("kind", "term")) for g in msg["glossary"]]
        if "clone_users" in msg:
            self.clone_users = set(map(str, msg["clone_users"]))
        if "summaries" in msg:
            self.summaries = bool(msg["summaries"])
        if "incremental_dub" in msg:
            v = msg["incremental_dub"]
            self.incremental_dub = None if v is None else bool(v)

    def all_targets(self) -> set[str]:
        return set(self.text_targets) | set(self.audio_targets)

    def add_transcript(self, *, user_id: str, name: str, lang: str, text: str, english: str | None) -> None:
        if self.summaries:
            self.transcript.append({"ts": time.time(), "user_id": user_id, "name": name, "lang": lang,
                                    "text": text, "en": english})

    def remember_context(self, sid: int, text: str, n: int = 3) -> list[str]:
        dq = self.context.setdefault(str(sid), deque(maxlen=n))
        prev = list(dq)
        dq.append(text)
        return prev
