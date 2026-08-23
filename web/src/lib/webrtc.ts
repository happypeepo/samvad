// Internet tier: a real duplex voice call over WebRTC (Opus is the
// browser's default/only audio codec for WebRTC, so no codec selection code
// is needed here — see lib/codec.ts for the BLE tier's explicit Codec2
// pipeline, which doesn't get that luxury).
//
// WebRTC media is always encrypted point-to-point via DTLS-SRTP; a TURN
// relay (if one is ever needed to traverse a hard NAT) only ever forwards
// that ciphertext. On top of that, this module runs the same Noise XX
// handshake used by every other tier over the signaling channel, purely so
// the two humans can visually compare a short fingerprint ("safety number")
// before trusting the call — an authenticated, application-level guarantee
// that doesn't depend on trusting the signaling server or any TURN relay.
import { Buffer } from 'buffer'
import { NoiseXXSession, fingerprintOf, type NoiseRole } from './noise'
import type { NoiseKeyPair } from 'noise-protocol'
import { SignalingClient, type SignalMessage } from './signaling'

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

export type CallStatus =
  | 'connecting-signaling'
  | 'verifying' // Noise handshake in progress
  | 'negotiating' // WebRTC offer/answer/ICE in progress
  | 'connected'
  | 'failed'
  | 'closed'

export interface CallSessionEvents {
  onStatusChange?(status: CallStatus): void
  onRemoteStream?(stream: MediaStream): void
  /** Fires once the Noise handshake completes — show this to the user to compare against the peer's screen. */
  onFingerprint?(localFp: string, remoteFp: string): void
  onLog?(line: string): void
}

export class CallSession {
  private signaling: SignalingClient
  private noise: NoiseXXSession
  private pc: RTCPeerConnection | null = null
  private localStream: MediaStream | null = null
  private role: NoiseRole
  private events: CallSessionEvents
  status: CallStatus = 'connecting-signaling'
  private localIdentity: NoiseKeyPair
  private remoteIdentityPublicKey: Buffer | null = null
  private pendingPeerMessages: Array<Extract<SignalMessage, { type: 'sdp' | 'ice' }>> = []

  constructor(
    signaling: SignalingClient,
    role: NoiseRole,
    localIdentity: NoiseKeyPair,
    events: CallSessionEvents = {},
  ) {
    this.signaling = signaling
    this.role = role
    this.events = events
    this.localIdentity = localIdentity
    this.noise = new NoiseXXSession(role, localIdentity)

    this.signaling.onMessage((msg) => {
      this.handleSignal(msg).catch((err) => {
        this.log(`error handling ${msg.type}: ${err}`)
        this.setStatus('failed')
      })
    })
  }

  private log(line: string) {
    this.events.onLog?.(`[call:${this.role}] ${line}`)
  }

  private setStatus(s: CallStatus) {
    this.status = s
    this.log(`status -> ${s}`)
    this.events.onStatusChange?.(s)
  }

  /** Kick off the Noise handshake + WebRTC negotiation. Call once both peers are in the signaling room. */
  async start() {
    this.setStatus('verifying')
    if (this.role === 'initiator') {
      const msg1 = this.noise.start()
      this.log('sending noise step 1')
      this.signaling.send({ type: 'noise', step: 1, payload: Buffer.from(msg1).toString('base64') })
    }
  }

  private async handleSignal(msg: SignalMessage) {
    if (msg.type === 'noise') {
      this.log(`received noise step ${msg.step}`)
      const payload = Buffer.from(msg.payload, 'base64')
      if (this.role === 'initiator') {
        // step 1 sent already; expect step 2 (e, ee, s, es), then send step 3
        if (msg.step === 2) {
          this.remoteIdentityPublicKey = Buffer.from(this.noise.readMessage(payload))
          // message 3's payload is already authenticated-encrypted (keys
          // from ee+es are mixed in by now) — piggyback our identity key on
          // it so the responder can render a matching fingerprint too.
          const msg3 = this.noise.writeMessage(this.localIdentity.publicKey)
          this.log('sending noise step 3')
          this.signaling.send({ type: 'noise', step: 3, payload: Buffer.from(msg3).toString('base64') })
          await this.onNoiseEstablished()
        }
      } else {
        // responder: step 1 received -> reply with step 2, then expect step 3
        if (msg.step === 1) {
          this.setStatus('verifying')
          this.noise.readMessage(payload)
          const msg2 = this.noise.writeMessage(this.localIdentity.publicKey)
          this.log('sending noise step 2')
          this.signaling.send({ type: 'noise', step: 2, payload: Buffer.from(msg2).toString('base64') })
        } else if (msg.step === 3) {
          this.remoteIdentityPublicKey = Buffer.from(this.noise.readMessage(payload))
          await this.onNoiseEstablished()
        }
      }
      return
    }

    if (msg.type !== 'sdp' && msg.type !== 'ice') return // peer-joined/peer-left/hello: nothing to do here

    if (!this.pc) {
      // setUpPeerConnection() used to construct `this.pc` only after
      // `await getUserMedia(...)` resolved — a mic-permission prompt (a few
      // seconds, longer with a tap-to-allow dialog on a phone) was easily
      // enough time for the other side's offer to arrive first and get
      // silently dropped here, hanging the call at 'negotiating' forever.
      // pc construction was moved earlier to close that window, but buffer
      // anything that still slips through rather than relying on timing.
      this.log(`buffering ${msg.type} — peer connection not ready yet`)
      this.pendingPeerMessages.push(msg)
      return
    }
    if (msg.type === 'sdp') {
      await this.pc.setRemoteDescription(msg.sdp)
      if (msg.sdp.type === 'offer') {
        const answer = await this.pc.createAnswer()
        await this.pc.setLocalDescription(answer)
        this.signaling.send({ type: 'sdp', sdp: answer })
      }
    } else if (msg.type === 'ice') {
      await this.pc.addIceCandidate(msg.candidate).catch(() => {
        /* benign: candidate arrived before remote description was set */
      })
    }
  }

  private async onNoiseEstablished() {
    this.log('noise handshake established')
    if (this.remoteIdentityPublicKey) {
      this.events.onFingerprint?.(
        fingerprintOf(this.localIdentity.publicKey),
        fingerprintOf(this.remoteIdentityPublicKey),
      )
    }
    await this.setUpPeerConnection()
  }

  private async setUpPeerConnection() {
    this.setStatus('negotiating')
    if (!navigator.mediaDevices?.getUserMedia) {
      // Browsers only expose getUserMedia on https:// or localhost/127.0.0.1
      // — a plain http://<lan-ip> origin (typical during dev-server testing)
      // silently has no `navigator.mediaDevices` at all. Doesn't apply to
      // the packaged native app, which always loads from Capacitor's
      // internal https://localhost scheme.
      throw new Error(
        'microphone unavailable: this page must be loaded over HTTPS or localhost ' +
          '(a plain http://<lan-ip> origin has no getUserMedia — see chrome://flags/' +
          '#unsafely-treat-insecure-origin-as-secure for LAN dev testing)',
      )
    }

    // Constructed *before* the getUserMedia await below (which can take
    // real time — a mic-permission prompt, longer still with a tap-to-allow
    // dialog on a phone) so an incoming SDP/ICE message from the other side
    // always has somewhere to land instead of hitting the `!this.pc` buffer.
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    this.pc.ontrack = (ev) => {
      this.events.onRemoteStream?.(ev.streams[0])
    }
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) this.signaling.send({ type: 'ice', candidate: ev.candidate.toJSON() })
    }
    this.pc.onconnectionstatechange = () => {
      if (this.pc?.connectionState === 'connected') this.setStatus('connected')
      else if (this.pc?.connectionState === 'failed') this.setStatus('failed')
      else if (this.pc?.connectionState === 'closed') this.setStatus('closed')
    }

    // Tracks must be attached before any buffered offer is replayed below —
    // createAnswer() reflects whatever local tracks exist *at that moment*,
    // so answering first and attaching audio after would produce a
    // track-less (one-way) answer.
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    for (const track of this.localStream.getTracks()) this.pc.addTrack(track, this.localStream)

    const buffered = this.pendingPeerMessages.splice(0)
    for (const msg of buffered) {
      this.log(`replaying buffered ${msg.type}`)
      await this.handleSignal(msg)
    }

    if (this.role === 'initiator') {
      const offer = await this.pc.createOffer()
      await this.pc.setLocalDescription(offer)
      this.signaling.send({ type: 'sdp', sdp: offer })
    }
  }

  close() {
    this.pc?.close()
    this.localStream?.getTracks().forEach((t) => t.stop())
    // Without this, the room's peer slot on the signaling server stays
    // occupied until the socket times out on its own — a same-room rejoin
    // in the meantime gets rejected as "room full".
    this.signaling.close()
    this.setStatus('closed')
  }
}
