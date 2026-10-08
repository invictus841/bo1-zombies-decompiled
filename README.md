# BO1 Zombies

Decompiled engine code for Black Ops 1 Zombies, so mods can change the engine itself, not just scripts and maps.

![](images/1.webp)

![](images/2.webp)

## Browser co-op relay

The native engine remains the primary project. A standalone, browser-facing two-player
co-op networking layer lives in [`browser-coop/`](browser-coop/). It uses a
Cloudflare Durable Object as a room-scoped WebSocket relay: player 0 is the
authoritative host, and player 1 sends inputs while receiving host snapshots.

See [`browser-coop/README.md`](browser-coop/README.md) for the protocol,
deployment steps, and the small client adapter used to connect a browser game.
