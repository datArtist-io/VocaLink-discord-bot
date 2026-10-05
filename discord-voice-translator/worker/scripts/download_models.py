#!/usr/bin/env python3
"""Download every model the worker needs for its hardware tier (idempotent).

    python scripts/download_models.py [--tier auto|cpu|gpu8|gpu24] [--voices en,fr,es,sw]
                                      [--with-mms] [--with-clone] [--convert]

--convert re-creates the NLLB CTranslate2 model from the official
facebook/* weights (needs `pip install transformers torch`) instead of using
the community pre-converted repo.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from translator_worker import config as C  # noqa: E402
from translator_worker import hardware as H  # noqa: E402
from translator_worker import languages as L  # noqa: E402

SILERO_URL = "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx"
PIPER_VOICES_JSON = "https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json"


def du(p: Path) -> str:
    total = sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.exists() else 0
    return f"{total / 1e9:.2f} GB"


def step(name: str):
    print(f"\n=== {name}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="auto")
    ap.add_argument("--voices", default=os.environ.get("PRELOAD_TTS_LANGS", "en,fr,es,de,pt,ar,zh,sw"))
    ap.add_argument("--with-mms", action="store_true", help="MMS-TTS voices for yo/ha/ig (+ MMS ASR if igbo_asr)")
    ap.add_argument("--with-clone", action="store_true", help="Chatterbox multilingual (GPU)")
    ap.add_argument("--convert", action="store_true")
    args = ap.parse_args()

    cfg = C.load(os.environ.get("WORKER_CONFIG"))
    hw = H.probe(args.tier if args.tier != "auto" else cfg.hardware.tier, cfg.hardware.device)
    plan = H.plan(hw, cfg)
    models = Path(cfg.paths.models)
    models.mkdir(parents=True, exist_ok=True)
    print(json.dumps(H.describe(hw, plan), indent=2))
    failures: list[str] = []

    step("Silero VAD")
    sil = models / "silero" / "silero_vad.onnx"
    if not sil.exists():
        sil.parent.mkdir(parents=True, exist_ok=True)
        try:
            urllib.request.urlretrieve(SILERO_URL, sil)
        except Exception as e:  # noqa: BLE001
            failures.append(f"silero: {e}")
    print(sil, sil.exists())

    step(f"Whisper ({plan.stt_model})")
    try:
        from faster_whisper.utils import download_model  # type: ignore
        # same cache layout WhisperModel(download_root=...) uses at runtime
        p = download_model(plan.stt_model, cache_dir=str(models / "whisper"))
        print(p)
    except Exception as e:  # noqa: BLE001
        failures.append(f"whisper: {e}")

    step(f"Translation ({plan.mt_family}: {plan.mt_model})")
    from huggingface_hub import hf_hub_download, snapshot_download  # type: ignore
    local = models / "mt" / plan.mt_model.replace("/", "__")
    try:
        if args.convert and plan.mt_family == "nllb":
            src = {"JustFrederik/nllb-200-distilled-600M-ct2-int8": "facebook/nllb-200-distilled-600M",
                   "winstxnhdw/nllb-200-distilled-1.3B-ct2-int8": "facebook/nllb-200-distilled-1.3B",
                   "Napron/nllb-200-3.3B-ct2-int8": "facebook/nllb-200-3.3B"}.get(plan.mt_model, "facebook/nllb-200-distilled-600M")
            subprocess.run(["ct2-transformers-converter", "--model", src, "--output_dir", str(local),
                            "--quantization", "int8", "--copy_files", "sentencepiece.bpe.model", "--force"], check=True)
        elif not (local / "model.bin").exists():
            snapshot_download(repo_id=plan.mt_model, local_dir=str(local))
        for name in ("sentencepiece.bpe.model", "spiece.model"):
            if (local / name).exists():
                break
        else:
            hf_hub_download(plan.mt_tokenizer_repo, "sentencepiece.bpe.model" if plan.mt_family == "nllb" else "spiece.model",
                            local_dir=str(local))
        print(local, du(local))
    except Exception as e:  # noqa: BLE001
        failures.append(f"mt: {e}")

    step("Piper voices")
    piper = models / "piper"
    piper.mkdir(parents=True, exist_ok=True)
    try:
        urllib.request.urlretrieve(PIPER_VOICES_JSON, piper / "voices.json")
        catalog = json.loads((piper / "voices.json").read_text())
    except Exception as e:  # noqa: BLE001
        catalog = {}
        failures.append(f"piper voices.json: {e}")
    for lang in [x.strip() for x in args.voices.split(",") if x.strip()]:
        key = (cfg.tts.voices or {}).get(lang) or L.PIPER_PREFERRED.get(lang)
        if not key or (catalog and key not in catalog):
            cands = sorted((k for k, v in catalog.items() if v.get("language", {}).get("family") == lang),
                           key=lambda k: {"medium": 0, "high": 1, "low": 2, "x_low": 3}.get(k.rsplit("-", 1)[-1], 9))
            key = cands[0] if cands else None
        if not key:
            print(f"  {lang}: no Piper voice exists")
            continue
        if (piper / f"{key}.onnx").exists():
            print(f"  {lang}: {key} (present)")
            continue
        r = subprocess.run([sys.executable, "-m", "piper.download_voices", "--data-dir", str(piper), key])
        print(f"  {lang}: {key} {'ok' if r.returncode == 0 else 'FAILED'}")
        if r.returncode:
            failures.append(f"piper {key}")

    if args.with_mms and not cfg.policy.commercial:
        step("MMS-TTS (CC-BY-NC) for languages without Piper voices")
        for lang in ("yo", "ha", "ig"):
            repo = f"facebook/mms-tts-{L.get(lang).mms_iso3}"
            try:
                snapshot_download(repo_id=repo, cache_dir=str(models / "hf"))
                print(f"  {repo} ok")
            except Exception as e:  # noqa: BLE001
                failures.append(f"{repo}: {e}")
        if cfg.stt.igbo_asr:
            try:
                snapshot_download(repo_id="facebook/mms-1b-all", cache_dir=str(models / "hf"))
            except Exception as e:  # noqa: BLE001
                failures.append(f"mms-1b-all: {e}")

    if args.with_clone and plan.clone_enabled:
        step("Chatterbox multilingual (voice cloning)")
        try:
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # type: ignore
            ChatterboxMultilingualTTS.from_pretrained(device=hw.device)
            print("  ok")
        except Exception as e:  # noqa: BLE001
            failures.append(f"chatterbox: {e}")

    step("Summary")
    print(f"models dir {models}: {du(models)}")
    if failures:
        print("FAILED:\n  " + "\n  ".join(failures))
        return 1
    print("All requested models are present.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
