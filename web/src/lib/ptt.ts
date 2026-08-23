// Push-to-talk glue: mic -> codec -> wire, and wire -> codec -> speakers.
// This is the interaction model the architecture doc settled on for the BLE
// tier (Section 6.4) instead of live duplex calling — flooding-hop mesh
// links can't hide jitter the way a direct WebRTC path can, so BLE carries
// short recorded voice notes instead of a continuous stream.
import { PlaceholderLowBitrateCodec, SAMVAD_CODEC_SAMPLE_RATE, type EncodedFrame } from './codec'

// Wire format for one encoded voice frame, prefixed so the receiver can
// hand it straight back to AudioDecoder: [4 byte LE timestamp][opus data]
function packFrame(frame: EncodedFrame): Uint8Array {
  const out = new Uint8Array(4 + frame.data.byteLength)
  new DataView(out.buffer).setUint32(0, frame.timestampUs >>> 0, true)
  out.set(frame.data, 4)
  return out
}

function unpackFrame(bytes: Uint8Array): EncodedFrame {
  const timestampUs = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true)
  return { timestampUs, data: bytes.slice(4) }
}

export class PushToTalkRecorder {
  private codec = new PlaceholderLowBitrateCodec()
  private track: MediaStreamTrack | null = null
  private reader: ReadableStreamDefaultReader<AudioData> | null = null
  private recording = false
  private send: (bytes: Uint8Array) => Promise<void>
  private onError?: (err: unknown) => void

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
    // nowhere to go. Route it out explicitly instead of losing it.
    this.pump().catch((err) => this.onError?.(err))
  }

  private async pump() {
    while (this.recording && this.reader) {
      const { value, done } = await this.reader.read()
      if (done || !value) break
      const frames = await this.codec.encode(value)
      for (const frame of frames) await this.send(packFrame(frame))
    }
  }

  stop() {
    this.recording = false
    this.reader?.cancel().catch(() => {})
    this.track?.stop()
    this.codec.close()
  }
}

/** Decodes incoming voice frames and schedules them back-to-back on an AudioContext for gapless playback. */
export class PushToTalkPlayer {
  private codec = new PlaceholderLowBitrateCodec()
  private ctx = new AudioContext({ sampleRate: SAMVAD_CODEC_SAMPLE_RATE })
  private nextPlayTime = 0

  async playFrame(bytes: Uint8Array) {
    const frame = unpackFrame(bytes)
    const decoded = await this.codec.decode(frame)
    for (const audioData of decoded) {
      const buffer = this.ctx.createBuffer(
        audioData.numberOfChannels,
        audioData.numberOfFrames,
        audioData.sampleRate,
      )
      const channelData = new Float32Array(audioData.numberOfFrames)
      audioData.copyTo(channelData, { planeIndex: 0, format: 'f32-planar' })
      buffer.copyToChannel(channelData, 0)
      audioData.close()

      const source = this.ctx.createBufferSource()
      source.buffer = buffer
      source.connect(this.ctx.destination)
      const startAt = Math.max(this.ctx.currentTime, this.nextPlayTime)
      source.start(startAt)
      this.nextPlayTime = startAt + buffer.duration
    }
  }

  close() {
    this.codec.close()
    this.ctx.close()
  }
}
