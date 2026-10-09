// Loopback rings in the engine's shared memory. A ring is 16 slots of { data[1264]; i32 datalen; i32 port }
// followed by i32 get and i32 send. The engine's writer copies into slot (send & 15), then atomically adds 1 to
// send; its reader copies slot (get & 15) while get < send, then atomically adds 1 to get. Neither side waits for
// the other: a writer more than 16 ahead silently overwrites, like a full UDP socket buffer.

export function ringOffsets(layout, index) {
  const lb = layout.loopback;
  const base = lb.base + index * lb.stride;
  return { base, get: base + lb.offGet, send: base + lb.offSend };
}

/** Reads packets the engine writes into a ring that nothing in the engine reads. Keeps its own cursor. */
export class RingReader {
  constructor(memory, layout, base, { advanceGet = false } = {}) {
    this.i32 = new Int32Array(memory);
    this.u8 = new Uint8Array(memory);
    this.lb = layout.loopback;
    this.base = base;
    this.getIndex = (base + this.lb.offGet) >> 2;
    this.sendIndex = (base + this.lb.offSend) >> 2;
    this.advanceGet = advanceGet;
    this.cursor = Atomics.load(this.i32, this.sendIndex);
    this.lost = 0;
  }

  /** Skip everything written so far. */
  skipToEnd() {
    this.cursor = Atomics.load(this.i32, this.sendIndex);
    if (this.advanceGet) Atomics.store(this.i32, this.getIndex, this.cursor);
  }

  /** Copies out every complete packet since the last poll. */
  poll(out = []) {
    const { slots, slotSize, offLen, dataMax } = this.lb;
    let send = Atomics.load(this.i32, this.sendIndex);
    // The writer may be filling slot (send & 15) right now, which still holds packet send - 16: only the
    // 15 newest finished packets are safe to copy.
    if (send - this.cursor > slots - 1) {
      this.lost += send - (slots - 1) - this.cursor;
      this.cursor = send - (slots - 1);
    }
    while (this.cursor < send) {
      const slot = this.base + (this.cursor & (slots - 1)) * slotSize;
      const length = this.i32[(slot + offLen) >> 2];
      const packet = length > 0 && length <= dataMax ? this.u8.slice(slot, slot + length) : null;
      // If the writer lapped us while we copied, the bytes may be torn: drop them.
      send = Atomics.load(this.i32, this.sendIndex);
      if (send - this.cursor > slots - 1) {
        this.lost += 1;
      } else if (packet) {
        out.push(packet);
      }
      this.cursor += 1;
    }
    if (this.advanceGet) Atomics.store(this.i32, this.getIndex, this.cursor);
    return out;
  }
}

/** Writes packets into a ring the engine reads, as its only writer. */
export class RingWriter {
  constructor(memory, layout, base, port) {
    this.i32 = new Int32Array(memory);
    this.u8 = new Uint8Array(memory);
    this.lb = layout.loopback;
    this.base = base;
    this.port = port;
    this.getIndex = (base + this.lb.offGet) >> 2;
    this.sendIndex = (base + this.lb.offSend) >> 2;
  }

  /** Room for one more packet without overwriting one the engine has not read yet. */
  hasRoom() {
    const send = Atomics.load(this.i32, this.sendIndex);
    const get = Atomics.load(this.i32, this.getIndex);
    // At send - get == 16 the engine's reader could still be copying slot (send & 15).
    return send - get < this.lb.slots - 1;
  }

  /** Returns false (and writes nothing) when the engine has not caught up. */
  push(packet) {
    const { slots, slotSize, offLen, offPort, dataMax } = this.lb;
    if (packet.byteLength === 0 || packet.byteLength > dataMax) return true; // drop: cannot be a valid packet
    if (!this.hasRoom()) return false;
    const send = Atomics.load(this.i32, this.sendIndex);
    const slot = this.base + (send & (slots - 1)) * slotSize;
    this.u8.set(packet, slot);
    Atomics.store(this.i32, (slot + offLen) >> 2, packet.byteLength);
    Atomics.store(this.i32, (slot + offPort) >> 2, this.port);
    Atomics.add(this.i32, this.sendIndex, 1);
    return true;
  }
}

/** First four bytes 0xFFFFFFFF: an out-of-band (connectionless) packet; returns its text command, else null. */
export function outOfBandCommand(packet) {
  if (packet.byteLength < 5 || packet[0] !== 0xff || packet[1] !== 0xff || packet[2] !== 0xff || packet[3] !== 0xff) return null;
  let end = 4;
  while (end < packet.byteLength && end < 64 && packet[end] !== 0 && packet[end] !== 0x20 && packet[end] !== 0x0a) end += 1;
  return String.fromCharCode(...packet.subarray(4, end));
}
