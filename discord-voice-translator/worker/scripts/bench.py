#!/usr/bin/env python3
"""Phase 0/1 benchmark: real latency + accuracy on YOUR hardware and clips.

    # real speech (recommended): clips/<lang>/<name>.wav  [+ <name>.txt reference transcript]
    python scripts/bench.py --clips clips --targets en,fr

    # no clips yet: round-trip sanity check (TTS -> STT), NOT an accuracy measure
    python scripts/bench.py --synthetic --langs en,fr,es,sw --targets en,fr

    # load: N speakers finishing utterances at the same moment
    python scripts/bench.py --clips clips --concurrency 4

Writes bench-results/<timestamp>.json and .md with per-language LID accuracy,
WER/CER, and p50/p90 per stage, plus an "estimated end-of-speech -> first
dub audio" figure = configured endpoint silence + STT + MT + TTS first chunk.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import time
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from translator_worker import config as C  # noqa: E402
from translator_worker import languages as L  # noqa: E402
from translator_worker.app import WorkerApp  # noqa: E402
from translator_worker.audio import resample  # noqa: E402
from translator_worker.pipeline import CancelToken  # noqa: E402

SYNTH_TEXT = {
    "en": "Good morning everyone, the meeting will start in five minutes.",
    "fr": "Bonjour à tous, la réunion commence dans cinq minutes.",
    "es": "Buenos días a todos, la reunión empieza en cinco minutos.",
    "de": "Guten Morgen zusammen, das Meeting beginnt in fünf Minuten.",
    "pt": "Bom dia a todos, a reunião começa em cinco minutos.",
    "sw": "Habari za asubuhi nyote, mkutano utaanza baada ya dakika tano.",
    "yo": "Ẹ kú àárọ̀ gbogbo yín, ìpàdé náà yóò bẹ̀rẹ̀ ní ìṣẹ́jú márùn-ún.",
    "ha": "Barka da safiya kowa, taron zai fara nan da minti biyar.",
    "ar": "صباح الخير جميعا، سيبدأ الاجتماع بعد خمس دقائق.",
    "zh": "大家早上好，会议将在五分钟后开始。",
}


def load_wav(p: Path) -> np.ndarray:
    with wave.open(str(p), "rb") as w:
        sr, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if sw != 2:
        raise ValueError(f"{p}: need 16-bit PCM WAV")
    a = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    return resample(a, sr, 16000)


def edit_distance(a: list, b: list) -> int:
    d = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        prev, d[0] = d[0], i
        for j, y in enumerate(b, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (x != y))
    return d[len(b)]


def wer(ref: str, hyp: str, lang: str) -> float:
    from translator_worker.textutil import NO_SPACE, normalize_text
    if lang in NO_SPACE:
        r, h = list(normalize_text(ref).replace(" ", "")), list(normalize_text(hyp).replace(" ", ""))
    else:
        r, h = normalize_text(ref).split(), normalize_text(hyp).split()
    return edit_distance(r, h) / max(1, len(r))


def pct(xs, p):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    k = (len(xs) - 1) * p
    f = int(k)
    c = min(f + 1, len(xs) - 1)
    return round(xs[f] + (xs[c] - xs[f]) * (k - f), 1)


async def synth_clip(app: WorkerApp, text: str, lang: str) -> np.ndarray | None:
    if not app.pipeline.tts_available(lang):
        return None
    chunks = []
    async for pcm in app.pipeline.synth(text, lang, voice=None, prosody=None, token=CancelToken(), info={}):
        chunks.append(np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0)
    return resample(np.concatenate(chunks), 48000, 16000) if chunks else None


async def run_one(app: WorkerApp, audio: np.ndarray, lang: str, ref: str | None, targets: list[str]) -> dict:
    p = app.pipeline
    row: dict = {"lang": lang, "duration_s": round(audio.size / 16000, 2)}
    t = time.perf_counter()
    try:
        probs = await p.detect_language(audio)
        top = max(probs, key=probs.get)
        row.update(lid=top, lid_prob=round(probs[top], 3), lid_ok=(top == lang or (lang == "pcm" and top == "en")),
                   lid_ms=round((time.perf_counter() - t) * 1000, 1))
    except Exception as e:  # noqa: BLE001
        row.update(lid=None, lid_error=str(e)[:120])
    stt_lang = "en" if lang == "pcm" else lang
    t = time.perf_counter()
    try:
        res = await p.stt(audio, stt_lang if stt_lang in L.WHISPER_CODES or stt_lang == "ig" else None, final=True)
        row.update(stt_ms=round((time.perf_counter() - t) * 1000, 1), text=res.text, stt_provider=res.provider,
                   avg_logprob=round(res.avg_logprob, 3))
        if ref:
            row["wer"] = round(wer(ref, res.text, lang), 3)
    except Exception as e:  # noqa: BLE001
        row.update(stt_error=str(e)[:160])
        return row
    row["mt"], row["tts"] = {}, {}
    for tgt in targets:
        if tgt == lang:
            continue
        t = time.perf_counter()
        try:
            tr = (await p.translate([res.text], lang, tgt))[0]
            row["mt"][tgt] = {"ms": round((time.perf_counter() - t) * 1000, 1), "text": tr.text, "provider": tr.provider}
        except Exception as e:  # noqa: BLE001
            row["mt"][tgt] = {"error": str(e)[:120]}
            continue
        if p.tts_available(tgt):
            t = time.perf_counter()
            first = None
            n = 0
            info: dict = {}
            try:
                async for pcm in p.synth(tr.text, tgt, voice=None, prosody=None, token=CancelToken(), info=info):
                    if first is None:
                        first = (time.perf_counter() - t) * 1000
                    n += len(pcm)
                total = (time.perf_counter() - t) * 1000
                audio_s = n / 2 / 48000
                row["tts"][tgt] = {"first_ms": round(first or total, 1), "total_ms": round(total, 1),
                                   "rtf": round(total / 1000 / max(audio_s, 1e-3), 3), "provider": info.get("provider")}
            except Exception as e:  # noqa: BLE001
                row["tts"][tgt] = {"error": str(e)[:120]}
    return row


async def main_async(args) -> int:
    cfg = C.load(args.config)
    app = WorkerApp(cfg)
    print(json.dumps({"tier": app.hw.tier, "device": app.hw.device, "plan": {
        "stt": app.plan.stt_model, "mt": app.plan.mt_model, "clone": app.plan.clone_enabled}}, indent=1))
    for r in app.load_report:
        print(f"  [{r['status']}] {r['stage']}: {r['name']} {r.get('reason', '')}")
    targets = [t.strip() for t in args.targets.split(",") if t.strip()]
    items: list[tuple[str, np.ndarray, str | None, str]] = []
    if args.clips:
        for lang_dir in sorted(Path(args.clips).iterdir()):
            if not lang_dir.is_dir():
                continue
            lang = L.normalize(lang_dir.name)
            for wav in sorted(lang_dir.glob("*.wav")):
                ref = wav.with_suffix(".txt").read_text().strip() if wav.with_suffix(".txt").exists() else None
                items.append((lang, load_wav(wav), ref, wav.name))
    if args.synthetic:
        for lang in [x.strip() for x in args.langs.split(",") if x.strip()]:
            text = SYNTH_TEXT.get(lang)
            if not text:
                continue
            a = await synth_clip(app, text, lang)
            if a is None:
                print(f"  (no voice to synthesise {lang}; skipped)")
                continue
            items.append((lang, a, text, f"synthetic-{lang}"))
    if not items:
        print("No clips. Use --clips DIR or --synthetic.")
        return 2

    # warm-up (first call loads kernels)
    await run_one(app, items[0][1], items[0][0], None, targets[:1])

    rows = []
    conc = max(1, args.concurrency)
    for i in range(0, len(items), conc):
        batch = items[i:i + conc]
        res = await asyncio.gather(*(run_one(app, a, lang, ref, targets) for lang, a, ref, _ in batch))
        for (lang, _, _, name), r in zip(batch, res):
            r["clip"] = name
            rows.append(r)
            print(f"  {name:28} {lang:4} lid={r.get('lid')} stt={r.get('stt_ms')}ms wer={r.get('wer')} "
                  f"mt={[v.get('ms') for v in r.get('mt', {}).values()]} tts1st={[v.get('first_ms') for v in r.get('tts', {}).values()]}")

    endpoint = cfg.pipeline.endpoint_ms
    by_lang: dict[str, dict] = {}
    for lang in sorted({r["lang"] for r in rows}):
        rs = [r for r in rows if r["lang"] == lang]
        mts = [v["ms"] for r in rs for v in r.get("mt", {}).values() if "ms" in v]
        tts1 = [v["first_ms"] for r in rs for v in r.get("tts", {}).values() if "first_ms" in v]
        stts = [r.get("stt_ms") for r in rs]
        e2e = [endpoint + (r.get("stt_ms") or 0) + min([v["ms"] for v in r.get("mt", {}).values() if "ms" in v] or [0])
               + min([v["first_ms"] for v in r.get("tts", {}).values() if "first_ms" in v] or [0]) for r in rs]
        wers = [r["wer"] for r in rs if "wer" in r]
        by_lang[lang] = {
            "n": len(rs), "lid_acc": round(sum(1 for r in rs if r.get("lid_ok")) / len(rs), 2),
            "wer_mean": round(statistics.mean(wers), 3) if wers else None,
            "stt_ms_p50": pct(stts, .5), "stt_ms_p90": pct(stts, .9), "mt_ms_p50": pct(mts, .5),
            "tts_first_ms_p50": pct(tts1, .5), "est_end_to_first_audio_ms_p50": pct(e2e, .5),
            "est_end_to_first_audio_ms_p90": pct(e2e, .9),
        }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    result = {"hardware": app.describe()["hardware"], "concurrency": conc, "endpoint_ms": endpoint, "by_lang": by_lang,
              "rows": rows, "synthetic": bool(args.synthetic and not args.clips)}
    (out / f"{stamp}.json").write_text(json.dumps(result, indent=1, ensure_ascii=False))
    md = [f"# Benchmark {stamp} — tier {app.hw.tier} ({app.hw.gpu_name or app.hw.arch}), concurrency {conc}", "",
          "| lang | n | LID acc | WER | STT p50/p90 ms | MT p50 ms | TTS first p50 ms | est. speech-end→first audio p50/p90 ms |",
          "|---|---|---|---|---|---|---|---|"]
    for lang, s in by_lang.items():
        md.append(f"| {lang} | {s['n']} | {s['lid_acc']} | {s['wer_mean']} | {s['stt_ms_p50']}/{s['stt_ms_p90']} | "
                  f"{s['mt_ms_p50']} | {s['tts_first_ms_p50']} | {s['est_end_to_first_audio_ms_p50']}/{s['est_end_to_first_audio_ms_p90']} |")
    if result["synthetic"]:
        md += ["", "_Synthetic round-trip (TTS→STT): measures latency and a sanity floor, NOT real-world accuracy._"]
    (out / f"{stamp}.md").write_text("\n".join(md) + "\n")
    print("\n".join(md))
    print(f"\nSaved {out / (stamp + '.json')}")
    app.pipeline.shutdown()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.environ.get("WORKER_CONFIG"))
    ap.add_argument("--clips")
    ap.add_argument("--synthetic", action="store_true")
    ap.add_argument("--langs", default="en,fr,es,sw,yo,ha")
    ap.add_argument("--targets", default="en,fr")
    ap.add_argument("--concurrency", type=int, default=1)
    ap.add_argument("--out", default="bench-results")
    return asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
