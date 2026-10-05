"""Minimal sync HTTP client for cloud plug-ins.

Uses httpx (pooled keep-alive connections - saves a TLS handshake per call)
when installed, otherwise falls back to urllib. Providers run in worker
threads, so a sync client is the right shape.
"""

from __future__ import annotations

import json as _json
import uuid
from dataclasses import dataclass
from typing import Iterator

try:
    import httpx  # type: ignore
except Exception:  # pragma: no cover
    httpx = None

_client = None


def _get_client():
    global _client
    if _client is None and httpx is not None:
        _client = httpx.Client(timeout=30.0, http2=False,
                               limits=httpx.Limits(max_keepalive_connections=20, keepalive_expiry=120))
    return _client


@dataclass
class Response:
    status: int
    body: bytes
    headers: dict

    def json(self):
        return _json.loads(self.body.decode("utf-8"))

    def raise_for_status(self, what: str = "") -> "Response":
        if self.status >= 400:
            snippet = self.body[:300].decode("utf-8", "replace")
            raise HTTPError(self.status, f"{what} HTTP {self.status}: {snippet}")
        return self


class HTTPError(RuntimeError):
    def __init__(self, status: int, msg: str):
        super().__init__(msg)
        self.status = status


def request(method: str, url: str, *, headers: dict | None = None, json=None, data: bytes | None = None,
            params: dict | None = None, timeout: float = 30.0) -> Response:
    headers = dict(headers or {})
    if json is not None:
        data = _json.dumps(json).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")
    client = _get_client()
    if client is not None:
        r = client.request(method, url, headers=headers, content=data, params=params, timeout=timeout)
        return Response(r.status_code, r.content, dict(r.headers))
    import urllib.error
    import urllib.parse
    import urllib.request

    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return Response(resp.status, resp.read(), dict(resp.headers))
    except urllib.error.HTTPError as e:
        return Response(e.code, e.read() or b"", dict(e.headers or {}))


def stream(method: str, url: str, *, headers: dict | None = None, json=None, timeout: float = 30.0,
           chunk: int = 4800) -> Iterator[bytes]:
    """Yield response body chunks as they arrive (raises HTTPError on >= 400)."""
    headers = dict(headers or {})
    data = None
    if json is not None:
        data = _json.dumps(json).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")
    client = _get_client()
    if client is not None:
        with client.stream(method, url, headers=headers, content=data, timeout=timeout) as r:
            if r.status_code >= 400:
                body = r.read()
                raise HTTPError(r.status_code, f"HTTP {r.status_code}: {body[:300]!r}")
            yield from r.iter_bytes(chunk)
        return
    import urllib.error
    import urllib.request

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            while True:
                b = resp.read(chunk)
                if not b:
                    break
                yield b
    except urllib.error.HTTPError as e:
        raise HTTPError(e.code, f"HTTP {e.code}: {(e.read() or b'')[:300]!r}")


def multipart(fields: dict[str, str], files: dict[str, tuple[str, bytes, str]]) -> tuple[bytes, str]:
    """Encode multipart/form-data. files: name -> (filename, content, mime)."""
    boundary = uuid.uuid4().hex
    parts: list[bytes] = []
    for k, v in fields.items():
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    for k, (fn, content, mime) in files.items():
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"; filename=\"{fn}\"\r\n"
                     f"Content-Type: {mime}\r\n\r\n".encode() + content + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def wav_bytes(audio_f32, sr: int = 16000) -> bytes:
    import io
    import wave

    import numpy as np

    pcm = (np.clip(audio_f32, -1, 1) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    return buf.getvalue()
