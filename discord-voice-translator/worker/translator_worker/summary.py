"""Post-call multilingual summary with action items.

With an LLM (local Ollama or any OpenAI-compatible key) the summary is
abstractive. Without one, an extractive fallback is produced and clearly
labelled as such. The summary is written in English first and then
translated with the normal MT stack into each requested language.
"""

from __future__ import annotations

import json
import re

from .guild import GuildState
from .pipeline import Pipeline
from .router import NoProvider

ACTION_CUES = re.compile(
    r"\b(i'?ll|i will|we will|we'?ll|we need to|we should|let'?s|todo|to-do|action item|deadline|by (monday|tuesday|"
    r"wednesday|thursday|friday|tomorrow|next week)|can you|could you|please|make sure|follow up|send|remind)\b",
    re.IGNORECASE)

SYSTEM = (
    "You summarise multilingual voice calls. Input lines are '[speaker] (language) text || english'. "
    "Write in English. Be factual; do not invent anything that is not in the transcript. "
    "Return JSON: {\"summary\": \"4-8 sentence summary\", \"decisions\": [\"...\"], "
    "\"action_items\": [{\"owner\": \"speaker name or 'unassigned'\", \"item\": \"...\", \"due\": \"... or null\"}]}"
)


def _lines(guild: GuildState, limit_chars: int = 24000) -> list[str]:
    out = []
    for t in guild.transcript:
        en = t.get("en") or t["text"]
        out.append(f"[{t['name']}] ({t['lang']}) {t['text']} || {en}")
    text = "\n".join(out)
    if len(text) > limit_chars:  # keep the end of long calls
        text = text[-limit_chars:]
        out = text.split("\n")[1:]
    return out


def _normalize(data) -> dict:
    """LLMs return varied shapes; coerce to {summary: str, decisions: [str], action_items: [{owner,item,due}]}."""
    if not isinstance(data, dict):
        data = {"summary": str(data)}
    summary = data.get("summary") or ""
    if isinstance(summary, list):
        summary = " ".join(map(str, summary))
    decisions = data.get("decisions") or []
    if isinstance(decisions, str):
        decisions = [decisions]
    items = []
    for a in data.get("action_items") or []:
        if isinstance(a, str):
            items.append({"owner": "unassigned", "item": a, "due": None})
        elif isinstance(a, dict) and (a.get("item") or a.get("task")):
            items.append({"owner": str(a.get("owner") or a.get("assignee") or "unassigned"),
                          "item": str(a.get("item") or a.get("task")), "due": a.get("due")})
    return {"summary": str(summary), "decisions": [str(d) for d in decisions], "action_items": items}


def extractive(guild: GuildState) -> dict:
    rows = list(guild.transcript)
    speakers = sorted({r["name"] for r in rows})
    langs = sorted({r["lang"] for r in rows})
    english = [(r["name"], (r.get("en") or r["text"]).strip()) for r in rows]
    actions = [{"owner": n, "item": t, "due": None} for n, t in english if ACTION_CUES.search(t)][:10]
    key = sorted(english, key=lambda x: -len(x[1]))[:5]
    summary = (f"{len(rows)} utterances from {len(speakers)} speaker(s) ({', '.join(speakers)}) "
               f"in {', '.join(langs)}. Longest points: " + " | ".join(f"{n}: {t}" for n, t in key))
    return {"summary": summary, "decisions": [], "action_items": actions}


async def summarize(pipeline: Pipeline, guild: GuildState, langs: list[str]) -> dict:
    if not guild.transcript:
        return {"method": "none", "by_lang": {}, "note": "nothing was said while summaries were enabled"}
    method, note = "llm", ""
    try:
        raw = await pipeline.llm(SYSTEM, "\n".join(_lines(guild)), max_tokens=900, json_mode=True)
        m = re.search(r"\{.*\}", raw, re.S)
        data = _normalize(json.loads(m.group(0) if m else raw))
    except NoProvider:
        method, note = "extractive", "no LLM configured - extractive summary (quotes, not a written summary)"
        data = extractive(guild)
    except Exception as e:  # noqa: BLE001
        method, note = "extractive", f"LLM failed ({str(e)[:120]}) - extractive summary"
        data = extractive(guild)

    by_lang: dict[str, dict] = {"en": data}
    for lang in langs:
        if lang == "en" or lang in by_lang:
            continue
        texts = [data["summary"]] + list(data.get("decisions", [])) + [a["item"] for a in data["action_items"]]
        try:
            tr = await pipeline.translate(texts, "en", lang, mode="literal")
        except NoProvider:
            by_lang[lang] = {"error": f"no translation into {lang}"}
            continue
        t = [x.text for x in tr]
        nd = len(data.get("decisions", []))
        by_lang[lang] = {
            "summary": t[0],
            "decisions": t[1:1 + nd],
            "action_items": [{**a, "item": t[1 + nd + i]} for i, a in enumerate(data["action_items"])],
        }
    return {"method": method, "note": note, "by_lang": by_lang,
            "utterances": len(guild.transcript)}
