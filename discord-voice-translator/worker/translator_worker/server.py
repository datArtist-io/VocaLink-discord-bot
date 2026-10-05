"""asyncio TCP server speaking the framed protocol to one or more edges."""

from __future__ import annotations

import asyncio
import itertools
import logging
import time
import uuid

from . import languages as L
from . import protocol as P
from . import registry as R
from . import summary as S
from .audio import pcm16_to_f32
from .glossary import learn_from_correction
from .guild import GuildState
from .pipeline import CancelToken
from .router import NoProvider
from .session import SpeakerSession
from .textutil import similarity

log = logging.getLogger("server")

MAX_QUEUE = 2048       # frames waiting to be written
DROP_ABOVE = 512       # droppable events are dropped beyond this backlog


class EdgeConnection:
    def __init__(self, app, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.app = app
        self.reader = reader
        self.writer = writer
        self.peer = writer.get_extra_info("peername")
        self.id = uuid.uuid4().hex[:8]
        self.edge_id = ""
        self.authed = not bool(app.cfg.server.auth_token)
        self.sessions: dict[int, SpeakerSession] = {}
        self.guilds: dict[str, GuildState] = {}
        self._q: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=MAX_QUEUE)
        self._dub_ids = itertools.count(1)
        self._dubs: dict[int, CancelToken] = {}
        self._writer_task: asyncio.Task | None = None
        self.closed = False
        self.dropped = 0

    # ------------------------------------------------------------------ output
    def _enqueue(self, data: bytes, droppable: bool) -> None:
        if self.closed:
            return
        if droppable and self._q.qsize() > DROP_ABOVE:
            self.dropped += 1
            return
        try:
            self._q.put_nowait(data)
        except asyncio.QueueFull:
            self.dropped += 1
            if not droppable:
                log.error("edge %s output queue full; closing", self.id)
                self.writer.close()

    def emit(self, obj: dict, droppable: bool = False) -> None:
        self._enqueue(P.encode_json(obj), droppable)

    def emit_audio(self, dub_id: int, seq: int, pcm: bytes) -> None:
        self._enqueue(P.encode_audio_out(dub_id, seq, pcm), False)

    def new_dub_id(self) -> int:
        return next(self._dub_ids)

    def register_dub(self, dub_id: int, token: CancelToken) -> None:
        self._dubs[dub_id] = token

    def unregister_dub(self, dub_id: int) -> None:
        self._dubs.pop(dub_id, None)

    async def _writer_loop(self) -> None:
        try:
            while True:
                item = await self._q.get()
                if item is None:
                    break
                self.writer.write(item)
                if self._q.empty() or self.writer.transport.get_write_buffer_size() > 256 * 1024:
                    await self.writer.drain()
        except (ConnectionError, asyncio.CancelledError):
            pass

    # ------------------------------------------------------------------ input
    async def run(self) -> None:
        self._writer_task = asyncio.create_task(self._writer_loop())
        try:
            while True:
                timeout = None if self.authed else 10.0
                frame = await asyncio.wait_for(P.read_frame(self.reader), timeout=timeout)
                if frame is None:
                    break
                if frame.kind == P.FRAME_AUDIO_IN:
                    if not self.authed:
                        break
                    sid, seq, pcm = frame.audio()
                    s = self.sessions.get(sid)
                    if s:
                        s.feed(pcm, seq)
                elif frame.kind == P.FRAME_JSON:
                    await self._on_json(frame.json())
                elif frame.kind == P.FRAME_BLOB:
                    if not self.authed:
                        break
                    header, data = frame.blob()
                    asyncio.create_task(self._on_blob(header, data))
        except asyncio.TimeoutError:
            log.warning("edge %s did not authenticate in time", self.peer)
        except P.ProtocolError as e:
            log.warning("protocol error from %s: %s", self.peer, e)
        except ConnectionError:
            pass
        finally:
            await self.close()

    async def close(self) -> None:
        if self.closed:
            return
        for t in self._dubs.values():
            t.cancel("edge disconnected")
        sessions = list(self.sessions.values())
        self.sessions.clear()
        for s in sessions:
            s.closed = True
        self.closed = True
        try:
            self._q.put_nowait(None)
        except asyncio.QueueFull:
            pass
        try:
            self.writer.close()
        except Exception:  # noqa: BLE001
            pass
        self.app.connections.discard(self)
        log.info("edge %s (%s) disconnected", self.edge_id or self.id, self.peer)

    # ------------------------------------------------------------------ handlers
    def guild(self, gid: str) -> GuildState:
        gid = str(gid)
        if gid not in self.guilds:
            self.guilds[gid] = GuildState(gid)
            self.guilds[gid].transcript = type(self.guilds[gid].transcript)(
                maxlen=self.app.cfg.pipeline.transcript_max_lines)
        return self.guilds[gid]

    async def _on_json(self, m: dict) -> None:
        t = m.get("type")
        if t == "hello":
            tok = self.app.cfg.server.auth_token
            if tok and m.get("token") != tok:
                self.emit({"type": "hello_error", "message": "bad token"})
                await asyncio.sleep(0.05)
                raise ConnectionError("bad token")
            if int(m.get("protocol", 0)) != P.PROTOCOL_VERSION:
                self.emit({"type": "hello_error", "message": f"protocol {P.PROTOCOL_VERSION} required"})
                raise ConnectionError("protocol mismatch")
            self.authed = True
            self.edge_id = str(m.get("edge_id", ""))
            self.emit({"type": "hello_ack", "protocol": P.PROTOCOL_VERSION, **self.app.describe()})
            log.info("edge %s connected from %s", self.edge_id, self.peer)
            return
        if not self.authed:
            raise ConnectionError("not authenticated")
        if t == "ping":
            self.emit({"type": "pong", "t": m.get("t"), "worker_time": time.time()})
        elif t == "guild_config":
            g = self.guild(m["guild_id"])
            before = set(g.audio_targets)
            g.update(m)
            if g.audio_targets - before:
                asyncio.create_task(self.app.pipeline.warm_tts(sorted(g.audio_targets - before)))
            for s in self.sessions.values():
                if s.guild is g:
                    s.set_allowed(g.expected_langs)
        elif t == "stream_open":
            sid = int(m["sid"])
            old = self.sessions.pop(sid, None)
            if old:
                asyncio.create_task(old.close())
            self.sessions[sid] = SpeakerSession(
                sid=sid, conn=self, guild=self.guild(m["guild_id"]), user_id=str(m["user_id"]),
                name=m.get("name", "speaker"), speak_lang=m.get("speak_lang"), pipeline=self.app.pipeline,
                cfg=self.app.cfg, voices=self.app.voices)
        elif t == "stream_update":
            s = self.sessions.get(int(m["sid"]))
            if s and "speak_lang" in m:
                s.set_speak_lang(m["speak_lang"])
            if s and "name" in m:
                s.name = m["name"]
        elif t == "stream_close":
            s = self.sessions.pop(int(m["sid"]), None)
            if s:
                asyncio.create_task(s.close())
        elif t == "cancel_dub":
            tok = self._dubs.get(int(m["dub_id"]))
            if tok:
                tok.cancel(m.get("reason", "cancelled_by_edge"))
        elif t == "translate_text":
            asyncio.create_task(self._translate_text(m))
        elif t == "summarize":
            asyncio.create_task(self._summarize(m))
        elif t == "clear_transcript":
            self.guild(m["guild_id"]).transcript.clear()
        elif t == "correct":
            terms = learn_from_correction(m.get("original", ""), m.get("corrected", ""),
                                          L.normalize(m.get("src_lang", "*")) or "*",
                                          L.normalize(m.get("tgt_lang", "*")) or "*")
            self.emit({"type": "correct_result", "req_id": m.get("req_id"),
                       "terms": [t.__dict__ for t in terms]})
        elif t == "voice_delete":
            ok = await self.app.pipeline.run_misc(self.app.voices.delete, str(m["user_id"]))
            self.emit({"type": "voice_delete_result", "req_id": m.get("req_id"), "deleted": bool(ok)})
        elif t == "voice_status":
            v = self.app.voices
            self.emit({"type": "voice_status_result", "req_id": m.get("req_id"), "enabled": v.enabled,
                       "reason": v.reason, "has_profile": v.has(str(m["user_id"])),
                       "clone_providers": [p.info.name for p in self.app.providers.clone]})
        elif t == "languages":
            self.emit({"type": "languages_result", "req_id": m.get("req_id"),
                       "languages": R.as_json(self.app.caps), "summary": R.summary(self.app.caps)})
        else:
            log.debug("unknown message type %s", t)

    async def _translate_text(self, m: dict) -> None:
        req = m.get("req_id")
        src = L.normalize(m.get("src") or "en")
        tgt = L.normalize(m["tgt"])
        mode = m.get("mode", "literal")
        g = self.guild(m["guild_id"]) if m.get("guild_id") else None
        try:
            if src == tgt:
                out = {"text": m["text"], "provider": "identity", "note": ""}
            else:
                r = (await self.app.pipeline.translate([m["text"]], src, tgt, mode=mode,
                                                       glossary=g.glossary if g else None))[0]
                out = {"text": r.text, "provider": r.provider, "note": r.note}
            self.emit({"type": "translate_result", "req_id": req, "ok": True, **out})
        except NoProvider as e:
            self.emit({"type": "translate_result", "req_id": req, "ok": False, "error": str(e)})

    async def _summarize(self, m: dict) -> None:
        g = self.guild(m["guild_id"])
        try:
            res = await S.summarize(self.app.pipeline, g, [L.normalize(x) for x in m.get("langs", ["en"])])
            if m.get("clear", True):
                g.transcript.clear()
            self.emit({"type": "summary_result", "req_id": m.get("req_id"), "ok": True, **res})
        except Exception as e:  # noqa: BLE001
            log.exception("summary failed")
            self.emit({"type": "summary_result", "req_id": m.get("req_id"), "ok": False, "error": str(e)})

    async def _on_blob(self, header: dict, data: bytes) -> None:
        if header.get("type") != "voice_enroll":
            return
        req = header.get("req_id")
        cfg = self.app.cfg.clone
        v = self.app.voices

        def fail(reason: str, **kw):
            self.emit({"type": "voice_enroll_result", "req_id": req, "ok": False, "reason": reason, **kw})

        if not v.enabled:
            return fail(v.reason)
        audio = pcm16_to_f32(data)
        dur = audio.size / 16000
        if dur < cfg.min_enroll_s:
            return fail(f"need at least {cfg.min_enroll_s:.0f} s of speech, got {dur:.1f} s")
        lang = L.normalize(header.get("lang") or "") or None
        try:
            res = await self.app.pipeline.stt(audio, lang, final=True)
        except NoProvider as e:
            return fail(str(e))
        sim = similarity(res.text, header.get("phrase", ""))
        if sim < cfg.phrase_similarity:
            return fail("the recording did not match the consent phrase", similarity=round(sim, 2),
                        heard=res.text[:200])
        await self.app.pipeline.run_misc(
            v.save, str(header["user_id"]), audio, 16000,
            {"phrase_similarity": round(sim, 3), "lang": res.language,
             "consent_version": header.get("consent_version", ""), "guild_id": header.get("guild_id")})
        self.emit({"type": "voice_enroll_result", "req_id": req, "ok": True, "similarity": round(sim, 2),
                   "duration_s": round(dur, 1)})


class WorkerServer:
    def __init__(self, app):
        self.app = app
        self.server: asyncio.base_events.Server | None = None

    async def start(self, host: str, port: int) -> int:
        self.server = await asyncio.start_server(self._accept, host, port, limit=P.MAX_FRAME + 16)
        sock = self.server.sockets[0]
        return sock.getsockname()[1]

    async def _accept(self, reader, writer) -> None:
        if len(self.app.connections) >= self.app.cfg.server.max_edges:
            writer.close()
            return
        sock = writer.get_extra_info("socket")
        try:
            import socket
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except Exception:  # noqa: BLE001
            pass
        conn = EdgeConnection(self.app, reader, writer)
        self.app.connections.add(conn)
        await conn.run()

    async def stop(self) -> None:
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        for c in list(self.app.connections):
            await c.close()
