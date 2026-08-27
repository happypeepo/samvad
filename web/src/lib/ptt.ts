// Push-to-talk glue: mic -> codec -> wire, and wire -> codec -> speakers.
// This is the interaction model the architecture doc settled on for the BLE
// tier (Section 6.4) instead of live duplex calling — flooding-hop mesh
// links can't hide jitter the way a direct WebRTC path can, so BLE carries
// short recorded voice notes instead of a continuous stream.
import { PlaceholderLowBitrateCodec, SAMVAD_CODEC_SAMPLE_RATE, type CodecFormat, type EncodedFrame } from './codec'

// Wire format for one encoded voice frame: [4 byte LE timestamp][4 byte LE
// sampleRate][1 byte channels][opus data]. Format travels with every frame
// (instead of being assumed) because the sender's actual capture format
// depends on what its mic hardware will give up — see PushToTalkRecorder.start.
// Exported (alongside mergeAudioChunks/TARGET_FRAME_DURATION_US below) only
// so codec-test.ts — a synthetic-source loopback harness with no mic/BLE
// dependency — can exercise the exact same batching/pack/decode logic this
// module uses, instead of a hand-rolled reimplementation that could mask
// bugs by drifting from the real thing.
export function packFrame(frame: EncodedFrame, format: { sampleRate: number; numberOfChannels: number }): Uint8Array {
  const out = new Uint8Array(9 + frame.data.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, frame.timestampUs >>> 0, true)
  view.setUint32(4, format.sampleRate >>> 0, true)
  view.setUint8(8, format.numberOfChannels)
  out.set(frame.data, 9)
  return out
}

function unpackFrame(bytes: Uint8Array): EncodedFrame & { sampleRate: number; numberOfChannels: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  const timestampUs = view.getUint32(0, true)
  const sampleRate = view.getUint32(4, true)
  const numberOfChannels = view.getUint8(8)
  return { timestampUs, sampleRate, numberOfChannels, data: bytes.slice(9) }
}

// Opus's standard voice frame size. A single raw chunk straight off
// MediaStreamTrackProcessor can be much shorter than this (10ms on real
// hardware we've tested on) — encoding each one independently produces
// payloads too small to carry much beyond noise at voice bitrates, and
// doubles+ the number of BLE writes needed for the same audio. Buffer raw
// chunks up to this duration before handing them to the encoder.
export const TARGET_FRAME_DURATION_US = 20_000

// Concatenates consecutive raw mic chunks into one longer chunk. Only reads
// plane 0 (mono) — matches the same single-channel assumption
// PushToTalkPlayer.playFrame already makes on the decode side.
export function mergeAudioChunks(chunks: AudioData[]): AudioData {
  // Read whatever we need from the first chunk *before* the loop below
  // closes it — a closed AudioData's properties (sampleRate,
  // numberOfChannels, timestamp) reset to invalid/zero, so reading them
  // off `first` after close() throws exactly the "numberOfChannels must
  // be greater than 0" error this comment is now next to.
  const { sampleRate, numberOfChannels, timestamp } = chunks[0]
  const merged = new Float32Array(chunks.reduce((sum, c) => sum + c.numberOfFrames, 0))
  let offset = 0
  for (const c of chunks) {
    c.copyTo(merged.subarray(offset, offset + c.numberOfFrames), { planeIndex: 0, format: 'f32-planar' })
    offset += c.numberOfFrames
    c.close()
  }
  return new AudioData({
    format: 'f32-planar',
    sampleRate,
    numberOfFrames: merged.length,
    numberOfChannels,
    timestamp,
    data: merged,
  })
}

export class PushToTalkRecorder {
  private codec: PlaceholderLowBitrateCodec | null = null
  private format: CodecFormat | null = null
  private track: MediaStreamTrack | null = null
  private reader: ReadableStreamDefaultReader<AudioData> | null = null
  private recording = false
  private send: (bytes: Uint8Array) => Promise<void>
  private onError?: (err: unknown) => void
  private pumpDone: Promise<void> = Promise.resolve()
  private pendingRawChunks: AudioData[] = []
  private rawChunksPerFrame = 1

  constructor(send: (bytes: Uint8Array) => Promise<void>, onError?: (err: unknown) => void) {
    this.send = send
    this.onError = onError
  }

  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: SAMVAD_CODEC_SAMPLE_RATE, echoCancellation: true },
    })
    this.track = stream.getAudioTracks()[0]
    // Insertable-streams bridge from a live MediaStreamTrack to WebCodecs AudioData.
    const processor = new MediaStreamTrackProcessor({ track: this.track })
    this.reader = processor.readable.getReader()
    this.recording = true
    // Fire-and-forget by design (start() shouldn't block on the whole
    // recording session) — but that means an error thrown mid-stream had
    // nowhere to go. Route it out explicitly instead of losing it. Also
    // tracked so stop() can wait for any in-flight encode() before closing
    // the codec out from under it.
    this.pumpDone = this.pump().catch((err) => this.onError?.(err))
  }

  private async pump() {
    while (this.recording && this.reader) {
      const { value, done } = await this.reader.read()
      if (done || !value) break

      if (!this.codec && this.pendingRawChunks.length === 0) {
        // channelCount/sampleRate on getUserMedia are only hints, and even
        // the negotiated MediaStreamTrack settings don't guarantee the exact
        // chunk shape WebCodecs will deliver — real hardware handed back
        // 48kHz mono in 480-sample (10ms) chunks here. Figure out how many
        // of these raw chunks it takes to reach Opus's standard ~20ms voice
        // frame, so we're not encoding (and BLE-writing) each tiny 10ms
        // sliver on its own.
        const rawFrameDurationUs = Math.round((value.numberOfFrames / value.sampleRate) * 1_000_000)
        this.rawChunksPerFrame = Math.max(1, Math.round(TARGET_FRAME_DURATION_US / rawFrameDurationUs))
      }

      this.pendingRawChunks.push(value)
      if (this.pendingRawChunks.length < this.rawChunksPerFrame) continue

      const batch = mergeAudioChunks(this.pendingRawChunks)
      this.pendingRawChunks = []

      if (!this.codec) {
        // Configuring the encoder for anything other than what actually
        // arrives makes it reject every chunk with "incompatible with codec
        // parameters" — build it from the first real (now-batched) chunk
        // instead of guessing upfront.
        this.format = {
          sampleRate: batch.sampleRate,
          numberOfChannels: batch.numberOfChannels,
          frameDurationUs: Math.round((batch.numberOfFrames / batch.sampleRate) * 1_000_000),
        }
        this.codec = new PlaceholderLowBitrateCodec(this.format)
      }
      const frames = await this.codec.encode(batch)
      for (const frame of frames) await this.send(packFrame(frame, this.format!))
    }
    // Any leftover raw chunks short of a full frame are dropped, not
    // encoded — the encoder is locked to a fixed frame duration once
    // configured, and a short final chunk would hit the same
    // "incompatible with codec parameters" mismatch this batching exists to
    // avoid. Losing under one frame's worth of trailing audio is inaudible.
    for (const leftover of this.pendingRawChunks) leftover.close()
    this.pendingRawChunks = []
  }

  stop() {
    this.recording = false
    this.reader?.cancel().catch(() => {})
    this.track?.stop()
    // Wait for the pump loop to actually exit before closing the codec —
    // it may be mid-`await this.codec.encode(value)` right now, and closing
    // out from under that call throws InvalidStateError ("closed codec").
    const codec = this.codec
    this.pumpDone.finally(() => codec?.close())
  }
}

/** Decodes incoming voice frames and schedules them back-to-back on an AudioContext for gapless playback. */
export class PushToTalkPlayer {
  private codec: PlaceholderLowBitrateCodec | null = null
  private ctx: AudioContext | null = null
  private format: { sampleRate: number; numberOfChannels: number } | null = null
  private nextPlayTime = 0

  async playFrame(bytes: Uint8Array) {
    const frame = unpackFrame(bytes)
    // The sender's actual capture format travels with the frame (see
    // packFrame) — build (or rebuild) the decoder and playback context to
    // match it rather than assuming SAMVAD_CODEC_SAMPLE_RATE, since that's
    // just a fallback default, not a guarantee of what the peer captured at.
    if (!this.codec || !this.ctx || this.format?.sampleRate !== frame.sampleRate) {
      this.codec?.close()
      this.ctx?.close()
      this.format = { sampleRate: frame.sampleRate, numberOfChannels: frame.numberOfChannels }
      this.codec = new PlaceholderLowBitrateCodec(this.format)
      this.ctx = new AudioContext({ sampleRate: frame.sampleRate })
      this.nextPlayTime = 0
    }
    const ctx = this.ctx
    const decoded = await this.codec.decode(frame)
    for (const audioData of decoded) {
      const buffer = ctx.createBuffer(
        audioData.numberOfChannels,
        audioData.numberOfFrames,
        audioData.sampleRate,
      )
      const channelData = new Float32Array(audioData.numberOfFrames)
      audioData.copyTo(channelData, { planeIndex: 0, format: 'f32-planar' })
      buffer.copyToChannel(channelData, 0)
      audioData.close()

      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      const startAt = Math.max(ctx.currentTime, this.nextPlayTime)
      source.start(startAt)
      this.nextPlayTime = startAt + buffer.duration
    }
  }

  close() {
    this.codec?.close()
    this.ctx?.close()
  }
}
