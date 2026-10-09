// Typed access to the running engine's shared memory (the page's Module.HEAPF32.buffer, a fixed 2 GiB
// SharedArrayBuffer), using the addresses in layout.js. Reads and writes are atomic so the engine threads see them.

import { CLIENT_STATE } from "./layout.js";
import { ringOffsets } from "./rings.js";

export class EngineMemory {
  constructor(Module, layout) {
    this.Module = Module;
    this.layout = layout;
    this.memory = Module.HEAPF32.buffer;
    this.i32 = new Int32Array(this.memory);
    this.u16 = new Uint16Array(this.memory);
    this.u8 = new Uint8Array(this.memory);
    this.commandBuffer = 0;
  }

  int(address) { return Atomics.load(this.i32, address >> 2); }
  setInt(address, value) { Atomics.store(this.i32, address >> 2, value); }
  byte(address) { return Atomics.load(this.u8, address); }

  dvarInt(name) {
    const dvar = this.int(this.layout.dvars[name]);
    return dvar ? this.int(dvar + this.layout.dvarValue) : null;
  }
  setDvarInt(name, value) {
    const dvar = this.int(this.layout.dvars[name]);
    if (dvar) this.setInt(dvar + this.layout.dvarValue, value);
    return Boolean(dvar);
  }

  mailboxesClear() {
    const { cmd, freeze, inq } = this.layout.flags;
    return this.int(cmd) === 0 && this.int(freeze) === 0 && this.int(inq) === 0;
  }

  /** Queues one console command for the engine main thread; false while the previous one is pending. */
  command(text) {
    const { cmd } = this.layout.flags;
    if (this.int(cmd) !== 0) return false;
    const bytes = new TextEncoder().encode(`${text}\n`);
    if (bytes.length >= 1024) throw new RangeError("command too long");
    if (!this.commandBuffer) this.commandBuffer = this.Module._malloc(1024);
    this.u8.set(bytes, this.commandBuffer);
    this.u8[this.commandBuffer + bytes.length] = 0;
    // Cbuf_AddText copies the text before the engine clears the mailbox, so the buffer is reusable after that.
    return Atomics.compareExchange(this.i32, cmd >> 2, 0, this.commandBuffer) === 0;
  }
  commandPending() { return this.int(this.layout.flags.cmd) !== 0; }

  setFreeze(on) { this.setInt(this.layout.flags.freeze, on ? 1 : 0); }
  serverDrainsPackets() { return this.byte(this.layout.server.allowNetPackets) === 1; }
  serverRunning() {
    const dvar = this.int(this.layout.dvars.comSvRunning);
    return dvar ? this.byte(dvar + this.layout.dvarValue) === 1 : false;
  }

  connectionState() { return this.int(this.layout.client.connectionState); }
  /** Points the local client's server address at loopback port 0, where the page injects the host's packets. */
  setServerAddressPort(port) {
    const clc = this.int(this.layout.client.clcPtr);
    if (!clc) return false;
    Atomics.store(this.u16, (clc + this.layout.client.serverAddressPort) >> 1, port);
    return true;
  }
  serverAddressPort() {
    const clc = this.int(this.layout.client.clcPtr);
    return clc ? Atomics.load(this.u16, (clc + this.layout.client.serverAddressPort) >> 1) : null;
  }

  /** Server slots in use: [{ slot, state, loopback, port, connectState }]. */
  serverClients() {
    const s = this.layout.server;
    const clients = this.int(s.clientsPtr);
    const count = this.dvarInt("comMaxClients") ?? 0;
    const out = [];
    if (!clients) return out;
    for (let slot = 0; slot < Math.min(count, 64); slot += 1) {
      const base = clients + slot * s.clientStride;
      const state = this.int(base + s.clientState);
      if (state === CLIENT_STATE.free) continue;
      out.push({
        slot,
        state,
        loopback: this.int(base + s.clientAddrType) === this.layout.netadrLoopback,
        port: Atomics.load(this.u16, (base + s.clientAddrPort) >> 1),
        connectState: this.byte(base + s.clientConnectState),
      });
    }
    return out;
  }

  /**
   * Host: two rings the engine knows nothing about, inside one malloc'd block. The server sends to loopback port P
   * by writing loopbacks[P] = base + P * stride, so P is picked to land in the block; Q = P + 1 is the inbound ring
   * the patched NET_GetLoopPacket drains. Never freed.
   */
  allocateRemoteRings() {
    const lb = this.layout.loopback;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const size = 3 * lb.stride + 64;
      const block = this.Module._malloc(size);
      if (!block) throw new Error("out of engine memory");
      this.u8.fill(0, block, block + size);
      const port = Math.ceil((block - lb.base) / lb.stride);
      const inPort = port + 1;
      const fits = lb.base + (inPort + 1) * lb.stride <= block + size;
      const allowed = ![port, inPort].some((p) => this.layout.forbiddenPorts.includes(p));
      if (port >= 2 && inPort <= 0xffff && fits && allowed) {
        return { port, inPort, out: ringOffsets(this.layout, port), in: ringOffsets(this.layout, inPort) };
      }
    }
    throw new Error("could not place the co-op rings in engine memory");
  }

  setInboundRing(index) { this.setInt(this.layout.flags.inq, index); }
}
