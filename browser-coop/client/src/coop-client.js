import {
  PROTOCOL_VERSION,
  clientMessage,
  normalizeInput,
  parseWireMessage,
  validateServerMessage,
} from "../../shared/protocol.js";

function defaultWebSocketFactory(url) {
  return new WebSocket(url);
}

function listen(socket, event, handler) {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(event, handler);
    return;
  }
  socket[`on${event}`] = handler;
}

/** Build the room URL from a relay origin such as https://relay.example.com. */
export function roomWebSocketUrl(relayUrl, roomId) {
  if (typeof roomId !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(roomId)) {
    throw new TypeError("Room IDs must be lowercase URL-safe slugs up to 48 characters");
  }

  const url = new URL(relayUrl);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new TypeError("Relay URL must use http, https, ws, or wss");
  }

  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/rooms/${encodeURIComponent(roomId)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Browser-side transport. It owns no game state: player 0 simulates and sends
 * snapshots, while player 1 submits input frames and consumes those snapshots.
 * The optional webSocketFactory makes this class easy to exercise without a
 * real browser or live relay.
 */
export class CoopClient {
  #webSocketFactory;
  #socket = null;
  #listeners = new Set();
  #statusListeners = new Set();
  #sequence = 0;
  #ready = false;

  constructor({ relayUrl, roomId, webSocketFactory = defaultWebSocketFactory }) {
    this.url = roomWebSocketUrl(relayUrl, roomId);
    this.roomId = roomId;
    this.playerId = null;
    this.players = [];
    this.status = "idle";
    this.#webSocketFactory = webSocketFactory;
  }

  connect() {
    if (this.#socket) {
      throw new Error("CoopClient already has a WebSocket; create a new client to reconnect");
    }

    this.setStatus("connecting");
    const socket = this.#webSocketFactory(this.url);
    this.#socket = socket;

    listen(socket, "open", () => {
      this.setStatus("connected");
      this.send(clientMessage("hello"));
    });
    listen(socket, "message", (event) => this.handleMessage(event.data));
    listen(socket, "error", () => this.setStatus("error"));
    listen(socket, "close", (event) => {
      this.#socket = null;
      this.setStatus(event.code === 4002 ? "host-disconnected" : "closed");
    });
    return socket;
  }

  close(code = 1000, reason = "Client closed") {
    this.#socket?.close(code, reason);
  }

  onMessage(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onStatus(listener) {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  setReady(ready = true) {
    this.#ready = Boolean(ready);
    // Session setup normally happens immediately after connect(), before the
    // relay has assigned a player ID. Remember the intent and flush it from
    // the joined handler instead of losing the ready signal during the upgrade.
    if (this.playerId === null) {
      return false;
    }
    return this.send(clientMessage("ready", { ready: this.#ready }));
  }

  sendInput(tick, input) {
    if (this.playerId !== 1) {
      return false;
    }
    return this.send(clientMessage("input", {
      seq: this.nextSequence(),
      tick,
      input: normalizeInput(input),
    }));
  }

  sendSnapshot(tick, state) {
    if (this.playerId !== 0) {
      return false;
    }
    return this.send(clientMessage("snapshot", {
      seq: this.nextSequence(),
      tick,
      state,
    }));
  }

  sendEvent(tick, event) {
    if (this.playerId !== 0) {
      return false;
    }
    return this.send(clientMessage("event", {
      seq: this.nextSequence(),
      tick,
      event,
    }));
  }

  send(message) {
    if (!this.#socket || this.#socket.readyState !== 1) {
      return false;
    }
    this.#socket.send(JSON.stringify(message));
    return true;
  }

  nextSequence() {
    const next = this.#sequence;
    this.#sequence = (this.#sequence + 1) & 0x7fffffff;
    return next;
  }

  handleMessage(payload) {
    const parsed = parseWireMessage(payload);
    if (!parsed.ok) {
      this.setStatus("protocol-error");
      return;
    }

    const validated = validateServerMessage(parsed.value);
    if (!validated.ok) {
      this.setStatus("protocol-error");
      return;
    }

    const message = validated.value;
    if (message.type === "joined") {
      this.playerId = message.playerId;
      this.setStatus("waiting");
      if (this.#ready) {
        this.send(clientMessage("ready", { ready: true }));
      }
    } else if (message.type === "room-state") {
      this.players = message.players;
      if (message.players.length === 2 && message.players.every((player) => player.ready)) {
        this.setStatus("playing");
      } else if (this.playerId !== null) {
        this.setStatus("waiting");
      }
    } else if (message.type === "peer-left") {
      this.setStatus("waiting");
    } else if (message.type === "match-ended") {
      this.setStatus("host-disconnected");
    }

    for (const listener of this.#listeners) {
      listener(message);
    }
  }

  setStatus(status) {
    if (this.status === status) {
      return;
    }
    this.status = status;
    for (const listener of this.#statusListeners) {
      listener(status);
    }
  }
}

export { PROTOCOL_VERSION };
