"""Hardware probe and automatic model selection.

Tiers
    cpu    no usable NVIDIA GPU
    gpu8   NVIDIA GPU with ~7-19 GB VRAM (T4, L4, A10G 24GB counts as gpu24)
    gpu24  NVIDIA GPU with >= 20 GB VRAM

Apple Silicon (Metal) is reported as CPU: CTranslate2 / faster-whisper have no
Metal backend.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
from dataclasses import asdict, dataclass, field


@dataclass
class HardwareInfo:
    tier: str
    device: str                     # cpu | cuda
    gpu_name: str = ""
    vram_gb: float = 0.0
    cpu_cores: int = 1
    ram_gb: float = 0.0
    arch: str = ""
    source: str = "probe"           # probe | override


@dataclass
class ModelPlan:
    stt_model: str
    stt_compute: str
    mt_family: str                  # nllb | madlad
    mt_model: str                   # HF repo of a CTranslate2 conversion (or local path)
    mt_tokenizer_repo: str
    mt_compute: str
    clone_enabled: bool
    partials: bool
    partial_interval_ms: int
    incremental_dub: bool
    max_active_speakers: int
    llm_default_model: str
    stt_workers: int
    expected_latency: dict = field(default_factory=dict)


# Pre-converted CTranslate2 checkpoints. They are community conversions of the
# official weights; scripts/download_models.py can re-convert from the
# official repos instead (`--convert`) if any of these disappears.
NLLB_CT2 = {
    "600M": "JustFrederik/nllb-200-distilled-600M-ct2-int8",
    "1.3B": "winstxnhdw/nllb-200-distilled-1.3B-ct2-int8",
    "3.3B": "Napron/nllb-200-3.3B-ct2-int8",
}
NLLB_TOKENIZER = "facebook/nllb-200-distilled-600M"
MADLAD_CT2 = {
    "3B": "Nextcloud-AI/madlad400-3b-mt-ct2-int8",   # Apache-2.0, ships spiece.model
}
MADLAD_TOKENIZER = "Nextcloud-AI/madlad400-3b-mt-ct2-int8"

# Expected end-of-speech -> first translated audio, house voice (ms). These are
# ESTIMATES until scripts/bench.py runs on the target machine.
EXPECTED_MS = {
    "cpu":   {"vad_endpoint": (300, 500), "stt_final": (500, 1200), "mt": (250, 600),
              "tts_first_audio": (100, 250), "playout": (80, 120), "total_house": (1300, 2600),
              "total_clone": None},
    "gpu8":  {"vad_endpoint": (250, 400), "stt_final": (120, 250), "mt": (60, 150),
              "tts_first_audio": (50, 150), "playout": (80, 120), "total_house": (600, 1050),
              "total_clone": (900, 1500)},
    "gpu24": {"vad_endpoint": (250, 400), "stt_final": (100, 200), "mt": (50, 120),
              "tts_first_audio": (40, 120), "playout": (80, 120), "total_house": (550, 950),
              "total_clone": (800, 1300)},
}


def _nvidia_smi() -> tuple[str, float] | None:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run(
            [exe, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, check=True,
        ).stdout.strip().splitlines()
    except Exception:
        return None
    best: tuple[str, float] | None = None
    for line in out:
        try:
            name, mem = [s.strip() for s in line.split(",")]
            gb = float(mem) / 1024.0
        except ValueError:
            continue
        if best is None or gb > best[1]:
            best = (name, gb)
    return best


def _ram_gb() -> float:
    try:
        import psutil  # type: ignore
        return psutil.virtual_memory().total / 1e9
    except Exception:
        try:
            return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1e9
        except Exception:
            return 0.0


def tier_for_vram(vram_gb: float) -> str:
    if vram_gb >= 20:
        return "gpu24"
    if vram_gb >= 7:
        return "gpu8"
    return "cpu"


def probe(override_tier: str = "auto", override_device: str = "auto") -> HardwareInfo:
    cores = os.cpu_count() or 1
    try:
        cores = len(os.sched_getaffinity(0))  # respects container CPU limits
    except Exception:
        pass
    info = HardwareInfo(tier="cpu", device="cpu", cpu_cores=cores, ram_gb=round(_ram_gb(), 1),
                        arch=f"{platform.system()}-{platform.machine()}")
    gpu = None if override_device == "cpu" else _nvidia_smi()
    if gpu is None and override_device != "cpu":
        try:
            import ctranslate2  # type: ignore
            if ctranslate2.get_cuda_device_count() > 0:
                gpu = ("cuda-device", 8.0)  # VRAM unknown; assume the smaller tier
        except Exception:
            pass
    if gpu:
        info.gpu_name, info.vram_gb = gpu[0], round(gpu[1], 1)
        info.device = "cuda"
        info.tier = tier_for_vram(info.vram_gb)
    if override_tier != "auto":
        info.tier = override_tier
        info.device = "cpu" if override_tier == "cpu" else "cuda"
        info.source = "override"
    if override_device in ("cpu", "cuda"):
        info.device = override_device
    return info


def plan(hw: HardwareInfo, cfg) -> ModelPlan:
    """Pick model sizes/quantisation for the tier, honouring config overrides."""
    t = hw.tier
    if t == "gpu24":
        p = ModelPlan(stt_model="large-v3", stt_compute="float16",
                      mt_family="nllb", mt_model=NLLB_CT2["3.3B"], mt_tokenizer_repo=NLLB_TOKENIZER,
                      mt_compute="int8_float16", clone_enabled=True, partials=True,
                      partial_interval_ms=450, incremental_dub=True, max_active_speakers=10,
                      llm_default_model="qwen2.5:14b-instruct-q4_K_M", stt_workers=3)
    elif t == "gpu8":
        p = ModelPlan(stt_model="large-v3-turbo", stt_compute="int8_float16",
                      mt_family="nllb", mt_model=NLLB_CT2["1.3B"], mt_tokenizer_repo=NLLB_TOKENIZER,
                      mt_compute="int8_float16", clone_enabled=True, partials=True,
                      partial_interval_ms=550, incremental_dub=True, max_active_speakers=5,
                      llm_default_model="llama3.1:8b-instruct-q4_K_M", stt_workers=2)
    else:
        size = "medium" if hw.cpu_cores >= 8 and hw.ram_gb >= 12 else "small"
        p = ModelPlan(stt_model=size, stt_compute="int8",
                      mt_family="nllb", mt_model=NLLB_CT2["600M"], mt_tokenizer_repo=NLLB_TOKENIZER,
                      mt_compute="int8", clone_enabled=False, partials=hw.cpu_cores >= 8,
                      partial_interval_ms=1200, incremental_dub=False,
                      max_active_speakers=2 if hw.cpu_cores < 8 else 3,
                      llm_default_model="", stt_workers=1)

    # Commercial use: NLLB-200 is CC-BY-NC -> switch MT to MADLAD-400 (Apache-2.0).
    if cfg.policy.commercial:
        p.mt_family, p.mt_model, p.mt_tokenizer_repo = "madlad", MADLAD_CT2["3B"], MADLAD_TOKENIZER

    # explicit overrides
    if cfg.stt.model != "auto":
        p.stt_model = cfg.stt.model
    if cfg.stt.compute_type != "auto":
        p.stt_compute = cfg.stt.compute_type
    if cfg.mt.provider in ("nllb", "madlad"):
        if cfg.mt.provider != p.mt_family:
            p.mt_family = cfg.mt.provider
            p.mt_model = NLLB_CT2["600M"] if p.mt_family == "nllb" else MADLAD_CT2["3B"]
            p.mt_tokenizer_repo = NLLB_TOKENIZER if p.mt_family == "nllb" else MADLAD_TOKENIZER
    if cfg.mt.model != "auto":
        p.mt_model = cfg.mt.model
    if cfg.mt.tokenizer != "auto":
        p.mt_tokenizer_repo = cfg.mt.tokenizer
    if cfg.mt.compute_type != "auto":
        p.mt_compute = cfg.mt.compute_type
    if cfg.clone.enabled == "on":
        p.clone_enabled = True
    elif cfg.clone.enabled == "off":
        p.clone_enabled = False
    if cfg.pipeline.partials != "auto":
        p.partials = cfg.pipeline.partials == "on"
    if cfg.pipeline.partial_interval_ms:
        p.partial_interval_ms = cfg.pipeline.partial_interval_ms
    if cfg.pipeline.incremental_dub != "auto":
        p.incremental_dub = cfg.pipeline.incremental_dub == "on"
    if not p.partials:
        p.incremental_dub = False  # needs stable partial text
    if cfg.pipeline.max_active_speakers:
        p.max_active_speakers = cfg.pipeline.max_active_speakers
    if hw.device == "cpu" and p.stt_compute in ("float16", "int8_float16"):
        p.stt_compute = "int8"
    if hw.device == "cpu" and p.mt_compute in ("float16", "int8_float16"):
        p.mt_compute = "int8"
    p.expected_latency = EXPECTED_MS.get(t, EXPECTED_MS["cpu"])
    if not p.clone_enabled:
        p.expected_latency = {**p.expected_latency, "total_clone": None}
    return p


def describe(hw: HardwareInfo, p: ModelPlan) -> dict:
    return {"hardware": asdict(hw), "plan": asdict(p)}
