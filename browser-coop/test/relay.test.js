// Runs the relay Worker + Durable Object locally (workerd, via wrangler) and talks to it over real WebSockets.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { unstable_startWorker } from "wrangler";

import { decodePackets, encodePackets } from "../shared/protocol.js";

let worker, base;
before(async () => {
  worker = await unstable_startWorker({ config: "relay/wrangler.jsonc", dev: { server: { port: 0 }, inspector: false } });
  await worker.ready;
  base = (await worker.url).toString().replace(/^http/, "ws").replace(/\/$/, "");
});
after(async () => { await worker?.dispose(); });

let roomCounter = 0;
const newRoom = () => `test-room-${process.pid}-${++roomCounter}`;

/** Opens a socket and queues everything it receives. */
function connect(room, role) {
  const socket = new WebSocket(`${base}/v1/rooms/${room}?role=${role}&v=2`);
  socket.binaryType = "arraybuffer";
  const queue = [], waiters = [];
  socket.addEventListener("message", (event) => {
    const item = typeof event.data === "string" ? JSON.parse(event.data) : new Uint8Array(event.data);
    const waiter = waiters.shift();
    if (waiter) waiter(item); else queue.push(item);
  });
  const closed = new Promise((resolve) => socket.addEventListener("close", (event) => resolve(event)));
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const next = (ms = 3000) => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no message")), ms);
    waiters.push((item) => { clearTimeout(timer); resolve(item); });
  });
  return { socket, next, opened, closed, queue };
}

test("health reports protocol 2", async () => {
  const response = await fetch(`${base.replace(/^ws/, "http")}/health`);
  assert.deepEqual(await response.json(), { ok: true, protocol: 2 });
});

test("host and guest are welcomed, see each other, and binary batches pass through unchanged both ways", async () => {
  const room = newRoom();
  const host = connect(room, "host");
  assert.deepEqual(await host.next(), { t: "welcome", v: 2, role: "host", peer: false });
  const guest = connect(room, "guest");
  assert.deepEqual(await guest.next(), { t: "welcome", v: 2, role: "guest", peer: true });
  assert.deepEqual(await host.next(), { t: "peer", present: true });

  const toHost = encodePackets([Uint8Array.of(255, 255, 255, 255, 1, 2, 3), new Uint8Array(1264).fill(9)]);
  guest.socket.send(toHost);
  const atHost = await host.next();
  assert.deepEqual([...atHost], [...toHost]);
  assert.equal(decodePackets(atHost).length, 2);

  const toGuest = encodePackets([Uint8Array.of(4, 5, 6)]);
  host.socket.send(toGuest);
  assert.deepEqual([...(await guest.next())], [...toGuest]);

  host.socket.send(JSON.stringify({ t: "info", zone: "zombie_theater" }));
  assert.deepEqual(await guest.next(), { t: "info", zone: "zombie_theater" });

  guest.socket.close(1000, "bye");
  await guest.closed;
  assert.deepEqual(await host.next(), { t: "peer", present: false });
  host.socket.close();
  await host.closed;
});

test("a new connection for a role replaces the old one without telling the peer it left", async () => {
  const room = newRoom();
  const host = connect(room, "host");
  await host.next();
  const first = connect(room, "guest");
  await first.next();
  assert.deepEqual(await host.next(), { t: "peer", present: true });
  const second = connect(room, "guest");
  assert.deepEqual(await second.next(), { t: "welcome", v: 2, role: "guest", peer: true });
  assert.deepEqual(await first.next(), { t: "error", code: "replaced" });
  assert.equal((await first.closed).code, 4001);
  assert.deepEqual(await host.next(), { t: "peer", present: true });
  // Traffic now reaches the new guest only.
  host.socket.send(encodePackets([Uint8Array.of(7)]));
  assert.deepEqual([...decodePackets(await second.next())[0]], [7]);
  await assert.rejects(host.next(300)); // no "peer left" for the replaced socket
  host.socket.close();
  second.socket.close();
});

test("relay-reserved and malformed text messages are rejected, not forwarded", async () => {
  const room = newRoom();
  const host = connect(room, "host");
  await host.next();
  const guest = connect(room, "guest");
  await guest.next();
  await host.next();
  guest.socket.send(JSON.stringify({ t: "welcome", role: "host" }));
  assert.deepEqual(await guest.next(), { t: "error", code: "bad_message" });
  guest.socket.send("not json");
  assert.deepEqual(await guest.next(), { t: "error", code: "bad_message" });
  await assert.rejects(host.next(300));
  host.socket.close();
  guest.socket.close();
});

test("upgrades are checked: role, protocol version, room id, origin", async () => {
  // worker.fetch goes straight to the local runtime, which (unlike Node's fetch) allows an Upgrade header.
  const http = base.replace(/^ws/, "http");
  const status = async (path, headers = {}) => (await worker.fetch(`${http}${path}`, { headers: { Upgrade: "websocket", ...headers } })).status;
  assert.equal(await status("/v1/rooms/abc?role=spectator&v=2"), 400);
  assert.equal(await status("/v1/rooms/abc?role=host&v=1"), 400);
  assert.equal(await status("/v1/rooms/NOT_VALID?role=host&v=2"), 404);
  assert.equal(await status("/v1/rooms/abc?role=host&v=2", { Origin: "https://evil.example" }), 403);
  assert.equal((await worker.fetch(`${http}/v1/rooms/abc?role=host&v=2`)).status, 426);
});
