# BO1 Zombies browser co-op

This directory adds the two-player browser networking path without coupling it
to the decompiled native engine. It has three pieces:

```text
Browser host (player 0) ── snapshots/events ──► Durable Object ──► Browser guest (player 1)
Browser guest (player 1) ───── input frames ──► Durable Object ──► Browser host (player 0)
```

The first browser to join a room is player 0, the authoritative host. It runs
the simulation and sends compact state snapshots. The second is player 1; it
sends normalized input frames and renders the host's state. The relay does not
simulate game state, trust a claimed player ID, or allow the guest to send
snapshots. If the host leaves, the relay ends the paired match rather than
promoting a client without the authoritative world state.

## Layout

- `relay/` is the Cloudflare Worker and Durable Object. It uses the hibernation
  WebSocket API and per-socket attachments so player roles and readiness survive
  Durable Object hibernation.
- `shared/protocol.js` is the small, validated JSON wire protocol shared by the
  Worker and the browser client.
- `client/src/coop-client.js` owns the browser WebSocket lifecycle.
- `client/src/authoritative-session.js` adapts an existing fixed-tick game
  simulation to the host-authoritative flow.

## Run checks

```sh
cd browser-coop
npm install
npm run check
npm test
```

The unit tests exercise the protocol and the browser transport with a fake
WebSocket. They do not require Cloudflare credentials or a live relay.

## Deploy the relay

Install dependencies once, then set `ALLOWED_ORIGINS` to the exact comma-
separated origins that serve the browser game. The repository config permits
only Vite's usual local origins by default; change it before a production
deployment.

```sh
cd browser-coop
npm install
npx wrangler deploy --config relay/wrangler.jsonc \
  --var ALLOWED_ORIGINS:https://play.example.com
```

The WebSocket endpoint is:

```text
wss://<worker-domain>/v1/rooms/<lowercase-room-slug>
```

Room slugs must contain lowercase letters, digits, and hyphens and are limited
to 48 characters. A `GET /health` endpoint reports the protocol version for
deployment checks.

## Integrate a browser simulation

```js
import { CoopClient } from "./client/src/coop-client.js";
import { AuthoritativeCoopSession } from "./client/src/authoritative-session.js";

const client = new CoopClient({
  relayUrl: "https://your-relay.workers.dev",
  roomId: "kino-2p",
});

const session = new AuthoritativeCoopSession({
  client,
  simulation: {
    step: ({ tick, hostInput, guestInput }) => world.step(tick, hostInput, guestInput),
    createSnapshot: () => world.serialize(),
    applySnapshot: ({ tick, state }) => world.applyAuthoritativeState(tick, state),
    applyEvent: ({ tick, event }) => world.applyEvent(tick, event),
  },
  snapshotEveryTicks: 3,
});

client.connect();
session.start();

// Invoke from the game's fixed-update loop with this browser's local controls.
function fixedUpdate(tick, localInput) {
  session.tick(tick, localInput);
}
```

Wait for `client.status === "playing"` before starting a round. Player 0
simulates both players on each fixed tick. Player 1 sends its local input and
applies snapshots, so its client never becomes a competing authority.

## Protocol contracts

Every message has `{ v: 1, type: "..." }`. The guest may send only `input`;
the host may send only `snapshot` and `event` game payloads. `ready` and
`hello` are control messages available to both players. Input axes are finite
values in `[-1, 1]`, and `actions` is a uint16 bit mask.

Snapshots are intentionally game-defined JSON data. Keep them below the
48,000-character protocol limit and include only the state a remote renderer
needs. Send reliable one-off effects such as a round transition through `event`
instead of trying to infer them from two snapshots.
