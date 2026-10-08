import assert from "node:assert/strict";
import test from "node:test";

import { CoopClient, roomWebSocketUrl } from "../client/src/coop-client.js";

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
  }

  addEventListener(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event, data = {}) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(data);
    }
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  receive(message) {
    this.emit("message", { data: JSON.stringify(message) });
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close(code = 1000) {
    this.readyState = 3;
    this.emit("close", { code });
  }
}

test("roomWebSocketUrl upgrades HTTP and safely appends the room path", () => {
  assert.equal(
    roomWebSocketUrl("https://relay.example.test/base/", "nacht-der-untoten"),
    "wss://relay.example.test/base/v1/rooms/nacht-der-untoten",
  );
  assert.throws(() => roomWebSocketUrl("https://relay.example.test", "UPPERCASE"), /Room IDs/);
});

test("guest clients only send input after their relay-assigned role is known", () => {
  let socket;
  const client = new CoopClient({
    relayUrl: "http://localhost:8787",
    roomId: "kino",
    webSocketFactory: (url) => (socket = new FakeSocket(url)),
  });

  client.connect();
  socket.open();
  assert.deepEqual(socket.sent[0], { v: 1, type: "hello" });
  assert.equal(client.sendInput(1, {}), false);

  socket.receive({ v: 1, type: "joined", roomId: "kino", playerId: 1, capacity: 2 });
  assert.equal(client.sendInput(12, { moveX: 1 }), true);
  assert.deepEqual(socket.sent[1], {
    v: 1,
    type: "input",
    seq: 0,
    tick: 12,
    input: { moveX: 1, moveY: 0, lookX: 0, lookY: 0, actions: 0 },
  });
});

test("ready intent survives the WebSocket upgrade and is sent after joining", () => {
  let socket;
  const client = new CoopClient({
    relayUrl: "http://localhost:8787",
    roomId: "ascension",
    webSocketFactory: (url) => (socket = new FakeSocket(url)),
  });

  client.connect();
  assert.equal(client.setReady(true), false);
  socket.open();
  socket.receive({ v: 1, type: "joined", roomId: "ascension", playerId: 0, capacity: 2 });

  assert.deepEqual(socket.sent, [
    { v: 1, type: "hello" },
    { v: 1, type: "ready", ready: true },
  ]);
});

test("host clients publish snapshots while guests do not", () => {
  let socket;
  const client = new CoopClient({
    relayUrl: "wss://relay.example.test",
    roomId: "five",
    webSocketFactory: (url) => (socket = new FakeSocket(url)),
  });

  client.connect();
  socket.open();
  socket.receive({ v: 1, type: "joined", roomId: "five", playerId: 0, capacity: 2 });
  assert.equal(client.sendSnapshot(9, { round: 4 }), true);
  assert.deepEqual(socket.sent[1], {
    v: 1,
    type: "snapshot",
    seq: 0,
    tick: 9,
    state: { round: 4 },
  });
});
