// TypeScript's bundled DOM lib doesn't yet include the Insertable Streams
// for MediaStreamTrack API (MediaStreamTrackProcessor/Generator), even
// though it ships in Chromium (and therefore in the Capacitor Android
// WebView we're targeting). Minimal ambient types for what SAMVAD uses.
interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack
}

declare class MediaStreamTrackProcessor {
  constructor(init: MediaStreamTrackProcessorInit)
  readonly readable: ReadableStream<AudioData>
}
