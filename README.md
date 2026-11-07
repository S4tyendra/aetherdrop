# Tincan

A direct line for two. Private rooms for two people: video call, screen sharing with sound, chat, file transfer and games, all browser to browser over WebRTC. The server only does signaling; media, chat, game moves and file bytes travel peer to peer.

Live: https://tincan.devh.in

## How it fits together

| Part | Where | What it does |
|---|---|---|
| `main.go`, `hub.go` | VPS behind Caddy | WebSocket hub: room lobby, optional PIN, two members per room, relays SDP and ICE |
| `stun.go` | same binary, UDP 23478 | Minimal STUN Binding responder (IPv4 and IPv6) so peers learn their public addresses |
| `UI/` | Cloudflare Workers static assets | Astro + React + Tailwind v4 frontend |

There is no TURN relay. If two networks can't reach each other directly, the call doesn't connect, by design: no traffic ever goes through the server.

Inside a room, one `RTCPeerConnection` carries everything:

- **Media:** four transceivers (mic, camera, screen, screen audio). Tracks are swapped with `replaceTrack`, so turning media on and off never renegotiates.
- **Data:** negotiated channels for control, chat and game moves, plus a files channel and three unreliable worker channels.
- **Files:** 32 KB shards, Cauchy Reed-Solomon 16+4 per 512 KB block, so up to four lost packets per block need no resend.
- **Games:** Tic-tac-toe, Three pieces (place three, then drag one per turn), Connect four and Quoridor. Both sides validate every move.

## Develop

```sh
go run .                                   # signaling on :9032, STUN on :23478
cd UI && bun install
PUBLIC_WS_URL=ws://localhost:9032/ws bun run dev
```

Server env: `LISTEN_ADDR` (default `0.0.0.0:9032`), `STUN_ADDR` (default `[::]:23478`, `off` to disable).
Frontend env: `PUBLIC_WS_URL`, `PUBLIC_STUN_V4`, `PUBLIC_STUN_V6`.

## Build and deploy

```sh
make build             # both
make build:backend     # static linux/amd64 binary ./p2p-signal
make build:frontend    # UI/dist

make deploy            # both
make deploy:backend    # rsync to the VPS, restart the OpenRC user service, health check
make deploy:frontend   # wrangler deploy (worker "tincan", custom domain tincan.devh.in)

make shots             # regenerate public/shots/room.jpg, public/og.png and the icons from a real two-person room
```

`VPS`, `APP_DIR`, `SERVICE` and `HEALTH` can be overridden, e.g. `make deploy:backend VPS=myhost`.

The signaling host must not sit behind a proxy that asks browsers for client certificates. Caddy serves it directly with a Let's Encrypt certificate:

```caddy
p2p.example.com {
	reverse_proxy 127.0.0.1:24032
}
```
