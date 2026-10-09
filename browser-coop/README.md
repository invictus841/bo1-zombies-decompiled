# BO1 Zombies co-op for vel.gg

Two-player co-op for the browser BO1 Zombies at [vel.gg/bo1z](https://vel.gg/bo1z/): one player hosts, the other
joins with an invite link. It works on the same Wi-Fi or across the internet.

> **Status:** the relay is deployed and tested, and the host side works in the real game (the patched engine loads,
> waits for player 2 and connects to the relay). Player 2 joining has not been tested end to end yet: if it fails, the
> Co-op card shows the error, and `__bo1zCoop.log` in the browser console (F12) has the details.

It has two parts:

- **A Chrome extension** (`extension/`). Both players install it. It only runs on vel.gg, and only changes anything
  when you click **Host** or open an invite link; otherwise the site works exactly as before.
- **A relay** (`relay/`), a small Cloudflare Worker that passes the game's packets between the two browsers.

## Play

### 1. Install the extension (both players, once)

1. Download this repository (green **Code** button → **Download ZIP**) and unzip it, or `git clone` it.
2. In Chrome, open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `browser-coop/extension` folder.

### 2. Host

1. Open [vel.gg/bo1z](https://vel.gg/bo1z/). A **Co-op** card appears in the top-right corner.
2. Click **Host a game**, then **Copy invite link** and send it to player 2.
3. Pick a map. Player 2 is taken to the same map automatically.
4. When the map has loaded, the game waits for player 2 (or click **Start without player 2**). Once the card shows
   "Player 2: in the game", click the game to start.

### 3. Join

1. Open the invite link (or paste it, or the room code, into the card's **Join** box on vel.gg/bo1z).
2. Press any key when the page asks, wait for the map to load and for "In the host's game", then click the game.

### Controller (PS5, PS4, Xbox)

Plug the controller in (USB or Bluetooth) and press any button on it: the Co-op card shows it under
"Controller". It works in solo games too. Click the game once with the mouse to start (browsers do not let a
controller start the sound or capture the mouse), then play with the controller.

| Button (PlayStation / Xbox) | Action |
| --- | --- |
| Left stick / L3 | move (analog) / sprint |
| Right stick | aim (speed: the card's **Aim −** / **Aim +**) |
| R2 / RT | fire |
| L2 / LT | aim down sights |
| R1 / RB | grenade |
| L1 / LB | special grenade (monkey bomb, ...) |
| Square / X | reload; hold to use, buy, open, revive |
| Cross / A | jump |
| Circle / B | crouch; hold to go prone |
| Triangle / Y | switch weapon |
| R3 | melee |
| D-pad | equipment slots 1-4 |
| Options / Menu | pause menu (in menus: stick moves the cursor, Cross clicks, Circle goes back) |
| Create / View | scoreboard |

The controller uses the engine's own actions through the extension's patched engine, so when it is on the engine is
patched in solo games too. **Turn controller off** in the card (then reload) to leave solo games untouched.

The host's game is the real one: zombies, rounds and points all live on the host's computer, and player 2 joins it
like in the original game. The host should keep their tab open for the whole game; switching tabs is fine.

## How it works

The game on vel.gg is the decompiled engine compiled to WebAssembly. Its multiplayer code is all still there (server,
client, netchan), but the network layer was cut: a player talks to the game server through two in-memory "loopback"
rings (16 packet slots each) instead of sockets. The extension tunnels those rings between two browsers:

```text
Host browser                                        Guest browser
 server ── ring P (player 2's replies) ──► extension ─► relay ─► extension ─► ring 0 ──► client (player 2)
 server ◄── ring Q (player 2's packets) ◄─ extension ◄─ relay ◄─ extension ◄─ ring 1 ◄── client (player 2)
```

- **Host.** The server sends to a loopback address by writing ring number `port` in memory. The extension allocates
  memory and chooses a port P so that ring P lands inside it. Packets from player 2 are tagged with port P, so the
  server treats them as a second player, and its replies land in memory the extension reads. A short patch to
  `NET_GetLoopPacket` makes the server also read ring Q, which only the extension writes.
- **Guest.** The game needs its own server to load a map (animations and scripts come from it). So the guest loads the
  map normally, then the extension freezes the guest's own server (a patch to `SV_Frame`) and runs
  `connect LOCALHOST`. The guest's client now sends to ring 1, which the extension forwards to the host, and reads
  ring 0, where the extension writes the host's replies.
- **The patch.** When co-op is on, the extension adds two short prologues to the engine as the page loads it (about
  100 bytes, done in the browser in a few milliseconds). They do nothing until the extension sets one of three
  "mailbox" words: a console command to run, "freeze the local server", and "also read ring Q".
- **The relay.** A Cloudflare Durable Object per room, holding one host and one guest WebSocket. It forwards binary
  packet batches and small JSON messages, and never looks inside them.

All engine addresses are in `extension/src/layout.js`, for the exact engine build vel.gg serves (identified by its
SHA-256). If vel.gg ever ships a different engine, the extension notices, says so in its card, and leaves the game
solo instead of patching something it does not know.

## Develop

```sh
cd browser-coop
npm install
npm run build        # extension/src -> extension/dist/coop-main.js (commit the result)
npm test             # protocol, packet rings, engine patch and the relay running locally
npm run dev:relay    # local relay on http://localhost:8787
npm run deploy:relay # deploy the relay to Cloudflare (needs `npx wrangler login` once)
```

`BO1Z_ENGINE_WASM=/path/to/KisakBlack-web.wasm npm test` also checks the patch against the real engine file.

`node e2e/coop.mjs` plays a real two-player game on vel.gg with two Chrome profiles (the first run downloads the
map, about 900 MB per profile). It uses the local relay unless `RELAY=https://...` is set.

The extension talks to `https://bo1-zombies-coop-relay.macosapp.workers.dev` by default (`DEFAULT_RELAY` in
`extension/src/main.js`). To use your own relay, deploy it and change that line, or set it in the browser console on
vel.gg: `localStorage.setItem("bo1z-coop-relay", "https://your-relay.workers.dev")`.

### Relay protocol

`wss://<relay>/v1/rooms/<room>?role=host|guest&v=2`. Text frames are JSON objects with a string `t`: the relay sends
`welcome {role, peer}`, `peer {present}` and `error {code}`; anything else (`info`, `state`, `ping`, `pong`) is
forwarded to the other player. Binary frames are packet batches (`shared/protocol.js`):
`u8 version | u8 kind | u16 count | count × (u16 length | bytes)`, each packet at most 1264 bytes.
A new connection for a role replaces the old one (a reload). The relay allows only `https://vel.gg` as a browser origin
(`ALLOWED_ORIGINS` in `relay/wrangler.jsonc`).
