// Where to find the internet-tier signaling server.
//
// In a plain browser tab, `location.hostname` is correct by construction —
// the page and the signaling server are served from the same dev machine.
// Inside the packaged native app, though, the WebView loads the bundled
// assets from Capacitor's internal `https://localhost` scheme, so
// `location.hostname` resolves to the *phone itself*, not the laptop
// running the signaling server. There's no way to infer the right LAN
// address there, so the native build needs it entered once; it's cached in
// localStorage after that.
import { Capacitor } from '@capacitor/core'

const STORAGE_KEY = 'samvad.signalingHost.v1'

export function getSignalingHost(): string {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored) return stored
  return Capacitor.isNativePlatform() ? '' : location.hostname
}

export function setSignalingHost(host: string) {
  localStorage.setItem(STORAGE_KEY, host)
}

export function signalingWsUrl(host: string) {
  return `ws://${host}:8787`
}

export function signalingHealthUrl(host: string) {
  return `http://${host}:8787/health`
}
