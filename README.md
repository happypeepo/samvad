# SAMVAD — Secure Ad-hoc Mesh Voice for Assured Defense

A voice-first, offline-capable communicator: peer-to-peer, no mandatory
server, with an automatic transport fallback — internet first, degrading to
a Bluetooth Low Energy mesh when there's no internet available. Every
packet is end-to-end encrypted regardless of which transport is active.

Primary use case: disaster relief and off-grid/humanitarian response.
Secondary, dual-use case: squad-level comms where issuing certified
tactical radios to every operator isn't practical.

## Status

Two tiers are implemented and verified working end-to-end on real
hardware:

- **Internet tier** — live duplex voice call over WebRTC (Opus), with a
  Noise XX handshake run in parallel over the signaling channel so both
  parties can visually confirm a fingerprint before trusting the call.
- **BLE mesh tier** — push-to-talk voice notes over a direct Bluetooth LE
  connection. Every device runs both GATT roles at once (central + a
  custom native peripheral/GATT-server plugin), so two phones can find and
  connect to each other with no prior pairing. Payloads are Noise-encrypted
  before they touch the radio.

A third tier (RF/LoRa mesh, for when neither internet nor BLE range is
available) is scoped as a documented roadmap item, not built here — see
"Known limitations" below.

## Repo layout

```
server/   Node.js WebSocket signaling server (internet tier only —
          relays WebRTC SDP/ICE and opaque Noise handshake bytes between
          exactly two peers; never sees anything else)
web/      The app itself: Vite + React + TypeScript, wrapped with
          Capacitor for the Android build. This is the whole client —
          web/android is the native shell around the same code.
```

## Running it

```bash
# signaling server
cd server && npm install && npm start

# web app (also usable directly in a browser for the internet tier)
cd web && npm install && npm run dev
```

For the Android build:

```bash
cd web
npm run build
npx cap sync android
cd android && ./gradlew assembleDebug   # or assembleRelease, with a keystore.properties in place
```

BLE mesh only works from the native Android build — browsers only expose
BLE Central mode (scanning), never peripheral/advertising, on any platform.

## Codec

The internet tier uses Opus (WebRTC's default). The BLE tier's codec
module (`web/src/lib/codec.ts`) is currently a placeholder built on the
browser's WebCodecs `AudioEncoder` pinned to a low Opus bitrate — Codec2
(700–1200 bps, the actual target for a bandwidth-starved BLE/RF link) needs
`libcodec2` cross-compiled to WASM, which isn't wired up yet. Swapping it
in only touches that one file.

## Known limitations

- The RF/LoRa tier is not implemented — internet and BLE only.
- BLE is single-hop (two directly-connected devices), not yet a
  multi-hop flooding relay across a larger mesh.
- The Noise identity keypair is stored in browser `localStorage`, keyed
  per-origin — clearing app data or reinstalling generates a new identity.
