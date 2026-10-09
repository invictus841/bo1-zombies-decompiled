import assert from "node:assert/strict";
import test from "node:test";

import { BUILDS } from "../extension/src/layout.js";
import { RingReader, RingWriter, outOfBandCommand, ringOffsets } from "../extension/src/rings.js";

const REAL = Object.values(BUILDS)[0];
// Same ring geometry as the engine, placed at the start of a small shared buffer.
const layout = { ...REAL, loopback: { ...REAL.loopback, base: 0 } };
const lb = layout.loopback;

function memory(rings = 2) {
  return new SharedArrayBuffer(rings * lb.stride);
}

// What the engine's NET_SendLoopPacket does (wasm): copy into slot send & 15, then atomically bump send.
function engineSend(buffer, ring, bytes, port = 0) {
  const i32 = new Int32Array(buffer), u8 = new Uint8Array(buffer);
  const { base, send } = ringOffsets(layout, ring);
  const s = Atomics.load(i32, send >> 2);
  const slot = base + (s & 15) * lb.slotSize;
  u8.set(bytes, slot);
  i32[(slot + lb.offLen) >> 2] = bytes.byteLength;
  i32[(slot + lb.offPort) >> 2] = port;
  Atomics.add(i32, send >> 2, 1);
}

// What NET_GetLoopPacket_Real does: skip to the 16 newest, copy slot get & 15, bump get.
function engineReceive(buffer, ring) {
  const i32 = new Int32Array(buffer), u8 = new Uint8Array(buffer);
  const { base, get, send } = ringOffsets(layout, ring);
  if (i32[send >> 2] - i32[get >> 2] > 16) i32[get >> 2] = i32[send >> 2] - 16;
  const g = i32[get >> 2];
  if (g >= i32[send >> 2]) return null;
  Atomics.add(i32, get >> 2, 1);
  const slot = base + (g & 15) * lb.slotSize;
  return { bytes: u8.slice(slot, slot + i32[(slot + lb.offLen) >> 2]), port: i32[(slot + lb.offPort) >> 2] };
}

const packet = (n, size = 8) => new Uint8Array(size).fill(n & 255);

test("RingReader forwards packets in order and ignores what came before it started", () => {
  const buffer = memory();
  engineSend(buffer, 1, packet(1));
  const reader = new RingReader(buffer, layout, ringOffsets(layout, 1).base);
  assert.equal(reader.poll().length, 0);
  for (let i = 2; i <= 6; i += 1) engineSend(buffer, 1, packet(i, i));
  const got = reader.poll();
  assert.deepEqual(got.map((p) => p[0]), [2, 3, 4, 5, 6]);
  assert.deepEqual(got.map((p) => p.byteLength), [2, 3, 4, 5, 6]);
  assert.equal(reader.lost, 0);
});

test("RingReader keeps only the 15 newest when the engine laps it, and counts the loss", () => {
  const buffer = memory();
  const reader = new RingReader(buffer, layout, ringOffsets(layout, 1).base);
  for (let i = 0; i < 40; i += 1) engineSend(buffer, 1, packet(i));
  const got = reader.poll();
  assert.equal(got.length, 15);
  assert.equal(got[0][0], 25);
  assert.equal(got.at(-1)[0], 39);
  assert.equal(reader.lost, 25);
});

test("RingReader with advanceGet keeps get in step, so the ring looks drained", () => {
  const buffer = memory();
  const { base, get } = ringOffsets(layout, 1);
  const reader = new RingReader(buffer, layout, base, { advanceGet: true });
  engineSend(buffer, 1, packet(1));
  engineSend(buffer, 1, packet(2));
  reader.poll();
  assert.equal(new Int32Array(buffer)[get >> 2], 2);
  assert.equal(engineReceive(buffer, 1), null);
});

test("skipToEnd discards everything written so far", () => {
  const buffer = memory();
  const reader = new RingReader(buffer, layout, ringOffsets(layout, 1).base);
  engineSend(buffer, 1, packet(1));
  reader.skipToEnd();
  engineSend(buffer, 1, packet(2));
  assert.deepEqual(reader.poll().map((p) => p[0]), [2]);
});

test("RingWriter delivers packets with the given port to the engine's reader", () => {
  const buffer = memory();
  const writer = new RingWriter(buffer, layout, ringOffsets(layout, 0).base, 7);
  assert.equal(writer.push(packet(42, 100)), true);
  const received = engineReceive(buffer, 0);
  assert.equal(received.port, 7);
  assert.equal(received.bytes.byteLength, 100);
  assert.equal(received.bytes[0], 42);
});

test("RingWriter stops at 15 unread packets instead of overwriting, then resumes", () => {
  const buffer = memory();
  const writer = new RingWriter(buffer, layout, ringOffsets(layout, 0).base, 0);
  let accepted = 0;
  for (let i = 0; i < 20; i += 1) if (writer.push(packet(i))) accepted += 1;
  assert.equal(accepted, 15);
  assert.equal(engineReceive(buffer, 0).bytes[0], 0);
  assert.equal(writer.push(packet(99)), true);
  const order = [];
  for (let r; (r = engineReceive(buffer, 0)); ) order.push(r.bytes[0]);
  assert.deepEqual(order, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 99]);
});

test("RingWriter drops packets that cannot fit a slot without touching the ring", () => {
  const buffer = memory();
  const { base, send } = ringOffsets(layout, 0);
  const writer = new RingWriter(buffer, layout, base, 0);
  assert.equal(writer.push(new Uint8Array(lb.dataMax + 1)), true);
  assert.equal(writer.push(new Uint8Array(0)), true);
  assert.equal(new Int32Array(buffer)[send >> 2], 0);
});

test("outOfBandCommand reads the command word of connectionless packets", () => {
  const oob = (text) => Uint8Array.of(255, 255, 255, 255, ...new TextEncoder().encode(text));
  assert.equal(outOfBandCommand(oob('connect "\\protocol\\1044"')), "connect");
  assert.equal(outOfBandCommand(oob("connectResponse mods")), "connectResponse");
  assert.equal(outOfBandCommand(oob("rcon pass status")), "rcon");
  assert.equal(outOfBandCommand(Uint8Array.of(1, 0, 0, 0, 65)), null);
});

test("the build layout is internally consistent", () => {
  for (const build of Object.values(BUILDS)) {
    const l = build.loopback;
    assert.equal(l.slots * l.slotSize + 8, l.stride);
    assert.equal(l.offLen, l.dataMax);
    assert.equal(l.offPort, l.dataMax + 4);
    assert.equal(l.offGet, l.slots * l.slotSize);
    assert.equal(l.offSend, l.offGet + 4);
    const { cmd, freeze, inq } = build.flags;
    assert.deepEqual([freeze - cmd, inq - freeze], [4, 4]);
  }
});
