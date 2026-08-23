// Length-prefixed message framing for the BLE tier's byte stream. A
// connected GATT link delivers writes/notifications in order and reliably,
// so (unlike UDP) plain length-prefixing is enough — no per-chunk sequence
// numbers needed, just accumulate and slice like a TCP stream.
//
// Envelope: [1 byte type][4 byte big-endian length][payload...]
export const FrameType = {
  NoiseHandshake: 0,
  VoiceFrame: 1,
} as const
export type FrameType = (typeof FrameType)[keyof typeof FrameType]

const HEADER_LEN = 5

export function encodeFrame(type: FrameType, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + payload.byteLength)
  out[0] = type
  new DataView(out.buffer).setUint32(1, payload.byteLength, false)
  out.set(payload, HEADER_LEN)
  return out
}

/** Splits a single (possibly large) frame into BLE-write-sized chunks. */
export function chunk(data: Uint8Array, maxChunkSize: number): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < data.byteLength; i += maxChunkSize) {
    out.push(data.subarray(i, Math.min(i + maxChunkSize, data.byteLength)))
  }
  return out.length > 0 ? out : [new Uint8Array(0)]
}

export interface DecodedFrame {
  type: FrameType
  payload: Uint8Array
}

/** Stateful reassembler: feed it raw bytes as they arrive, get back complete frames. */
export class FrameReassembler {
  private buf = new Uint8Array(0)

  push(bytes: Uint8Array): DecodedFrame[] {
    const combined = new Uint8Array(this.buf.byteLength + bytes.byteLength)
    combined.set(this.buf, 0)
    combined.set(bytes, this.buf.byteLength)
    this.buf = combined

    const frames: DecodedFrame[] = []
    while (this.buf.byteLength >= HEADER_LEN) {
      const type = this.buf[0] as FrameType
      const len = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(1, false)
      if (this.buf.byteLength < HEADER_LEN + len) break // wait for more chunks
      frames.push({ type, payload: this.buf.slice(HEADER_LEN, HEADER_LEN + len) })
      this.buf = this.buf.slice(HEADER_LEN + len)
    }
    return frames
  }
}
