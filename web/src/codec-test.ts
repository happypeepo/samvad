// Standalone loopback harness for lib/ptt.ts + lib/codec.ts — deliberately
// has nothing to do with lib/ble.ts, and uses a synthetic oscillator tone
// instead of getUserMedia (the sandboxed preview browser blocks real mic
// capture). Reuses the actual batching/pack/decode functions from ptt.ts
// so this exercises the real fix, not a reimplementation of it.
import { PlaceholderLowBitrateCodec, SAMVAD_CODEC_SAMPLE_RATE, type CodecFormat } from './lib/codec'
import { PushToTalkPlayer, TARGET_FRAME_DURATION_US, mergeAudioChunks, packFrame } from './lib/ptt'

const startBtn = document.getElementById('start') as HTMLButtonElement
const stopBtn = document.getElementById('stop') as HTMLButtonElement
const log = document.getElementById('log') as HTMLPreElement

function appendLog(line: string) {
  log.textContent += line + '\n'
  log.scrollTop = log.scrollHeight
}

const player = new PushToTalkPlayer()
let running = false
let frameCount = 0
let byteCount = 0
let audioCtx: AudioContext | null = null
let oscillator: OscillatorNode | null = null

async function run() {
  // Synthetic source: a 440Hz tone through a MediaStreamAudioDestinationNode
  // produces a real MediaStream (and thus a real MediaStreamTrackProcessor
  // feed) without ever calling getUserMedia.
  audioCtx = new AudioContext({ sampleRate: SAMVAD_CODEC_SAMPLE_RATE })
  oscillator = audioCtx.createOscillator()
  oscillator.frequency.value = 440
  const gain = audioCtx.createGain()
  gain.gain.value = 0.2
  const dest = audioCtx.createMediaStreamDestination()
  // Defaults to stereo, unlike a real mic (getUserMedia requests mono) —
  // force mono so this harness matches the format the real recorder sees.
  dest.channelCount = 1
  oscillator.connect(gain).connect(dest)
  oscillator.start()

  const track = dest.stream.getAudioTracks()[0]
  const processor = new MediaStreamTrackProcessor({ track })
  const reader = processor.readable.getReader()

  let codec: PlaceholderLowBitrateCodec | null = null
  let format: CodecFormat | null = null
  let pendingRawChunks: AudioData[] = []
  let rawChunksPerFrame = 1

  appendLog('started — synthetic 440Hz tone -> encode -> decode -> speakers')

  while (running) {
    const { value, done } = await reader.read()
    if (done || !value) break

    if (!codec && pendingRawChunks.length === 0) {
      const rawFrameDurationUs = Math.round((value.numberOfFrames / value.sampleRate) * 1_000_000)
      rawChunksPerFrame = Math.max(1, Math.round(TARGET_FRAME_DURATION_US / rawFrameDurationUs))
      appendLog(
        `raw chunk: ${value.numberOfFrames} samples @ ${value.sampleRate}Hz = ${rawFrameDurationUs}us -> batching ${rawChunksPerFrame} chunks/frame`,
      )
    }

    pendingRawChunks.push(value)
    if (pendingRawChunks.length < rawChunksPerFrame) continue

    const batch = mergeAudioChunks(pendingRawChunks)
    pendingRawChunks = []

    if (!codec) {
      format = {
        sampleRate: batch.sampleRate,
        numberOfChannels: batch.numberOfChannels,
        frameDurationUs: Math.round((batch.numberOfFrames / batch.sampleRate) * 1_000_000),
      }
      codec = new PlaceholderLowBitrateCodec(format)
      appendLog(`codec configured: ${JSON.stringify(format)}`)
    }

    const frames = await codec.encode(batch)
    for (const frame of frames) {
      const bytes = packFrame(frame, format!)
      frameCount++
      byteCount += bytes.byteLength
      await player.playFrame(bytes)
    }
  }

  for (const leftover of pendingRawChunks) leftover.close()
  codec?.close()
  reader.releaseLock()
}

startBtn.onclick = () => {
  if (running) return
  frameCount = 0
  byteCount = 0
  running = true
  run().catch((err) => appendLog(`ERROR: ${err}`))
}

stopBtn.onclick = () => {
  running = false
  oscillator?.stop()
  audioCtx?.close()
  const avg = frameCount ? (byteCount / frameCount).toFixed(1) : '0'
  appendLog(`stopped. frames=${frameCount} totalBytes=${byteCount} avgBytesPerFrame=${avg}`)
}
