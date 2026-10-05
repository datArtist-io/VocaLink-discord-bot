"""Edge <-> worker wire protocol.

Length-prefixed binary frames over a plain TCP stream (no third-party deps,
works the same in Node `net` and Python `asyncio`).

    uint32 BE  N        length of (type byte + payload)
    uint8      type
    bytes      payload  (N - 1 bytes)

Frame types
    0x01 JSON       UTF-8 JSON object with a "type" field
    0x02 AUDIO_IN   uint32 sid | uint32 seq | PCM s16le 16 kHz mono
    0x03 AUDIO_OUT  uint32 dub_id | uint32 seq | PCM s16le 48 kHz mono
    0x04 BLOB       uint32 header_len | JSON header | raw bytes

The edge owns stream ids (sid) and the worker owns dub ids.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from typing import Any

PROTOCOL_VERSION = 1

FRAME_JSON = 0x01
FRAME_AUDIO_IN = 0x02
FRAME_AUDIO_OUT = 0x03
FRAME_BLOB = 0x04

MAX_FRAME = 8 * 1024 * 1024  # 8 MiB hard cap protects both sides

IN_RATE = 16_000   # edge -> worker
OUT_RATE = 48_000  # worker -> edge

_HDR = struct.Struct(">IB")
_U32x2 = struct.Struct(">II")
_U32 = struct.Struct(">I")


class ProtocolError(Exception):
    pass


@dataclass(slots=True)
class Frame:
    kind: int
    payload: bytes

    # ---- typed views -------------------------------------------------
    def json(self) -> dict[str, Any]:
        if self.kind != FRAME_JSON:
            raise ProtocolError("not a JSON frame")
        obj = json.loads(self.payload.decode("utf-8"))
        if not isinstance(obj, dict) or "type" not in obj:
            raise ProtocolError("JSON frame must be an object with a 'type'")
        return obj

    def audio(self) -> tuple[int, int, bytes]:
        if self.kind not in (FRAME_AUDIO_IN, FRAME_AUDIO_OUT):
            raise ProtocolError("not an audio frame")
        if len(self.payload) < 8:
            raise ProtocolError("audio frame too short")
        a, b = _U32x2.unpack_from(self.payload, 0)
        return a, b, self.payload[8:]

    def blob(self) -> tuple[dict[str, Any], bytes]:
        if self.kind != FRAME_BLOB:
            raise ProtocolError("not a blob frame")
        (hlen,) = _U32.unpack_from(self.payload, 0)
        header = json.loads(self.payload[4 : 4 + hlen].decode("utf-8"))
        return header, self.payload[4 + hlen :]


def _frame(kind: int, payload: bytes) -> bytes:
    n = len(payload) + 1
    if n > MAX_FRAME:
        raise ProtocolError(f"frame too large: {n}")
    return _HDR.pack(n, kind) + payload


def encode_json(obj: dict[str, Any]) -> bytes:
    return _frame(FRAME_JSON, json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def encode_audio_in(sid: int, seq: int, pcm: bytes) -> bytes:
    return _frame(FRAME_AUDIO_IN, _U32x2.pack(sid & 0xFFFFFFFF, seq & 0xFFFFFFFF) + pcm)


def encode_audio_out(dub_id: int, seq: int, pcm: bytes) -> bytes:
    return _frame(FRAME_AUDIO_OUT, _U32x2.pack(dub_id & 0xFFFFFFFF, seq & 0xFFFFFFFF) + pcm)


def encode_blob(header: dict[str, Any], data: bytes) -> bytes:
    h = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return _frame(FRAME_BLOB, _U32.pack(len(h)) + h + data)


class FrameDecoder:
    """Incremental decoder; feed arbitrary byte chunks, get whole frames."""

    __slots__ = ("_buf",)

    def __init__(self) -> None:
        self._buf = bytearray()

    def feed(self, data: bytes) -> list[Frame]:
        self._buf += data
        out: list[Frame] = []
        while True:
            if len(self._buf) < 5:
                break
            n, kind = _HDR.unpack_from(self._buf, 0)
            if n < 1 or n > MAX_FRAME:
                raise ProtocolError(f"bad frame length {n}")
            if len(self._buf) < 4 + n:
                break
            payload = bytes(self._buf[5 : 4 + n])
            del self._buf[: 4 + n]
            out.append(Frame(kind, payload))
        return out


async def read_frame(reader) -> Frame | None:
    """Read exactly one frame from an asyncio.StreamReader (None on EOF)."""
    try:
        hdr = await reader.readexactly(5)
    except Exception:  # IncompleteReadError / connection reset
        return None
    n, kind = _HDR.unpack(hdr)
    if n < 1 or n > MAX_FRAME:
        raise ProtocolError(f"bad frame length {n}")
    payload = await reader.readexactly(n - 1) if n > 1 else b""
    return Frame(kind, payload)
