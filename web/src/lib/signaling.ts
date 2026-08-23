// Thin client for the internet-tier signaling server. It relays two kinds
// of opaque frames between exactly two peers in a "room": WebRTC SDP/ICE,
// and Noise XX handshake bytes. The server never sees anything else.
export type SignalMessage =
  | { type: 'peer-joined' }
  | { type: 'peer-left' }
  | { type: 'hello'; publicKey: string /* base64 identity public key, for deterministic role tie-break */ }
  | { type: 'sdp'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; candidate: RTCIceCandidateInit }
  | { type: 'noise'; step: number; payload: string /* base64 */ }

export class SignalingClient {
  private ws: WebSocket
  private handlers = new Set<(msg: SignalMessage) => void>()
  readonly ready: Promise<void>

  constructor(url: string, room: string) {
    this.ws = new WebSocket(`${url}?room=${encodeURIComponent(room)}`)
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true })
      this.ws.addEventListener('error', () => reject(new Error('signaling connection failed')), {
        once: true,
      })
    })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data) as SignalMessage
      for (const h of this.handlers) h(msg)
    })
  }

  onMessage(handler: (msg: SignalMessage) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  send(msg: SignalMessage) {
    this.ws.send(JSON.stringify(msg))
  }

  close() {
    this.ws.close()
  }
}

/** Reachability probe used by the transport-selection state machine. */
export async function isInternetTierReachable(healthUrl: string, timeoutMs = 2500): Promise<boolean> {
  if (!navigator.onLine) return false
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(healthUrl, { signal: controller.signal })
    clearTimeout(t)
    return res.ok
  } catch {
    return false
  }
}
