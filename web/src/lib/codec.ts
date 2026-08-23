// Voice codec abstraction for the bandwidth-starved tiers (BLE today, RF
// later). The internet tier doesn't use this at all — WebRTC negotiates
// Opus itself.
//
// TODO(codec2): this is a placeholder, not Codec2. The architecture doc
// calls Codec2 "the single most load-bearing codec decision in the
// project" (700-1200 bps over BLE/RF) and that's still the target — it
// needs libcodec2 cross-compiled to WASM (via emscripten, not installed in
// this environment yet) or wrapped as a native Android codec. Swapping it
// in only touches this file: implement VoiceCodec and point ble.ts at it.
//
// Until then, this uses the browser's built-in WebCodecs AudioEncoder
// with Opus pinned to its lowest usable bitrate. It's still ~5-10x the
// bitrate Codec2 would use, so it's a real, working, on-device codec
// pipeline (not mocked data) — just not the final bitrate budget.
export interface EncodedFrame {
  data: Uint8Array
  timestampUs: number
}

export interface VoiceCodec {
  encode(chunk: AudioData): Promise<EncodedFrame[]>
  decode(frame: EncodedFrame): Promise<AudioData[]>
  close(): void
}

const SAMPLE_RATE = 16000 // voice-grade; matches Codec2's typical operating rate
const CHANNELS = 1
const PLACEHOLDER_BITRATE = 6000 // bps — Opus's practical floor; real Codec2 target is 700-1200 bps

export class PlaceholderLowBitrateCodec implements VoiceCodec {
  private encoder: AudioEncoder
  private decoder: AudioDecoder
  private pendingEncoded: EncodedFrame[] = []
  private pendingDecoded: AudioData[] = []

  constructor() {
    this.encoder = new AudioEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        this.pendingEncoded.push({ data, timestampUs: chunk.timestamp })
      },
      error: (e) => console.error('[codec] encoder error', e),
    })
    this.encoder.configure({
      codec: 'opus',
      sampleRate: SAMPLE_RATE,
      numberOfChannels: CHANNELS,
      bitrate: PLACEHOLDER_BITRATE,
      opus: { frameDuration: 20000 }, // 20ms frames, standard for voice
    })

    this.decoder = new AudioDecoder({
      output: (audioData) => this.pendingDecoded.push(audioData),
      error: (e) => console.error('[codec] decoder error', e),
    })
    this.decoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS })
  }

  async encode(chunk: AudioData): Promise<EncodedFrame[]> {
    this.encoder.encode(chunk)
    chunk.close()
    await this.encoder.flush()
    const out = this.pendingEncoded
    this.pendingEncoded = []
    return out
  }

  async decode(frame: EncodedFrame): Promise<AudioData[]> {
    this.decoder.decode(
      new EncodedAudioChunk({
        type: 'key', // Opus frames are independently decodable
        timestamp: frame.timestampUs,
        data: frame.data,
      }),
    )
    await this.decoder.flush()
    const out = this.pendingDecoded
    this.pendingDecoded = []
    return out
  }

  close() {
    this.encoder.close()
    this.decoder.close()
  }
}

export const SAMVAD_CODEC_SAMPLE_RATE = SAMPLE_RATE
