import { DurableObject } from "cloudflare:workers";
import {
  PROTOCOL_VERSION,
  ROOM_CAPACITY,
  parseWireMessage,
  serverMessage,
  validateClientMessage,
} from "../../shared/protocol.js";

const ROOM_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const HOST_DISCONNECTED_CLOSE_CODE = 4002;
const INVALID_CLIENT_CLOSE_CODE = 4003;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isOriginAllowed(request, env) {
  const origin = request.headers.get("Origin");
  return !origin || allowedOrigins(env).includes(origin);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !isOriginAllowed(request, env)) {
    return {};
  }

  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "GET, OPTIONS",
  };
}

function isWebSocketUpgrade(request) {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

function roomIdFromPath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "v1" || parts[1] !== "rooms") {
    return null;
  }

  try {
    const roomId = decodeURIComponent(parts[2]);
    return ROOM_ID_PATTERN.test(roomId) ? roomId : null;
  } catch {
    return null;
  }
}

/**
 * Public Worker. It validates the public upgrade request then routes every room
 * to exactly one Durable Object instance. Game messages never live here.
 */
export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, protocol: PROTOCOL_VERSION }, 200, headers);
    }

    const roomId = roomIdFromPath(url.pathname);
    if (!roomId) {
      return json({ error: "not_found" }, 404, headers);
    }

    if (!isOriginAllowed(request, env)) {
      return json({ error: "origin_not_allowed" }, 403, headers);
    }

    if (!isWebSocketUpgrade(request)) {
      return json({ error: "websocket_upgrade_required" }, 426, headers);
    }

    const forwardedHeaders = new Headers(request.headers);
    // This header is set by the public Worker, never accepted from the client.
    forwardedHeaders.set("x-bo1-room-id", roomId);
    const roomRequest = new Request(request, { headers: forwardedHeaders });
    const id = env.ROOM_RELAY.idFromName(`bo1-coop:${roomId}`);
    return env.ROOM_RELAY.get(id).fetch(roomRequest);
  },
};

/**
 * A hibernatable, room-scoped WebSocket relay. Player 0 is the host and is the
 * only client allowed to send snapshots or game events. Player 1 can only send
 * validated input frames. Attachments retain roles and ready state if the
 * Durable Object hibernates between packets.
 */
export class RoomRelay extends DurableObject {
  async fetch(request) {
    const roomId = request.headers.get("x-bo1-room-id");
    if (!roomId || !ROOM_ID_PATTERN.test(roomId) || !isWebSocketUpgrade(request)) {
      return json({ error: "invalid_room_request" }, 400);
    }

    const members = this.members();
    if (members.length >= ROOM_CAPACITY) {
      return json({ error: "room_full" }, 409);
    }

    const playerId = this.nextPlayerId(members);
    if (playerId === null) {
      return json({ error: "room_full" }, 409);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const connection = {
      roomId,
      playerId,
      ready: false,
      joinedAt: Date.now(),
    };

    this.ctx.acceptWebSocket(server, [`player:${playerId}`]);
    server.serializeAttachment(connection);

    this.send(server, serverMessage("joined", {
      roomId,
      playerId,
      capacity: ROOM_CAPACITY,
    }));
    this.broadcastRoomState();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, payload) {
    const connection = this.connectionFor(socket);
    if (!connection) {
      socket.close(INVALID_CLIENT_CLOSE_CODE, "Unknown room connection");
      return;
    }

    const parsed = parseWireMessage(payload);
    if (!parsed.ok) {
      this.protocolError(socket, parsed.error);
      return;
    }

    const validated = validateClientMessage(parsed.value);
    if (!validated.ok) {
      this.protocolError(socket, validated.error);
      return;
    }

    const message = validated.value;
    switch (message.type) {
      case "hello":
        this.send(socket, serverMessage("room-state", { players: this.publicMembers() }));
        return;
      case "ready":
        socket.serializeAttachment({ ...connection, ready: message.ready });
        this.broadcastRoomState();
        this.startMatchIfReady();
        return;
      case "input":
        if (connection.playerId !== 1) {
          this.protocolError(socket, "only_guest_may_send_input");
          return;
        }
        if (!this.isMatchReady()) {
          this.protocolError(socket, "match_not_ready");
          return;
        }
        this.sendToPlayer(0, serverMessage("input", {
          playerId: 1,
          seq: message.seq,
          tick: message.tick,
          input: message.input,
        }));
        return;
      case "snapshot":
        if (connection.playerId !== 0) {
          this.protocolError(socket, "only_host_may_send_snapshots");
          return;
        }
        if (!this.isMatchReady()) {
          this.protocolError(socket, "match_not_ready");
          return;
        }
        this.sendToPlayer(1, serverMessage("snapshot", {
          playerId: 0,
          seq: message.seq,
          tick: message.tick,
          state: message.state,
        }));
        return;
      case "event":
        if (connection.playerId !== 0) {
          this.protocolError(socket, "only_host_may_send_events");
          return;
        }
        if (!this.isMatchReady()) {
          this.protocolError(socket, "match_not_ready");
          return;
        }
        this.sendToPlayer(1, serverMessage("event", {
          playerId: 0,
          seq: message.seq,
          tick: message.tick,
          event: message.event,
        }));
        return;
      default:
        this.protocolError(socket, "unsupported_message_type");
    }
  }

  webSocketClose(socket) {
    const connection = this.connectionFor(socket);
    if (!connection) {
      return;
    }

    if (connection.playerId === 0) {
      // A replacement host would not have the authoritative simulation state.
      // End the paired session instead of silently promoting or swapping roles.
      for (const member of this.members(socket)) {
        this.send(member.socket, serverMessage("match-ended", { reason: "host_disconnected" }));
        member.socket.close(HOST_DISCONNECTED_CLOSE_CODE, "Host disconnected");
      }
      return;
    }

    this.sendToPlayer(0, serverMessage("peer-left", { playerId: 1 }));
    this.broadcastRoomState();
  }

  webSocketError(socket) {
    socket.close(INVALID_CLIENT_CLOSE_CODE, "WebSocket error");
  }

  members(exceptSocket) {
    return this.ctx
      .getWebSockets()
      .filter((socket) => socket !== exceptSocket)
      .map((socket) => ({ socket, connection: this.connectionFor(socket) }))
      .filter((member) => member.connection !== null);
  }

  connectionFor(socket) {
    const attachment = socket.deserializeAttachment();
    if (
      !attachment ||
      typeof attachment !== "object" ||
      !ROOM_ID_PATTERN.test(attachment.roomId) ||
      !Number.isInteger(attachment.playerId) ||
      attachment.playerId < 0 ||
      attachment.playerId >= ROOM_CAPACITY ||
      typeof attachment.ready !== "boolean"
    ) {
      return null;
    }

    return attachment;
  }

  nextPlayerId(members) {
    const occupied = new Set(members.map((member) => member.connection.playerId));
    for (let playerId = 0; playerId < ROOM_CAPACITY; playerId += 1) {
      if (!occupied.has(playerId)) {
        return playerId;
      }
    }
    return null;
  }

  publicMembers() {
    return this.members()
      .map(({ connection }) => ({ playerId: connection.playerId, ready: connection.ready }))
      .sort((left, right) => left.playerId - right.playerId);
  }

  broadcastRoomState() {
    const message = serverMessage("room-state", { players: this.publicMembers() });
    for (const { socket } of this.members()) {
      this.send(socket, message);
    }
  }

  startMatchIfReady() {
    if (!this.isMatchReady()) {
      return;
    }

    for (const { socket } of this.members()) {
      this.send(socket, serverMessage("match-start", { tick: 0 }));
    }
  }

  isMatchReady() {
    const members = this.members();
    return members.length === ROOM_CAPACITY && members.every(({ connection }) => connection.ready);
  }

  sendToPlayer(playerId, message) {
    const member = this.members().find((entry) => entry.connection.playerId === playerId);
    if (member) {
      this.send(member.socket, message);
    }
  }

  protocolError(socket, code) {
    this.send(socket, serverMessage("error", { code }));
  }

  send(socket, message) {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A peer can close between getWebSockets() and send(). The close handler
      // will clean up room state; the relay does not need to retry stale data.
    }
  }
}
