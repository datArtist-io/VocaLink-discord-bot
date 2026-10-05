"""NLLB-200 and MADLAD-400 machine translation on CTranslate2 (no torch).

NLLB-200 weights: CC-BY-NC 4.0 (non-commercial). MADLAD-400: Apache-2.0.
Tokenisation uses the models' SentencePiece files directly, following the
CTranslate2 docs:

    NLLB   source = [src_flores] + pieces + ["</s>"], target_prefix = [[tgt_flores]]
    MADLAD source = pieces("<2xx> " + text) + ["</s>"]
"""

from __future__ import annotations

import logging
import os
import re
import threading
from pathlib import Path

from .. import languages as L
from .base import MTResult, ProviderInfo, ProviderUnavailable

log = logging.getLogger("mt.ct2")

_SENT = re.compile(r"(?<=[.!?。！？])\s+")

# MADLAD target tokens differ from our codes in a few places.
MADLAD_CODE = {"jw": "jv", "he": "iw", "no": "no", "zh": "zh", "yue": "yue", "fa": "fa", "ms": "ms"}
MADLAD_UNSUPPORTED = {"pcm", "la"}  # unverified -> treat as unsupported


def resolve_model_dir(model: str, models_dir: str) -> str:
    """Local directory, or a HF repo id downloaded into models_dir."""
    if os.path.isdir(model):
        return model
    local = Path(models_dir) / "mt" / model.replace("/", "__")
    if (local / "model.bin").exists():
        return str(local)
    try:
        from huggingface_hub import snapshot_download  # type: ignore
    except Exception as e:  # pragma: no cover
        raise ProviderUnavailable(f"model {model} not found locally and huggingface_hub missing: {e}")
    return snapshot_download(repo_id=model, local_dir=str(local))


def find_spm(model_dir: str, tokenizer_repo: str, models_dir: str) -> str:
    for name in ("sentencepiece.bpe.model", "spiece.model", "tokenizer.model", "source.spm"):
        p = Path(model_dir) / name
        if p.exists():
            return str(p)
    try:
        from huggingface_hub import hf_hub_download  # type: ignore
        for name in ("sentencepiece.bpe.model", "spiece.model"):
            try:
                return hf_hub_download(tokenizer_repo, name, cache_dir=str(Path(models_dir) / "hf"))
            except Exception:  # noqa: BLE001
                continue
    except Exception:  # noqa: BLE001
        pass
    raise ProviderUnavailable(f"no SentencePiece model in {model_dir} or {tokenizer_repo}")


class CT2Translator:
    modes = ("literal",)

    def __init__(self, family: str, model: str, tokenizer_repo: str, *, models_dir: str, device: str = "cpu",
                 compute_type: str = "int8", beam_size: int = 2, threads: int = 0):
        import ctranslate2  # type: ignore
        import sentencepiece as spm  # type: ignore

        if family not in ("nllb", "madlad"):
            raise ValueError(family)
        self.family = family
        path = resolve_model_dir(model, models_dir)
        self.tr = ctranslate2.Translator(path, device=device, compute_type=compute_type,
                                         inter_threads=2, intra_threads=threads)
        self.sp = spm.SentencePieceProcessor(model_file=find_spm(path, tokenizer_repo, models_dir))
        self.beam = beam_size
        self._lock = threading.Lock()  # sentencepiece is cheap; CT2 itself is thread-safe
        lic = "CC-BY-NC-4.0" if family == "nllb" else "Apache-2.0"
        self.info = ProviderInfo(f"{family}:{Path(path).name}", "mt", local=True, license=lic,
                                 commercial_ok=family == "madlad", max_concurrency=2)

    # ------------------------------------------------------------------
    def _code(self, lang: str) -> str | None:
        lang = L.normalize(lang)
        if self.family == "nllb":
            l = L.get(lang)
            return l.flores if l else None
        if lang in MADLAD_UNSUPPORTED or not L.get(lang):
            return None
        return MADLAD_CODE.get(lang, lang)

    def supports(self, src: str, tgt: str) -> bool:
        if self.family == "madlad":
            return self._code(tgt) is not None and L.get(src) is not None and src not in MADLAD_UNSUPPORTED
        return self._code(src) is not None and self._code(tgt) is not None

    def translate(self, texts, src, tgt, *, mode="literal", glossary=None, context=None) -> list[MTResult]:
        s_code, t_code = self._code(src), self._code(tgt)
        if t_code is None or (self.family == "nllb" and s_code is None):
            raise ProviderUnavailable(f"{self.family} does not support {src}->{tgt}")
        # split into sentences: both models are trained on sentence pairs
        spans: list[tuple[int, int]] = []
        sents: list[str] = []
        for t in texts:
            parts = [p for p in _SENT.split(t.strip()) if p] or [""]
            spans.append((len(sents), len(sents) + len(parts)))
            sents.extend(parts)
        with self._lock:
            if self.family == "nllb":
                src_tok = [[s_code] + self.sp.encode(s, out_type=str) + ["</s>"] for s in sents]
                prefix = [[t_code]] * len(sents)
            else:
                src_tok = [self.sp.encode(f"<2{t_code}> {s}", out_type=str) + ["</s>"] for s in sents]
                prefix = None
        res = self.tr.translate_batch(src_tok, target_prefix=prefix, beam_size=self.beam,
                                      max_decoding_length=256, repetition_penalty=1.05)
        outs = []
        for r in res:
            toks = r.hypotheses[0]
            if self.family == "nllb" and toks and toks[0] == t_code:
                toks = toks[1:]
            outs.append(self.sp.decode(toks))
        return [MTResult(" ".join(outs[a:b]).strip(), self.info.name, "literal") for a, b in spans]
