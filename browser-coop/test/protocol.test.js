import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PACKET_BYTES,
  createRoomCode,
  decodePackets,
  encodePackets,
  isPeerMessage,
  normalizeRoomCode,
  parseControl,
  relaySocketUrl,
  ROOM_ID_PATTERN,
} from "../shared/protocol.js";

test("room codes are 16 base32 characters in groups of four and valid room ids", () => {
  const code = createRoomCode();
  assert.match(code, /^[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);
  assert.ok(ROOM_ID_PATTERN.test(code));
  assert.notEqual(createRoomCode(), code);
});

test("normalizeRoomCode accepts pasted codes and invite links", () => {
  const code = "abcd-efgh-jkmn-pqrs";
  assert.equal(normalizeRoomCode(code), code);
  assert.equal(normalizeRoomCode(" ABCD EFGH JKMN PQRS "), code);
  assert.equal(normalizeRoomCode("abcdefghjkmnpqrs"), code);
  assert.equal(normalizeRoomCode(`https://vel.gg/bo1z/?coop=join&room=${code}`), code);
  assert.equal(normalizeRoomCode("abcd-efgh"), null);
  assert.equal(normalizeRoomCode("ilou-ilou-ilou-ilou"), null); // look-alike letters are not in the alphabet
  assert.equal(normalizeRoomCode(42), null);
});

test("relaySocketUrl builds the room endpoint with role and protocol version", () => {
  assert.equal(
    relaySocketUrl("https://relay.example.workers.dev", "abcd-efgh-jkmn-pqrs", "host"),
    "wss://relay.example.workers.dev/v1/rooms/abcd-efgh-jkmn-pqrs?role=host&v=2",
  );
  assert.equal(relaySocketUrl("http://127.0.0.1:8787", "room-1", "guest"), "ws://127.0.0.1:8787/v1/rooms/room-1?role=guest&v=2");
});

test("packet batches round-trip and reject malformed input", () => {
  const packets = [Uint8Array.of(255, 255, 255, 255, 99), new Uint8Array(MAX_PACKET_BYTES).fill(7), new Uint8Array(0)];
  const decoded = decodePackets(encodePackets(packets));
  assert.equal(decoded.length, 3);
  assert.deepEqual([...decoded[0]], [255, 255, 255, 255, 99]);
  assert.equal(decoded[1].byteLength, MAX_PACKET_BYTES);
  assert.equal(decoded[2].byteLength, 0);

  const good = encodePackets([Uint8Array.of(1, 2, 3)]);
  assert.equal(decodePackets(good.subarray(0, good.length - 1)), null); // truncated
  assert.equal(decodePackets(Uint8Array.of(9, 1, 0, 0)), null); // unknown version
  const extra = new Uint8Array(good.length + 1);
  extra.set(good);
  assert.equal(decodePackets(extra), null); // trailing bytes
  assert.throws(() => encodePackets([new Uint8Array(MAX_PACKET_BYTES + 1)]), RangeError);
});

test("control messages need an object with a short string t; relay types are reserved", () => {
  assert.deepEqual(parseControl('{"t":"info","zone":"zombie_theater"}'), { t: "info", zone: "zombie_theater" });
  assert.equal(parseControl("not json"), null);
  assert.equal(parseControl("[1,2]"), null);
  assert.equal(parseControl('{"type":"info"}'), null);
  assert.equal(parseControl("x".repeat(5000)), null);
  assert.equal(isPeerMessage(parseControl('{"t":"state"}')), true);
  assert.equal(isPeerMessage(parseControl('{"t":"welcome"}')), false);
  assert.equal(isPeerMessage(null), false);
});
