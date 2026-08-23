// SAMVAD signaling server — internet tier only.
//
// This process never sees voice content or key material in the clear that
// matters: it relays WebRTC SDP/ICE (needed for NAT traversal, standard
// practice) and opaque Noise handshake bytes between exactly two peers in a
// "room". It cannot derive the Noise session key (that requires each
// device's private key) and never holds a WebRTC media key (DTLS negotiates
// those directly between the two browsers). If this box were compromised, an
// attacker could see *that* two peers are talking and *when* (metadata),
// exactly as flagged in the SAMVAD threat model — not the content.
import { WebSocketServer } from 'ws'
import { createServer } from 'http'

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }))
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server: httpServer })

/** @type {Map<string, Set<import('ws').WebSocket>>} */
const rooms = new Map()

function roomOf(ws) {
  return ws._room
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const room = url.searchParams.get('room')
  if (!room) {
    ws.close(4000, 'missing ?room=')
    return
  }

  let peers = rooms.get(room)
  if (!peers) {
    peers = new Set()
    rooms.set(room, peers)
  }
  if (peers.size >= 2) {
    ws.close(4001, 'room full')
    return
  }
  peers.add(ws)
  ws._room = room

  const others = () => [...peers].filter((p) => p !== ws && p.readyState === ws.OPEN)

  console.log(`[room ${room}] peer joined (${peers.size}/2)`)
  for (const other of others()) other.send(JSON.stringify({ type: 'peer-joined' }))

  ws.on('message', (data) => {
    // Pure relay: forward whatever the two peers send each other verbatim
    // (SDP offer/answer, ICE candidates, Noise handshake frames).
    for (const other of others()) other.send(data.toString())
  })

  ws.on('close', () => {
    peers.delete(ws)
    if (peers.size === 0) rooms.delete(room)
    console.log(`[room ${room}] peer left (${peers.size}/2)`)
    for (const other of others()) other.send(JSON.stringify({ type: 'peer-left' }))
  })
})

httpServer.listen(PORT, () => {
  console.log(`SAMVAD signaling server listening on :${PORT}`)
})
