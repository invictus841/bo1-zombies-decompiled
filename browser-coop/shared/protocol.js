/**
 * The protocol deliberately carries inputs in one direction and snapshots in
 * the other. The relay assigns player IDs; client-supplied player IDs are never
 * used. Keeping this file dependency-free lets the browser and Worker agree on
 * validation without a build-time package boundary.
 */
export const PROTOCOL_VERSION = 1;
export const ROOM_CAPACITY = 2;
export const MAX_WIRE_CHARS = 48_000;

export const NEUTRAL_INPUT = Object.freeze({
  moveX: 0,
  moveY: 0,
  lookX: 0,
  lookY: 0,
  actions: 0,
});

const INPUT_KEYS = ["moveX", "moveY", "lookX", "lookY", "actions"];
const MAX_SEQUENCE = 0x7fffffff;
const MAX_TICK = 0x7fffffff;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerInRange(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isFiniteInRange(value, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isValidProtocolVersion(value) {
  return value === PROTOCOL_VERSION;
}

function isValidInput(input) {
  if (!isRecord(input) || Object.keys(input).length !== INPUT_KEYS.length) {
    return false;
  }

  return (
    isFiniteInRange(input.moveX, -1, 1) &&
    isFiniteInRange(input.moveY, -1, 1) &&
    isFiniteInRange(input.lookX, -1, 1) &&
    isFiniteInRange(input.lookY, -1, 1) &&
    isIntegerInRange(input.actions, 0, 0xffff)
  );
}

function isValidEvent(event) {
  return (
    isRecord(event) &&
    typeof event.kind === "string" &&
    event.kind.length > 0 &&
    event.kind.length <= 64 &&
    (!Object.hasOwn(event, "data") || isJsonValue(event.data))
  );
}

/** Returns whether a value can be safely re-serialized as JSON. */
export function isJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.entries(value).every(([key, entry]) => key.length <= 128 && isJsonValue(entry));
}

/**
 * Parse a browser/Worker WebSocket payload before dispatching it. A character
 * limit is enforced before JSON.parse so a malformed client cannot make a room
 * spend unbounded CPU parsing a message.
 */
export function parseWireMessage(payload) {
  if (typeof payload !== "string") {
    return { ok: false, error: "binary_messages_are_not_supported" };
  }

  if (payload.length === 0 || payload.length > MAX_WIRE_CHARS) {
    return { ok: false, error: "message_too_large" };
  }

  try {
    const value = JSON.parse(payload);
    return isRecord(value)
      ? { ok: true, value }
      : { ok: false, error: "message_must_be_an_object" };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}

/** Validate a message received by the Durable Object from a browser. */
export function validateClientMessage(message) {
  if (!isRecord(message) || !isValidProtocolVersion(message.v) || typeof message.type !== "string") {
    return { ok: false, error: "invalid_message" };
  }

  switch (message.type) {
    case "hello":
      return { ok: true, value: message };
    case "ready":
      return typeof message.ready === "boolean"
        ? { ok: true, value: message }
        : { ok: false, error: "invalid_ready" };
    case "input":
      return isIntegerInRange(message.seq, 0, MAX_SEQUENCE) &&
        isIntegerInRange(message.tick, 0, MAX_TICK) &&
        isValidInput(message.input)
        ? { ok: true, value: message }
        : { ok: false, error: "invalid_input" };
    case "snapshot":
      return isIntegerInRange(message.seq, 0, MAX_SEQUENCE) &&
        isIntegerInRange(message.tick, 0, MAX_TICK) &&
        isJsonValue(message.state)
        ? { ok: true, value: message }
        : { ok: false, error: "invalid_snapshot" };
    case "event":
      return isIntegerInRange(message.seq, 0, MAX_SEQUENCE) &&
        isIntegerInRange(message.tick, 0, MAX_TICK) &&
        isValidEvent(message.event)
        ? { ok: true, value: message }
        : { ok: false, error: "invalid_event" };
    default:
      return { ok: false, error: "unknown_message_type" };
  }
}

/** Validate a message received by the browser from the Durable Object. */
export function validateServerMessage(message) {
  if (!isRecord(message) || !isValidProtocolVersion(message.v) || typeof message.type !== "string") {
    return { ok: false, error: "invalid_server_message" };
  }

  switch (message.type) {
    case "joined":
      return typeof message.roomId === "string" &&
        isIntegerInRange(message.playerId, 0, ROOM_CAPACITY - 1) &&
        message.capacity === ROOM_CAPACITY
        ? { ok: true, value: message }
        : { ok: false, error: "invalid_joined" };
    case "room-state":
      return Array.isArray(message.players) &&
        message.players.length <= ROOM_CAPACITY &&
        message.players.every(
          (player) =>
            isRecord(player) &&
            isIntegerInRange(player.playerId, 0, ROOM_CAPACITY - 1) &&
            typeof player.ready === "boolean",
        )
        ? { ok: true, value: message }
        : { ok: false, error: "invalid_room_state" };
    case "match-start":
      return isIntegerInRange(message.tick, 0, MAX_TICK)
        ? { ok: true, value: message }
        : { ok: false, error: "invalid_match_start" };
    case "input":
      return message.playerId === 1 &&
        isIntegerInRange(message.seq, 0, MAX_SEQUENCE) &&
        isIntegerInRange(message.tick, 0, MAX_TICK) &&
        isValidInput(message.input)
        ? { ok: true, value: message }
        : { ok: false, error: "invalid_relayed_input" };
    case "snapshot":
      return message.playerId === 0 &&
        isIntegerInRange(message.seq, 0, MAX_SEQUENCE) &&
        isIntegerInRange(message.tick, 0, MAX_TICK) &&
        isJsonValue(message.state)
        ? { ok: true, value: message }
        : { ok: false, error: "invalid_relayed_snapshot" };
    case "event":
      return message.playerId === 0 &&
        isIntegerInRange(message.seq, 0, MAX_SEQUENCE) &&
        isIntegerInRange(message.tick, 0, MAX_TICK) &&
        isValidEvent(message.event)
        ? { ok: true, value: message }
        : { ok: false, error: "invalid_relayed_event" };
    case "peer-left":
      return isIntegerInRange(message.playerId, 0, ROOM_CAPACITY - 1)
        ? { ok: true, value: message }
        : { ok: false, error: "invalid_peer_left" };
    case "match-ended":
      return typeof message.reason === "string"
        ? { ok: true, value: message }
        : { ok: false, error: "invalid_match_ended" };
    case "error":
      return typeof message.code === "string"
        ? { ok: true, value: message }
        : { ok: false, error: "invalid_error" };
    default:
      return { ok: false, error: "unknown_server_message_type" };
  }
}

export function clientMessage(type, fields = {}) {
  return { v: PROTOCOL_VERSION, type, ...fields };
}

export function serverMessage(type, fields = {}) {
  return { v: PROTOCOL_VERSION, type, ...fields };
}

export function normalizeInput(input = NEUTRAL_INPUT) {
  const normalized = { ...NEUTRAL_INPUT, ...input };
  if (!isValidInput(normalized)) {
    throw new TypeError("Input must contain finite normalized axes and a uint16 actions mask");
  }
  return normalized;
}
