"""Build the provider set from config + hardware plan.

Every provider is optional except one VAD. Anything that fails to load is
logged with the reason and skipped; the capability registry then reflects
exactly what is available.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from .. import languages as L
from ..router import Providers

log = logging.getLogger("providers")


def build(cfg, hw, plan) -> tuple[Providers, list[dict]]:
    report: list[dict] = []

    def ok(stage, name, **kw):
        report.append({"stage": stage, "name": name, "status": "loaded", **kw})

    def skip(stage, name, why):
        report.append({"stage": stage, "name": name, "status": "skipped", "reason": str(why)[:300]})
        log.warning("%s provider %s skipped: %s", stage, name, why)

    if cfg.fake_models:
        from .fake import FakeLLM, FakeLLMMT, FakeMT, FakeSTT, FakeTTS
        from .vad_energy import EnergyVAD
        from .llm import OpenAIChatLLM  # noqa: F401 - import check

        p = Providers(vad=EnergyVAD(), stt=[FakeSTT()], mt=[FakeMT(), FakeLLMMT()], tts=[FakeTTS()],
                      clone=[], llm=[FakeLLM()])
        if plan.clone_enabled:
            from .fake import FakeCloneTTS
            p.clone.append(FakeCloneTTS())
        for x in p.all():
            ok(x.info.stage, x.info.name, fake=True)
        return p, report

    models = cfg.paths.models
    device = hw.device
    p = Providers()

    # ---------------------------------------------------------------- VAD
    try:
        from .vad_silero import SileroVAD, find_model
        path = find_model(models)
        if not path:
            raise FileNotFoundError("silero_vad.onnx not found (run scripts/download_models.py)")
        p.vad = SileroVAD(path)
        ok("vad", "silero_vad", path=str(path))
    except Exception as e:  # noqa: BLE001
        skip("vad", "silero_vad", e)
        from .vad_energy import EnergyVAD
        p.vad = EnergyVAD()
        ok("vad", "energy_vad", warning="Silero unavailable - energy VAD is weaker in noise")

    # ---------------------------------------------------------------- STT
    try:
        from .stt_faster_whisper import FasterWhisperSTT
        stt = FasterWhisperSTT(plan.stt_model, device=device, compute_type=plan.stt_compute,
                               cpu_threads=cfg.hardware.cpu_threads, num_workers=plan.stt_workers,
                               download_root=str(Path(models) / "whisper"),
                               beam_final=cfg.stt.beam_size_final, beam_partial=cfg.stt.beam_size_partial)
        p.stt.append(stt)
        ok("stt", stt.info.name, compute=plan.stt_compute, device=device)
    except Exception as e:  # noqa: BLE001
        skip("stt", f"faster_whisper:{plan.stt_model}", e)
    if cfg.stt.igbo_asr:
        if cfg.policy.commercial:
            skip("stt", "mms_asr", "CC-BY-NC model refused in commercial mode")
        else:
            try:
                from .stt_mms import MMSASR
                m = MMSASR(["ig"], device=device, cache_dir=str(Path(models) / "hf"))
                p.stt.append(m)
                ok("stt", m.info.name, langs=["ig"])
            except Exception as e:  # noqa: BLE001
                skip("stt", "mms_asr", e)
    c = cfg.cloud
    if c.deepgram_api_key:
        from .stt_cloud import DeepgramSTT
        p.stt.append(DeepgramSTT(c.deepgram_api_key))
        ok("stt", "deepgram")
    if c.groq_api_key:
        from .stt_cloud import OpenAICompatSTT
        p.stt.append(OpenAICompatSTT(c.groq_api_key, "https://api.groq.com/openai/v1", "whisper-large-v3", "groq",
                                     cost_per_hour=0.11))
        ok("stt", "groq-whisper")
    if c.openai_api_key:
        from .stt_cloud import OpenAICompatSTT
        p.stt.append(OpenAICompatSTT(c.openai_api_key, c.openai_base_url, "whisper-1", "openai"))
        ok("stt", "openai-whisper")

    # ---------------------------------------------------------------- MT
    try:
        from .mt_ct2 import CT2Translator
        mt = CT2Translator(plan.mt_family, plan.mt_model, plan.mt_tokenizer_repo, models_dir=models,
                           device=device, compute_type=plan.mt_compute, beam_size=cfg.mt.beam_size)
        if cfg.policy.commercial and not mt.info.commercial_ok:
            skip("mt", mt.info.name, "non-commercial licence refused in commercial mode")
        else:
            p.mt.append(mt)
            ok("mt", mt.info.name, license=mt.info.license)
    except Exception as e:  # noqa: BLE001
        skip("mt", f"{plan.mt_family}:{plan.mt_model}", e)
    if c.deepl_api_key:
        from .mt_cloud import DeepLTranslator
        p.mt.append(DeepLTranslator(c.deepl_api_key))
        ok("mt", "deepl")
    if c.google_translate_api_key:
        from .mt_cloud import GoogleTranslator
        p.mt.append(GoogleTranslator(c.google_translate_api_key))
        ok("mt", "google_translate")

    # ---------------------------------------------------------------- LLM
    from .llm import LLMTranslator, OpenAIChatLLM
    llm_cfgs = []
    if cfg.llm.enabled != "off" and cfg.llm.base_url:
        llm_cfgs.append((cfg.llm.base_url, cfg.llm.model or plan.llm_default_model, cfg.llm.api_key, "llm"))
    if cfg.llm.enabled != "off" and c.openai_api_key and not cfg.llm.base_url:
        llm_cfgs.append((c.openai_base_url, "gpt-4o-mini", c.openai_api_key, "openai"))
    for base, model, key, name in llm_cfgs:
        if not model:
            skip("llm", name, "no model configured (set LLM_MODEL)")
            continue
        llm = OpenAIChatLLM(base, model, key, timeout=cfg.llm.timeout_s, name=name)
        p.llm.append(llm)
        p.mt.append(LLMTranslator(llm))
        ok("llm", llm.info.name, local=llm.info.local)

    # ---------------------------------------------------------------- TTS
    piper_dir = str(Path(models) / "piper")
    try:
        from .tts_piper import PiperTTS
        pt = PiperTTS(piper_dir, cfg.tts.voices, use_cuda=False,
                      allow_download=os.environ.get("PIPER_ALLOW_DOWNLOAD", "1") == "1",
                      preload=[x for x in os.environ.get("PRELOAD_TTS_LANGS", "en").split(",") if x])
        p.tts.append(pt)
        ok("tts", "piper", families=sorted(pt.families()))
    except Exception as e:  # noqa: BLE001
        skip("tts", "piper", e)
    if cfg.tts.mms_tts and not cfg.policy.commercial:
        try:
            from .tts_mms import MMSTTS
            piper_fams = p.tts[0].families() if p.tts else set()
            langs = [code for code, l in L.LANGUAGES.items() if l.mms_iso3 and code not in piper_fams]
            m = MMSTTS(langs, device=device, cache_dir=str(Path(models) / "hf"))
            p.tts.append(m)
            ok("tts", "mms_tts", langs=len(langs), license="CC-BY-NC-4.0")
        except Exception as e:  # noqa: BLE001
            skip("tts", "mms_tts", e)
    elif cfg.policy.commercial:
        skip("tts", "mms_tts", "CC-BY-NC model refused in commercial mode")
    if c.elevenlabs_api_key:
        from .tts_cloud import ElevenLabsTTS
        p.tts.append(ElevenLabsTTS(c.elevenlabs_api_key, c.elevenlabs_voice_id))
        ok("tts", "elevenlabs")
    if c.openai_api_key:
        from .tts_cloud import OpenAITTS
        p.tts.append(OpenAITTS(c.openai_api_key, c.openai_base_url))
        ok("tts", "openai_tts")

    # ---------------------------------------------------------------- clone
    if plan.clone_enabled:
        try:
            from .tts_chatterbox import ChatterboxCloneTTS
            cb = ChatterboxCloneTTS(device=device)
            p.clone.append(cb)
            ok("tts", "chatterbox_mtl", license="MIT", langs=sorted(L.CHATTERBOX_LANGS))
        except Exception as e:  # noqa: BLE001
            skip("tts", "chatterbox_mtl", e)
    return p, report
