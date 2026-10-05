"""Encrypted voice-profile store for consented voice cloning.

* Profiles are only created through the live read-aloud enrollment flow
  (the phrase is verified with STT), never from uploaded files.
* Reference audio is encrypted at rest with AES-256-GCM. The key comes from
  the VOICE_PROFILE_KEY env var (32 random bytes, base64). Without a key,
  cloning is disabled entirely.
* File names are keyed hashes of the user id, so a directory listing does not
  reveal who enrolled. The user id is bound as AEAD associated data.
* delete() removes the file immediately (/voice delete).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import threading
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np

from .providers.base import VoiceRef

MAGIC = b"DVTV1"


class VoiceStoreDisabled(RuntimeError):
    pass


def generate_key() -> str:
    return base64.b64encode(os.urandom(32)).decode()


class VoiceStore:
    def __init__(self, directory: str | os.PathLike, key_b64: str | None, cache_size: int = 32):
        self.dir = Path(directory)
        self._key: bytes | None = None
        self.reason = ""
        if key_b64:
            try:
                key = base64.b64decode(key_b64)
                if len(key) != 32:
                    raise ValueError("key must be 32 bytes")
                self._key = key
            except Exception as e:  # noqa: BLE001
                self.reason = f"invalid VOICE_PROFILE_KEY: {e}"
        else:
            self.reason = "VOICE_PROFILE_KEY not set - voice cloning disabled"
        self._cache: OrderedDict[str, VoiceRef] = OrderedDict()
        self._cache_size = cache_size
        self._lock = threading.Lock()
        if self._key:
            self.dir.mkdir(parents=True, exist_ok=True)
            try:
                os.chmod(self.dir, 0o700)
            except OSError:
                pass

    @property
    def enabled(self) -> bool:
        return self._key is not None

    def _path(self, user_id: str) -> Path:
        assert self._key
        h = hmac.new(self._key, f"voice:{user_id}".encode(), hashlib.sha256).hexdigest()[:40]
        return self.dir / f"{h}.vpf"

    def _aead(self):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # type: ignore
        return AESGCM(self._key)

    def has(self, user_id: str) -> bool:
        return self.enabled and self._path(str(user_id)).exists()

    def save(self, user_id: str, audio: np.ndarray, sample_rate: int, meta: dict) -> None:
        if not self.enabled:
            raise VoiceStoreDisabled(self.reason)
        user_id = str(user_id)
        pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
        header = json.dumps({**meta, "sample_rate": sample_rate, "created": time.time()}).encode()
        plain = len(header).to_bytes(4, "big") + header + pcm
        nonce = os.urandom(12)
        ct = self._aead().encrypt(nonce, plain, f"user:{user_id}".encode())
        tmp = self._path(user_id).with_suffix(".tmp")
        with open(tmp, "wb") as f:
            f.write(MAGIC + nonce + ct)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self._path(user_id))
        with self._lock:
            self._cache.pop(user_id, None)

    def load(self, user_id: str) -> VoiceRef | None:
        if not self.enabled:
            return None
        user_id = str(user_id)
        with self._lock:
            if user_id in self._cache:
                self._cache.move_to_end(user_id)
                return self._cache[user_id]
        p = self._path(user_id)
        if not p.exists():
            return None
        raw = p.read_bytes()
        if not raw.startswith(MAGIC):
            raise ValueError("corrupt voice profile")
        nonce, ct = raw[len(MAGIC): len(MAGIC) + 12], raw[len(MAGIC) + 12:]
        plain = self._aead().decrypt(nonce, ct, f"user:{user_id}".encode())
        hlen = int.from_bytes(plain[:4], "big")
        meta = json.loads(plain[4: 4 + hlen])
        audio = np.frombuffer(plain[4 + hlen:], dtype="<i2").astype(np.float32) / 32768.0
        ref = VoiceRef(user_id=user_id, reference_wav=audio, reference_rate=int(meta["sample_rate"]),
                       cache_key=hashlib.sha256(raw[:64]).hexdigest()[:16])
        with self._lock:
            self._cache[user_id] = ref
            while len(self._cache) > self._cache_size:
                self._cache.popitem(last=False)
        return ref

    def meta(self, user_id: str) -> dict | None:
        ref_path = self._path(str(user_id)) if self.enabled else None
        if not ref_path or not ref_path.exists():
            return None
        raw = ref_path.read_bytes()
        plain = self._aead().decrypt(raw[len(MAGIC): len(MAGIC) + 12], raw[len(MAGIC) + 12:],
                                     f"user:{user_id}".encode())
        hlen = int.from_bytes(plain[:4], "big")
        return json.loads(plain[4: 4 + hlen])

    def delete(self, user_id: str) -> bool:
        if not self.enabled:
            return False
        user_id = str(user_id)
        with self._lock:
            self._cache.pop(user_id, None)
        p = self._path(user_id)
        if p.exists():
            # overwrite before unlinking (best effort on copy-on-write filesystems)
            try:
                size = p.stat().st_size
                with open(p, "r+b") as f:
                    f.write(os.urandom(size))
                    f.flush()
                    os.fsync(f.fileno())
            except OSError:
                pass
            p.unlink(missing_ok=True)
            return True
        return False
