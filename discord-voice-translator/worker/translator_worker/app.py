"""Worker application wiring: config -> hardware -> providers -> router ->
registry -> pipeline -> TCP server (+ a tiny HTTP health endpoint)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import asdict

from . import hardware as H
from . import providers as PB
from . import registry as R
from .config import Config
from .metrics import Metrics
from .pipeline import Pipeline
from .router import Router
from .server import WorkerServer
from .voices import VoiceStore

log = logging.getLogger("worker")


class WorkerApp:
    def __init__(self, cfg: Config, *, providers=None, hw=None, plan=None):
        self.cfg = cfg
        self.hw = hw or H.probe(cfg.hardware.tier, cfg.hardware.device)
        self.plan = plan or H.plan(self.hw, cfg)
        if providers is None:
            providers, self.load_report = PB.build(cfg, self.hw, self.plan)
        else:
            self.load_report = [{"stage": x.info.stage, "name": x.info.name, "status": "injected"}
                                for x in providers.all()]
        self.providers = providers
        self.router = Router(providers, mode=cfg.policy.mode, commercial=cfg.policy.commercial,
                             hybrid_langs=cfg.policy.hybrid_langs)
        whisper_size = self.plan.stt_model
        self.caps = R.build(self.router, whisper_size=whisper_size)
        self.metrics = Metrics()
        self.pipeline = Pipeline(self.router, self.plan, self.metrics, vad=providers.vad,
                                 stt_workers=self.plan.stt_workers,
                                 tts_workers=2 if self.hw.device == "cuda" else 1,
                                 beam_final=cfg.stt.beam_size_final, beam_partial=cfg.stt.beam_size_partial)
        self.voices = VoiceStore(os.path.join(cfg.paths.data, "voices"),
                                 os.environ.get(cfg.clone.profile_key_env, ""))
        self.connections: set = set()
        self.server = WorkerServer(self)
        self.started = time.time()
        self.port = 0
        self._tasks: list[asyncio.Task] = []
        self._health = None

    def describe(self) -> dict:
        return {
            "worker_version": "1.0.0",
            "hardware": asdict(self.hw),
            "plan": {k: v for k, v in asdict(self.plan).items()},
            "policy": {"mode": self.router.mode, "commercial": self.cfg.policy.commercial,
                       "store_audio": self.cfg.policy.store_audio},
            "providers": self.load_report,
            "registry_summary": R.summary(self.caps),
            "languages": {c.code: {"tier": c.tier, "stt": c.stt_grade, "auto": c.auto_detect, "name": c.name,
                                   "reasons": c.reasons} for c in self.caps.values()},
            "voice_cloning": {"enabled": self.voices.enabled and bool(self.providers.clone),
                              "reason": self.voices.reason or ("" if self.providers.clone
                                                               else "no cloning model loaded")},
        }

    async def _metrics_loop(self) -> None:
        while True:
            await asyncio.sleep(10)
            snap = {"type": "metrics", **self.metrics.summary(), "router": self.router.snapshot(),
                    "sessions": sum(len(c.sessions) for c in self.connections)}
            for c in list(self.connections):
                if c.authed:
                    c.emit(snap, droppable=True)

    async def _health_handler(self, reader, writer) -> None:
        try:
            await asyncio.wait_for(reader.readline(), 2)
            body = json.dumps({"ok": True, "uptime_s": round(time.time() - self.started, 1),
                               "edges": len(self.connections), "tier": self.hw.tier,
                               **self.metrics.summary()}).encode()
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                         + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)
            await writer.drain()
        except Exception:  # noqa: BLE001
            pass
        finally:
            writer.close()

    async def start(self, host: str | None = None, port: int | None = None, health_port: int | None = None) -> int:
        self.port = await self.server.start(host or self.cfg.server.host,
                                            self.cfg.server.port if port is None else port)
        self._tasks.append(asyncio.create_task(self._metrics_loop()))
        hp = int(os.environ.get("WORKER_HEALTH_PORT", "7701")) if health_port is None else health_port
        if hp:
            self._health = await asyncio.start_server(self._health_handler, host or self.cfg.server.host, hp)
        if not self.cfg.server.auth_token and (host or self.cfg.server.host) not in ("127.0.0.1", "localhost", "::1"):
            log.warning("WORKER_TOKEN is empty: any host that can reach port %s can use this worker. Set WORKER_TOKEN.",
                        self.port)
        log.info("worker listening on %s:%s (tier=%s, device=%s, mode=%s)", self.cfg.server.host, self.port,
                 self.hw.tier, self.hw.device, self.router.mode)
        return self.port

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        if self._health:
            self._health.close()
        await self.server.stop()
        self.pipeline.shutdown()
