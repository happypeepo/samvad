// Transport fallback cascade (Section 2.1 of the architecture doc, minus
// the RF/LoRa tier we're not building today): try the internet tier first,
// fall back to BLE mesh when it's unreachable. Every packet on either tier
// is E2EE via the same Noise XX handshake (lib/noise.ts) — this module only
// decides *which pipe* to use, never touches key material itself.
import { isInternetTierReachable } from './signaling'

export type Tier = 'internet' | 'ble' | 'searching'

export interface TransportManagerOptions {
  signalingHealthUrl: string
  pollIntervalMs?: number
  onTierChange?(tier: Tier): void
}

export class TransportManager {
  private opts: Required<TransportManagerOptions>
  private timer: ReturnType<typeof setInterval> | null = null
  private currentTier: Tier = 'searching'

  constructor(opts: TransportManagerOptions) {
    this.opts = { pollIntervalMs: 5000, onTierChange: () => {}, ...opts }
  }

  get tier() {
    return this.currentTier
  }

  start() {
    this.check()
    this.timer = setInterval(() => this.check(), this.opts.pollIntervalMs)
    window.addEventListener('online', () => this.check())
    window.addEventListener('offline', () => this.check())
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  private async check() {
    const reachable = await isInternetTierReachable(this.opts.signalingHealthUrl)
    const next: Tier = reachable ? 'internet' : 'ble'
    if (next !== this.currentTier) {
      this.currentTier = next
      this.opts.onTierChange(next)
    }
  }
}
