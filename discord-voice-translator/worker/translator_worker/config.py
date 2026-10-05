"""Worker configuration: defaults <- config.yaml <- environment variables.

Every cloud key is optional. A missing key simply means that provider is not
registered; the local pipeline always runs.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field, fields, is_dataclass
from pathlib import Path
from typing import Any

try:  # PyYAML is a core dependency, but keep config importable without it
    import yaml  # type: ignore
except Exception:  # pragma: no cover
    yaml = None


@dataclass
class ServerCfg:
    host: str = "0.0.0.0"
    port: int = 7700
    auth_token: str = ""          # shared secret the edge must present in hello
    max_edges: int = 16


@dataclass
class HardwareCfg:
    tier: str = "auto"            # auto | cpu | gpu8 | gpu24
    device: str = "auto"          # auto | cpu | cuda
    cpu_threads: int = 0          # 0 = let the runtime decide


@dataclass
class PolicyCfg:
    mode: str = "auto"            # auto | local | hybrid | cloud  (auto = hybrid if any cloud key is set, else local)
    commercial: bool = False      # True refuses non-commercial-licensed models
    store_audio: bool = False     # never write call audio to disk unless True
    hybrid_langs: list[str] = field(default_factory=lambda: ["ig", "yo", "ha", "pcm"])
    max_cloud_usd_per_hour: float = 2.0


@dataclass
class PipelineCfg:
    partials: str = "auto"              # auto | on | off
    partial_interval_ms: int = 0        # 0 = per tier
    incremental_dub: str = "auto"       # auto | on | off (dub first stable clause before the speaker finishes)
    endpoint_ms: int = 500              # silence that ends an utterance
    endpoint_fast_ms: int = 250         # ...after clause-final punctuation
    min_speech_ms: int = 250
    max_utterance_s: float = 12.0
    pre_roll_ms: int = 200
    vad_threshold: float = 0.5
    vad_neg_threshold: float = 0.35
    long_utterance_s: float = 6.0       # split & re-detect language beyond this
    lid_recheck_every: int = 3          # re-verify a locked language every N utterances
    low_confidence_logprob: float = -0.9
    max_active_speakers: int = 0        # 0 = per tier
    transcript_max_lines: int = 2000    # in-RAM transcript for summaries
    stale_dub_s: float = 4.0            # drop a dub (keep captions) if TTS would start later than this


@dataclass
class STTCfg:
    provider: str = "faster_whisper"
    model: str = "auto"                 # auto | tiny | small | medium | large-v3 | large-v3-turbo | path
    compute_type: str = "auto"
    beam_size_final: int = 5
    beam_size_partial: int = 1
    igbo_asr: bool = False              # MMS-1b-all adapter (CC-BY-NC, needs torch)


@dataclass
class MTCfg:
    provider: str = "auto"              # auto | nllb | madlad
    model: str = "auto"                 # CT2 directory or HF repo id
    tokenizer: str = "auto"
    compute_type: str = "auto"
    beam_size: int = 2


@dataclass
class TTSCfg:
    provider: str = "piper"
    voices: dict[str, str] = field(default_factory=dict)   # lang -> piper voice key
    mms_tts: bool = True                # MMS-TTS for languages Piper lacks (CC-BY-NC)
    speed_match: bool = True            # map speaker pace/energy to TTS params


@dataclass
class CloneCfg:
    provider: str = "chatterbox"
    enabled: str = "auto"               # auto (GPU tiers only) | on | off
    profile_key_env: str = "VOICE_PROFILE_KEY"
    min_enroll_s: float = 4.0
    phrase_similarity: float = 0.55


@dataclass
class LLMCfg:
    enabled: str = "auto"               # auto | on | off
    base_url: str = ""                  # OpenAI-compatible, e.g. http://ollama:11434/v1
    model: str = ""
    api_key: str = ""
    timeout_s: float = 20.0


@dataclass
class CloudCfg:
    deepgram_api_key: str = ""
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    groq_api_key: str = ""
    deepl_api_key: str = ""
    google_translate_api_key: str = ""
    elevenlabs_api_key: str = ""
    elevenlabs_voice_id: str = "21m00Tcm4TlvDq8ikWAM"


@dataclass
class PathsCfg:
    models: str = "/models"
    data: str = "/data"


@dataclass
class Config:
    server: ServerCfg = field(default_factory=ServerCfg)
    hardware: HardwareCfg = field(default_factory=HardwareCfg)
    policy: PolicyCfg = field(default_factory=PolicyCfg)
    pipeline: PipelineCfg = field(default_factory=PipelineCfg)
    stt: STTCfg = field(default_factory=STTCfg)
    mt: MTCfg = field(default_factory=MTCfg)
    tts: TTSCfg = field(default_factory=TTSCfg)
    clone: CloneCfg = field(default_factory=CloneCfg)
    llm: LLMCfg = field(default_factory=LLMCfg)
    cloud: CloudCfg = field(default_factory=CloudCfg)
    paths: PathsCfg = field(default_factory=PathsCfg)
    fake_models: bool = False           # deterministic stand-in models (tests / dry runs)
    log_level: str = "INFO"


# Environment variables that map onto config fields (besides TW__SECTION__KEY).
_ENV_MAP = {
    "WORKER_TOKEN": "server.auth_token",
    "WORKER_PORT": "server.port",
    "HARDWARE_TIER": "hardware.tier",
    "PIPELINE_MODE": "policy.mode",
    "COMMERCIAL": "policy.commercial",
    "DEEPGRAM_API_KEY": "cloud.deepgram_api_key",
    "OPENAI_API_KEY": "cloud.openai_api_key",
    "OPENAI_BASE_URL": "cloud.openai_base_url",
    "GROQ_API_KEY": "cloud.groq_api_key",
    "DEEPL_API_KEY": "cloud.deepl_api_key",
    "GOOGLE_TRANSLATE_API_KEY": "cloud.google_translate_api_key",
    "ELEVENLABS_API_KEY": "cloud.elevenlabs_api_key",
    "ELEVENLABS_VOICE_ID": "cloud.elevenlabs_voice_id",
    "LLM_BASE_URL": "llm.base_url",
    "LLM_MODEL": "llm.model",
    "LLM_API_KEY": "llm.api_key",
    "MODELS_DIR": "paths.models",
    "DATA_DIR": "paths.data",
    "FAKE_MODELS": "fake_models",
    "LOG_LEVEL": "log_level",
}

_VAR = re.compile(r"\$\{([A-Z0-9_]+)(?::-([^}]*))?\}")


def _expand(v: Any) -> Any:
    if isinstance(v, str):
        return _VAR.sub(lambda m: os.environ.get(m.group(1), m.group(2) or ""), v)
    if isinstance(v, list):
        return [_expand(x) for x in v]
    if isinstance(v, dict):
        return {k: _expand(x) for k, x in v.items()}
    return v


def _coerce(current: Any, value: Any) -> Any:
    if isinstance(current, bool):
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in ("1", "true", "yes", "on")
    if isinstance(current, int) and not isinstance(current, bool):
        return int(value)
    if isinstance(current, float):
        return float(value)
    if isinstance(current, list) and isinstance(value, str):
        return [s.strip() for s in value.split(",") if s.strip()]
    return value


def _apply(obj: Any, data: dict[str, Any]) -> None:
    names = {f.name for f in fields(obj)}
    for k, v in data.items():
        if k not in names:
            raise ValueError(f"unknown config key: {type(obj).__name__}.{k}")
        cur = getattr(obj, k)
        if is_dataclass(cur) and isinstance(v, dict):
            _apply(cur, v)
        elif isinstance(cur, dict) and isinstance(v, dict):
            cur.update(v)
        else:
            setattr(obj, k, _coerce(cur, v) if v is not None else cur)


def set_path(cfg: Config, dotted: str, value: Any) -> None:
    parts = dotted.split(".")
    obj: Any = cfg
    for p in parts[:-1]:
        obj = getattr(obj, p)
    cur = getattr(obj, parts[-1])
    setattr(obj, parts[-1], _coerce(cur, value))


def load(path: str | os.PathLike | None = None, env: dict[str, str] | None = None) -> Config:
    env = dict(os.environ if env is None else env)
    cfg = Config()
    p = Path(path) if path else (Path(env["WORKER_CONFIG"]) if env.get("WORKER_CONFIG") else None)
    if p and p.exists():
        if yaml is None:
            raise RuntimeError("PyYAML is required to read config files")
        raw = yaml.safe_load(p.read_text()) or {}
        old = os.environ.copy()
        try:
            os.environ.update(env)
            raw = _expand(raw)
        finally:
            os.environ.clear()
            os.environ.update(old)
        _apply(cfg, raw)
    for var, dotted in _ENV_MAP.items():
        if env.get(var, "") != "":
            set_path(cfg, dotted, env[var])
    # Generic overrides: TW__PIPELINE__ENDPOINT_MS=400
    for var, val in env.items():
        if var.startswith("TW__"):
            set_path(cfg, ".".join(s.lower() for s in var[4:].split("__")), val)
    validate(cfg)
    return cfg


def validate(cfg: Config) -> None:
    if cfg.policy.mode not in ("auto", "local", "hybrid", "cloud"):
        raise ValueError("policy.mode must be auto | local | hybrid | cloud")
    if cfg.hardware.tier not in ("auto", "cpu", "gpu8", "gpu24"):
        raise ValueError("hardware.tier must be auto | cpu | gpu8 | gpu24")
    for name in ("partials", "incremental_dub"):
        if getattr(cfg.pipeline, name) not in ("auto", "on", "off"):
            raise ValueError(f"pipeline.{name} must be auto | on | off")
    if cfg.pipeline.endpoint_fast_ms > cfg.pipeline.endpoint_ms:
        raise ValueError("pipeline.endpoint_fast_ms must be <= endpoint_ms")
