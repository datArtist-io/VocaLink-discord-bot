"""Test helpers: an in-process worker with fake models and a simulated edge."""

from __future__ import annotations

import asyncio
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from translator_worker import config as C  # noqa: E402
from translator_worker import hardware as H  # noqa: E402
from translator_worker import protocol as P  # noqa: E402
from translator_worker.audio import f32_to_pcm16  # noqa: E402
from translator_worker.providers.fake import modem_encode  # noqa: E402


def make_cfg(**pipeline) -> C.Config:
    cfg = C.load(None, env={"FAKE_MODELS": "1", "WORKER_TOKEN": "t0k", "DATA_DIR": "/tmp/dvt-test-data"})
    for k, v in pipeline.items():
        setattr(cfg.pipeline, k, v)
    return cfg


def make_plan(cfg, *, partials=True, incremental=False, clone=False, tier="gpu8"):
    hw = H.HardwareInfo(tier=tier, device="cpu", cpu_cores=8, ram_gb=16)
    plan = H.plan(hw, cfg)
    plan.partials = partials
    plan.partial_interval_ms = 150
    plan.incremental_dub = incremental
    plan.clone_enabled = clone
    plan.stt_workers = 2
    return hw, plan


def speech(text: str, lang: str = "en", lead_s: float = 0.3, tail_s: float = 0.9) -> np.ndarray:
    a = modem_encode(text, 16000, lang=lang)
    return np.concatenate([np.zeros(int(lead_s * 16000), np.float32), a, np.zeros(int(tail_s * 16000), np.float32)])


class EdgeSim:
    def __init__(self, port: int, token: str = "t0k"):
        self.port = port
        self.token = token
        self.events: list[dict] = []
        self.audio: dict[int, list[bytes]] = {}
        self._reader = None
        self._writer = None
        self._task = None
        self._cond = asyncio.Condition()

    async def connect(self, hello: bool = True):
        self._reader, self._writer = await asyncio.open_connection("127.0.0.1", self.port)
        self._task = asyncio.create_task(self._read())
        if hello:
            self.send({"type": "hello", "protocol": P.PROTOCOL_VERSION, "token": self.token, "edge_id": "test"})
            await self.wait_for(lambda e: e["type"] in ("hello_ack", "hello_error"), 5)

    def send(self, obj: dict):
        self._writer.write(P.encode_json(obj))

    def send_audio(self, sid: int, seq: int, pcm: bytes):
        self._writer.write(P.encode_audio_in(sid, seq, pcm))

    async def stream(self, sid: int, audio: np.ndarray, *, speed: float = 20.0, seq0: int = 0, skip: set | None = None):
        frame = 320
        seq = seq0
        for i in range(0, audio.size - frame + 1, frame):
            if not skip or seq not in skip:
                self.send_audio(sid, seq, f32_to_pcm16(audio[i:i + frame]))
            seq += 1
            if seq % 5 == 0:
                await self._writer.drain()
                await asyncio.sleep(0.02 * 5 / speed)
        await self._writer.drain()
        return seq

    async def _read(self):
        try:
            while True:
                f = await P.read_frame(self._reader)
                if f is None:
                    break
                async with self._cond:
                    if f.kind == P.FRAME_JSON:
                        self.events.append(f.json())
                    elif f.kind == P.FRAME_AUDIO_OUT:
                        d, s, pcm = f.audio()
                        self.audio.setdefault(d, []).append(pcm)
                    self._cond.notify_all()
        except Exception:
            pass

    async def wait_for(self, pred, timeout=10.0):
        async def _w():
            async with self._cond:
                while True:
                    for e in self.events:
                        if pred(e):
                            return e
                    await self._cond.wait()
        return await asyncio.wait_for(_w(), timeout)

    def of(self, typ: str) -> list[dict]:
        return [e for e in self.events if e["type"] == typ]

    async def close(self):
        if self._writer:
            self._writer.close()
        if self._task:
            self._task.cancel()
