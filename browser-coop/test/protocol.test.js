import assert from "node:assert/strict";
import test from "node:test";

import {
  NEUTRAL_INPUT,
  clientMessage,
  normalizeInput,
  parseWireMessage,
  validateClientMessage,
  validateServerMessage,
} from "../shared/protocol.js";

test("a guest input frame has a narrow, validated shape", () => {
  const message = clientMessage("input", {
    seq: 42,
    tick: 120,
    input: { ...NEUTRAL_INPUT, moveX: 1, actions: 5 },
  });

  assert.deepEqual(validateClientMessage(message), { ok: true, value: message });
  assert.equal(validateClientMessage({ ...message, input: { ...message.input, actions: -1 } }).ok, false);
  assert.equal(validateClientMessage({ ...message, input: { moveX: 0 } }).ok, false);
});

test("wire parsing rejects oversized, malformed, and binary payloads", () => {
  assert.deepEqual(parseWireMessage("{not-json"), { ok: false, error: "invalid_json" });
  assert.deepEqual(parseWireMessage(new ArrayBuffer(2)), {
    ok: false,
    error: "binary_messages_are_not_supported",
  });
  assert.equal(parseWireMessage("x".repeat(48_001)).error, "message_too_large");
});

test("a guest cannot impersonate the host in relay messages", () => {
  const snapshot = {
    v: 1,
    type: "snapshot",
    playerId: 1,
    seq: 0,
    tick: 0,
    state: { zombies: [] },
  };
  assert.equal(validateServerMessage(snapshot).ok, false);
});

test("normalizeInput fills missing fields but refuses invalid controls", () => {
  assert.deepEqual(normalizeInput({ moveY: -1 }), { ...NEUTRAL_INPUT, moveY: -1 });
  assert.throws(() => normalizeInput({ lookX: Infinity }), /finite normalized axes/);
});
