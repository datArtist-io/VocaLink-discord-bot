"""Optional cloud MT plug-ins: DeepL and Google Cloud Translation (v2 basic)."""

from __future__ import annotations

from .. import languages as L
from . import http
from .base import MTResult, ProviderInfo

DEEPL_TARGET = {"en": "EN-US", "pt": "PT-BR", "zh": "ZH-HANS", "no": "NB"}
DEEPL_LANGS = set("ar bg cs da de el en es et fi fr hu id it ja ko lt lv no nl pl pt ro ru sk sl sv tr uk zh".split())


class DeepLTranslator:
    modes = ("literal",)

    def __init__(self, api_key: str):
        self.key = api_key
        self.url = ("https://api-free.deepl.com/v2/translate" if api_key.endswith(":fx")
                    else "https://api.deepl.com/v2/translate")
        self.info = ProviderInfo("deepl", "mt", local=False, license="proprietary-api", commercial_ok=True,
                                 cost_per_hour_usd=0.25, max_concurrency=8)

    def supports(self, src, tgt):
        return src in DEEPL_LANGS and tgt in DEEPL_LANGS

    def translate(self, texts, src, tgt, *, mode="literal", glossary=None, context=None):
        body = {"text": texts, "target_lang": DEEPL_TARGET.get(tgt, tgt.upper()), "source_lang": src.upper()}
        if context:
            body["context"] = " ".join(context[-3:])
        r = http.request("POST", self.url, json=body, headers={"Authorization": f"DeepL-Auth-Key {self.key}"},
                         timeout=10).raise_for_status("deepl")
        return [MTResult(t["text"], self.info.name) for t in r.json()["translations"]]


class GoogleTranslator:
    modes = ("literal",)

    def __init__(self, api_key: str):
        self.key = api_key
        self.info = ProviderInfo("google_translate", "mt", local=False, license="proprietary-api",
                                 commercial_ok=True, cost_per_hour_usd=0.3, max_concurrency=8)

    def supports(self, src, tgt):
        return src != "pcm" and tgt != "pcm" and L.get(src) is not None and L.get(tgt) is not None

    def translate(self, texts, src, tgt, *, mode="literal", glossary=None, context=None):
        code = {"zh": "zh-CN", "he": "iw", "jw": "jw", "yue": "zh-TW"}.get(tgt, tgt)
        scode = {"zh": "zh-CN", "he": "iw", "yue": "zh-TW"}.get(src, src)
        r = http.request("POST", "https://translation.googleapis.com/language/translate/v2",
                         params={"key": self.key},
                         json={"q": texts, "target": code, "source": scode, "format": "text"},
                         timeout=10).raise_for_status("google")
        import html

        return [MTResult(html.unescape(t["translatedText"]), self.info.name)
                for t in r.json()["data"]["translations"]]
