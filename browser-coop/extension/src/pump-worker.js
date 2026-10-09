// Dedicated worker (created from a Blob by the page): owns the relay WebSocket and moves engine packets between
// the loopback rings in the engine's shared memory and the relay. Runs off the page thread so a background tab's
// timer throttling does not starve the 16-slot rings.

import { decodePackets, encodePackets, parseControl, relaySocketUrl, MAX_BINARY_BYTES } from "../../shared/protocol.js";
import { RingReader, RingWriter, outOfBandCommand } from "./rings.js";

const POLL_MS = 1;
const FLUSH_MS = 4; // coalesce bursts (gamestate fragments) into one relay message
const INBOX_LIMIT = 512;
const PING_MS = 2000;

const state = {
  role: null,
  url: null,
  socket: null,
  closed: false,
  retries: 0,
  reader: null,
  writer: null,
  reading: false,
  injecting: false,
  dropUntilConnect: false,
  dropOutOfBand: [],
  inbox: [],
  outbox: [],
  outboxBytes: 0,
  lastFlush: 0,
  looping: false,
  stats: { packetsOut: 0, packetsIn: 0, bytesOut: 0, bytesIn: 0, framesOut: 0, framesIn: 0, dropped: 0, lost: 0, rtt: null },
};

const post = (message) => self.postMessage(message);

self.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case "connect":
      state.role = message.role;
      state.url = relaySocketUrl(message.relay, message.room, message.role);
      open();
      startLoop();
      return;
    case "attach":
      state.reader = new RingReader(message.memory, message.layout, message.readBase, { advanceGet: message.advanceGet });
      state.writer = new RingWriter(message.memory, message.layout, message.writeBase, message.writePort);
      state.reading = Boolean(message.reading);
      state.injecting = Boolean(message.injecting);
      state.dropOutOfBand = message.dropOutOfBand ?? [];
      return;
    case "read":
      // Start forwarding from now on; optionally discard until the client's first "connect".
      state.reader.skipToEnd();
      state.dropUntilConnect = Boolean(message.dropUntilConnect);
      state.reading = true;
      return;
    case "inject":
      state.injecting = Boolean(message.on);
      if (message.clearInbox) state.inbox.length = 0;
      return;
    case "send":
      sendText(message.message);
      return;
    case "close":
      state.closed = true;
      try { state.socket?.close(1000, "bye"); } catch { /* closed */ }
      return;
  }
};

function open() {
  if (state.closed) return;
  let socket;
  try {
    socket = new WebSocket(state.url);
  } catch (error) {
    post({ type: "socket", state: "error", reason: String(error?.message ?? error) });
    return reconnect();
  }
  socket.binaryType = "arraybuffer";
  state.socket = socket;
  post({ type: "socket", state: "connecting" });
  socket.onopen = () => {
    state.retries = 0;
    post({ type: "socket", state: "open" });
  };
  socket.onmessage = (event) => {
    if (typeof event.data === "string") {
      const message = parseControl(event.data);
      if (message) control(message);
      return;
    }
    const packets = decodePackets(event.data);
    if (!packets) return;
    state.stats.framesIn += 1;
    for (const packet of packets) {
      state.stats.packetsIn += 1;
      state.stats.bytesIn += packet.byteLength;
      const command = outOfBandCommand(packet);
      if (command && state.dropOutOfBand.includes(command)) continue;
      state.inbox.push(packet);
    }
    if (state.inbox.length > INBOX_LIMIT) {
      state.stats.dropped += state.inbox.length - INBOX_LIMIT;
      state.inbox.splice(0, state.inbox.length - INBOX_LIMIT);
    }
    pump();
  };
  socket.onclose = (event) => {
    if (state.socket === socket) state.socket = null;
    post({ type: "socket", state: "closed", code: event.code, reason: event.reason });
    // 4001: this role was taken over by a newer page (a reload or second tab); do not fight it.
    if (event.code === 4001) {
      state.closed = true;
      return;
    }
    reconnect();
  };
  socket.onerror = () => {};
}

function reconnect() {
  if (state.closed) return;
  const delay = Math.min(5000, 250 * 2 ** state.retries);
  state.retries += 1;
  setTimeout(open, delay);
}

function control(message) {
  if (message.t === "ping") {
    sendText({ t: "pong", ts: message.ts });
    return;
  }
  if (message.t === "pong") {
    if (typeof message.ts === "number") state.stats.rtt = Math.max(0, performance.now() - message.ts);
    return;
  }
  post({ type: "control", message });
}

function sendText(message) {
  const socket = state.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function flush(now) {
  if (!state.outbox.length) return;
  const socket = state.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    state.stats.dropped += state.outbox.length;
  } else {
    let batch = [], size = 4;
    const send = () => {
      if (!batch.length) return;
      socket.send(encodePackets(batch));
      state.stats.framesOut += 1;
      batch = [];
      size = 4;
    };
    for (const packet of state.outbox) {
      if (size + 2 + packet.byteLength > MAX_BINARY_BYTES) send();
      batch.push(packet);
      size += 2 + packet.byteLength;
      state.stats.packetsOut += 1;
      state.stats.bytesOut += packet.byteLength;
    }
    send();
  }
  state.outbox.length = 0;
  state.outboxBytes = 0;
  state.lastFlush = now;
}

function pump() {
  const now = performance.now();
  if (state.reader && state.reading) {
    let packets = state.reader.poll([]);
    state.stats.lost = state.reader.lost;
    if (state.dropUntilConnect && packets.length) {
      // The guest's client first tells its own (now frozen) local server goodbye: not for the host.
      const first = packets.findIndex((packet) => outOfBandCommand(packet) === "connect");
      packets = first < 0 ? [] : packets.slice(first);
      if (first >= 0) state.dropUntilConnect = false;
    }
    for (const packet of packets) {
      state.outbox.push(packet);
      state.outboxBytes += packet.byteLength;
    }
  }
  if (state.outbox.length && now - state.lastFlush >= FLUSH_MS) flush(now);
  if (state.writer && state.injecting) {
    while (state.inbox.length && state.writer.push(state.inbox[0])) state.inbox.shift();
  }
}

async function startLoop() {
  if (state.looping) return;
  state.looping = true;
  const tick = new Int32Array(new SharedArrayBuffer(4));
  let lastPing = 0, lastStats = 0;
  while (!state.closed) {
    pump();
    const now = performance.now();
    if (now - lastPing >= PING_MS) {
      lastPing = now;
      sendText({ t: "ping", ts: now });
    }
    if (now - lastStats >= 1000) {
      lastStats = now;
      post({ type: "stats", stats: { ...state.stats, inbox: state.inbox.length } });
    }
    // Sleep ~1 ms without blocking this worker's event loop (WebSocket messages keep arriving).
    const wait = Atomics.waitAsync ? Atomics.waitAsync(tick, 0, 0, POLL_MS) : null;
    if (wait?.async) await wait.value;
    else await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
