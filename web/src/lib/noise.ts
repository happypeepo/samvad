// Unified E2EE key-exchange layer for SAMVAD, used identically by every
// transport tier: a Noise_XX_25519_ChaChaPoly_BLAKE2b handshake establishes
// a session key directly between the two endpoint devices. Whatever relays
// the resulting ciphertext (a WebRTC path, a BLE hop) never sees this key.
//
// XX is used (rather than KK/IK) because it doesn't require the peer's
// static public key to be known ahead of time — devices that have never met
// can still mutually authenticate, discovering each other's identity keys
// as part of the handshake itself. That matches the "no prior pairing"
// requirement of an ad-hoc mesh.
import { Buffer } from 'buffer'
import noise, { type NoiseKeyPair } from 'noise-protocol'
import createCipher from 'noise-protocol/cipher'
import createCipherState from 'noise-protocol/cipher-state'

const cipher = createCipher()
const cipherState = createCipherState({ cipher })

// v2: v1 stored keys via `keys.publicKey.toString('base64')`, but keygen()
// returns sodium-universal's internal buffer type, not our imported Buffer
// — plain Uint8Array.toString() silently ignores the 'base64' argument and
// serializes to comma-separated decimal bytes instead. Anything round-tripped
// through v1 storage came back the wrong byte length. Bumping the key so
// stale corrupted identities are discarded rather than reloaded.
const DEVICE_IDENTITY_STORAGE_KEY = 'samvad.deviceIdentity.v2'

/** The device's long-term Curve25519 identity keypair, persisted locally. */
export function loadOrCreateDeviceIdentity(): NoiseKeyPair {
  const stored = localStorage.getItem(DEVICE_IDENTITY_STORAGE_KEY)
  if (stored) {
    const { publicKey, secretKey } = JSON.parse(stored)
    return {
      publicKey: Buffer.from(publicKey, 'base64'),
      secretKey: Buffer.from(secretKey, 'base64'),
    }
  }
  const keys = noise.keygen()
  localStorage.setItem(
    DEVICE_IDENTITY_STORAGE_KEY,
    JSON.stringify({
      // Buffer.from(...) here is load-bearing, not decorative: keys.publicKey
      // is sodium-universal's buffer type, and its .toString('base64') is
      // NOT the same method as our Buffer's — see note above.
      publicKey: Buffer.from(keys.publicKey).toString('base64'),
      secretKey: Buffer.from(keys.secretKey).toString('base64'),
    }),
  )
  return keys
}

export type NoiseRole = 'initiator' | 'responder'

/**
 * One Noise XX handshake between this device and a single peer, followed by
 * transport-phase ChaCha20-Poly1305 encrypt/decrypt once the handshake
 * completes ("split", in Noise terminology).
 *
 * Usage (initiator):
 *   const msg1 = session.start()                 // -> send msg1 to peer
 *   session.readMessage(msg2FromPeer)             // <- receive msg2
 *   const msg3 = session.writeMessage()           // -> send msg3, now established
 *
 * Usage (responder):
 *   session.readMessage(msg1FromPeer)             // <- receive msg1
 *   const msg2 = session.writeMessage()           // -> send msg2
 *   session.readMessage(msg3FromPeer)             // <- receive msg3, now established
 */
export class NoiseXXSession {
  private state: ReturnType<typeof noise.initialize>
  private txState: Buffer | null = null
  private rxState: Buffer | null = null
  readonly role: NoiseRole

  established = false

  constructor(role: NoiseRole, staticKeys: NoiseKeyPair) {
    this.role = role
    this.state = noise.initialize('XX', role === 'initiator', Buffer.alloc(0), staticKeys)
  }

  /** Initiator-only: produce handshake message 1 ("-> e"). */
  start(): Uint8Array {
    if (this.role !== 'initiator') throw new Error('only the initiator calls start()')
    return this.writeMessage()
  }

  writeMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    const out = Buffer.alloc(payload.byteLength + 512)
    const split = noise.writeMessage(this.state, Buffer.from(payload), out)
    const msg = Buffer.from(out.subarray(0, noise.writeMessage.bytes))
    if (split) this.finish(split.tx, split.rx)
    return msg
  }

  readMessage(message: Uint8Array): Uint8Array {
    const out = Buffer.alloc(message.byteLength)
    const split = noise.readMessage(this.state, Buffer.from(message), out)
    const payload = Buffer.from(out.subarray(0, noise.readMessage.bytes))
    if (split) this.finish(split.tx, split.rx)
    return payload
  }

  private finish(tx: Buffer, rx: Buffer) {
    this.txState = tx
    this.rxState = rx
    this.established = true
    // best-effort: the peer's static key, once the state carried it, isn't
    // re-exposed by this library post-split, so we capture the fingerprint
    // the caller supplies out of band (see PeerIdentity in transport.ts).
    noise.destroy(this.state)
  }

  /** Encrypt for the peer using this session's transport key. */
  encrypt(plaintext: Uint8Array, associatedData: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (!this.txState) throw new Error('handshake not complete')
    const out = Buffer.alloc(plaintext.byteLength + cipherState.MACLEN)
    cipherState.encryptWithAd(this.txState, out, Buffer.from(associatedData), Buffer.from(plaintext))
    return new Uint8Array(out)
  }

  /** Decrypt a packet received from the peer. Throws on tamper/auth failure. */
  decrypt(ciphertext: Uint8Array, associatedData: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (!this.rxState) throw new Error('handshake not complete')
    const out = Buffer.alloc(ciphertext.byteLength - cipherState.MACLEN)
    cipherState.decryptWithAd(this.rxState, out, Buffer.from(associatedData), Buffer.from(ciphertext))
    return new Uint8Array(out)
  }
}

/** Short human-verifiable fingerprint of a public key (safety-number style). */
export function fingerprintOf(publicKey: Uint8Array): string {
  const hex = Buffer.from(publicKey).toString('hex')
  return (hex.match(/.{1,4}/g) ?? []).slice(0, 8).join(' ')
}
