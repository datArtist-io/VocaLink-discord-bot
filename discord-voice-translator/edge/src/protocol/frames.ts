/**
 * Edge <-> worker wire protocol (mirror of worker/translator_worker/protocol.py).
 *
 *   uint32 BE N | uint8 type | payload (N-1 bytes)
 *   0x01 JSON | 0x02 AUDIO_IN (u32 sid, u32 seq, PCM s16le 16k mono)
 *   0x03 AUDIO_OUT (u32 dubId, u32 seq, PCM s16le 48k mono) | 0x04 BLOB (u32 hlen, JSON, bytes)
 */

export const PROTOCOL_VERSION = 1;
export const FRAME_JSON = 0x01;
export const FRAME_AUDIO_IN = 0x02;
export const FRAME_AUDIO_OUT = 0x03;
export const FRAME_BLOB = 0x04;
export const MAX_FRAME = 8 * 1024 * 1024;
export const IN_RATE = 16_000;
export const OUT_RATE = 48_000;

export type Json = Record<string, unknown> & { type: string };

export type Frame =
  | { kind: typeof FRAME_JSON; json: Json }
  | { kind: typeof FRAME_AUDIO_IN | typeof FRAME_AUDIO_OUT; id: number; seq: number; pcm: Buffer }
  | { kind: typeof FRAME_BLOB; header: Record<string, unknown>; data: Buffer };

export class ProtocolError extends Error {}

function frame(kind: number, payload: Buffer): Buffer {
  const n = payload.length + 1;
  if (n > MAX_FRAME) throw new ProtocolError(`frame too large: ${n}`);
  const head = Buffer.allocUnsafe(5);
  head.writeUInt32BE(n, 0);
  head.writeUInt8(kind, 4);
  return Buffer.concat([head, payload]);
}

export function encodeJson(obj: Json): Buffer {
  return frame(FRAME_JSON, Buffer.from(JSON.stringify(obj), 'utf8'));
}

function encodeAudio(kind: number, id: number, seq: number, pcm: Buffer): Buffer {
  const h = Buffer.allocUnsafe(8);
  h.writeUInt32BE(id >>> 0, 0);
  h.writeUInt32BE(seq >>> 0, 4);
  return frame(kind, Buffer.concat([h, pcm]));
}

export const encodeAudioIn = (sid: number, seq: number, pcm: Buffer) => encodeAudio(FRAME_AUDIO_IN, sid, seq, pcm);
export const encodeAudioOut = (dubId: number, seq: number, pcm: Buffer) => encodeAudio(FRAME_AUDIO_OUT, dubId, seq, pcm);

export function encodeBlob(header: Record<string, unknown>, data: Buffer): Buffer {
  const h = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(h.length, 0);
  return frame(FRAME_BLOB, Buffer.concat([len, h, data]));
}

/** Incremental decoder: feed arbitrary chunks, get whole frames. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  feed(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Frame[] = [];
    let off = 0;
    while (this.buf.length - off >= 5) {
      const n = this.buf.readUInt32BE(off);
      if (n < 1 || n > MAX_FRAME) throw new ProtocolError(`bad frame length ${n}`);
      if (this.buf.length - off < 4 + n) break;
      const kind = this.buf.readUInt8(off + 4);
      const payload = this.buf.subarray(off + 5, off + 4 + n);
      off += 4 + n;
      out.push(parse(kind, payload));
    }
    this.buf = off ? Buffer.from(this.buf.subarray(off)) : this.buf;
    return out;
  }
}

function parse(kind: number, payload: Buffer): Frame {
  switch (kind) {
    case FRAME_JSON: {
      const obj = JSON.parse(payload.toString('utf8'));
      if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') throw new ProtocolError('JSON frame needs a type');
      return { kind, json: obj as Json };
    }
    case FRAME_AUDIO_IN:
    case FRAME_AUDIO_OUT: {
      if (payload.length < 8) throw new ProtocolError('audio frame too short');
      return { kind, id: payload.readUInt32BE(0), seq: payload.readUInt32BE(4), pcm: Buffer.from(payload.subarray(8)) };
    }
    case FRAME_BLOB: {
      const hl = payload.readUInt32BE(0);
      return { kind, header: JSON.parse(payload.subarray(4, 4 + hl).toString('utf8')), data: Buffer.from(payload.subarray(4 + hl)) };
    }
    default:
      throw new ProtocolError(`unknown frame type ${kind}`);
  }
}
