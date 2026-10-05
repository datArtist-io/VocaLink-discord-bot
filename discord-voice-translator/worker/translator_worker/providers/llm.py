"""OpenAI-compatible chat LLM (Ollama, vLLM, llama.cpp server, OpenAI, Groq...).

Used for natural / cultural translation modes, Nigerian Pidgin output and
post-call summaries. A base_url on localhost / a docker service name counts as
a *local* provider (no data leaves your infrastructure).
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

from .. import languages as L
from . import http
from .base import MTResult, ProviderInfo

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "ollama", "llm", "vllm", "host.docker.internal"}


def is_local_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host in LOCAL_HOSTS or host.endswith(".local") or host.startswith("10.") or host.startswith("192.168.")


class OpenAIChatLLM:
    def __init__(self, base_url: str, model: str, api_key: str = "", *, timeout: float = 20.0,
                 license: str = "model-dependent", commercial_ok: bool = True, name: str = "llm"):
        self.base = base_url.rstrip("/")
        self.model = model
        self.key = api_key
        self.timeout = timeout
        local = is_local_url(base_url)
        self.info = ProviderInfo(f"{name}:{model}", "llm", local=local, license=license,
                                 commercial_ok=commercial_ok, cost_per_hour_usd=0.0 if local else 0.2,
                                 max_concurrency=4)

    def chat(self, system: str, user: str, *, max_tokens: int = 512, temperature: float = 0.2,
             json_mode: bool = False) -> str:
        body = {"model": self.model, "temperature": temperature, "max_tokens": max_tokens,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        headers = {"Authorization": f"Bearer {self.key}"} if self.key else {}
        r = http.request("POST", f"{self.base}/chat/completions", json=body, headers=headers,
                         timeout=self.timeout)
        if r.status == 400 and json_mode:  # server without JSON mode support
            body.pop("response_format", None)
            r = http.request("POST", f"{self.base}/chat/completions", json=body, headers=headers,
                             timeout=self.timeout)
        r.raise_for_status(self.info.name)
        return r.json()["choices"][0]["message"]["content"].strip()


_STYLE = {
    "literal": "Translate faithfully and literally. Keep names and numbers unchanged.",
    "natural": ("Translate into natural, idiomatic, conversational speech as a native speaker would say it. "
                "Keep the meaning, tone and register; keep names unchanged."),
    "cultural": ("Translate for a listener from the target culture: replace idioms, jokes and cultural "
                 "references with equivalents they would understand. If you changed a reference, append a "
                 "very short explanation in square brackets at the end, e.g. [idiom: 'break a leg' = good luck]."),
}


class LLMTranslator:
    modes = ("literal", "natural", "cultural")

    def __init__(self, llm: OpenAIChatLLM):
        self.llm = llm
        i = llm.info
        self.info = ProviderInfo(i.name.replace("llm:", "llm-mt:", 1), "mt", local=i.local, license=i.license,
                                 commercial_ok=i.commercial_ok, cost_per_hour_usd=i.cost_per_hour_usd,
                                 max_concurrency=i.max_concurrency)

    def supports(self, src: str, tgt: str) -> bool:
        return L.get(src) is not None and L.get(tgt) is not None

    def translate(self, texts, src, tgt, *, mode="literal", glossary=None, context=None) -> list[MTResult]:
        from ..glossary import prompt_block

        sys = (f"You are a live voice-call interpreter from {L.display(src)} to {L.display(tgt)}. "
               f"{_STYLE.get(mode, _STYLE['literal'])} Output ONLY the translation, no quotes, no commentary.")
        if tgt == "pcm":
            sys += " Write in Nigerian Pidgin English as spoken in Lagos, using common Pidgin spelling."
        gl = prompt_block(glossary or [], src, tgt)
        if gl:
            sys += "\n" + gl
        out = []
        for t in texts:
            user = t
            if context:
                user = "Previous lines (context, do not translate):\n" + "\n".join(context[-3:]) + \
                       "\n\nTranslate this line:\n" + t
            txt = self.llm.chat(sys, user, max_tokens=400, temperature=0.2 if mode == "literal" else 0.4)
            note = ""
            if mode == "cultural":
                m = re.search(r"\s*\[([^\]]{3,200})\]\s*$", txt)
                if m:
                    note, txt = m.group(1), txt[: m.start()].rstrip()
            out.append(MTResult(txt.strip().strip('"'), self.info.name, mode, note))
        return out
