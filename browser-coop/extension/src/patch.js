// In-page patch of the engine wasm. The page fetches KisakBlack-web.wasm from vel.gg as usual; in co-op mode the
// extension adds two short prologues before the module is compiled. The glue then posts the compiled module to every
// engine pthread, so all threads run the patched code. Nothing is downloaded from anywhere else.
//
// P1, at the top of __wrap__Z8SV_Frameii(msec), which BrowserFrame calls on the engine main thread every frame:
//     p = atomic.xchg(CMD, 0); if (p) Cbuf_AddText(0, p);          // console commands from the page
//     if (atomic.load(FREEZE)) { SV_WaitServer(); return msec; }     // guest: stop its own local server
// P2, at the top of NET_GetLoopPacket(sock, from, msg):
//     if (sock == 1) { q = atomic.load(INQ); if (q && ring1.get >= ring1.send) sock = q; }
//     // host: once ring 1 is empty, the server also drains ring q, which only the page writes (the remote player)
// Both are inert while the three mailbox words are 0, which is how the engine starts.
// P4, in CachedTag_UpdateTagInternal: its two calls to Com_Error (no model on the entity, no such tag) become
//     three drops of the call's arguments, so the function falls through to its normal exit and leaves the cached
//     tag as it was. Both are co-op-only situations (another player's body being drawn before its model exists).
// P3, at the end of Assert_MyHandler: instead of trapping after printing a failed debug check, restore the stack and
//     return 1 ("continue"), as the retail game does with its checks compiled out. Solo play on vel.gg never runs
//     some code co-op needs (drawing a second player), and one of its checks would otherwise stop the engine.

import { BUILDS } from "./layout.js";

function uleb(n) {
  const out = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}
function sleb(n) {
  const out = [];
  for (;;) {
    let byte = n & 0x7f;
    n >>= 7;
    const done = (n === 0 && !(byte & 0x40)) || (n === -1 && byte & 0x40);
    if (!done) byte |= 0x80;
    out.push(byte);
    if (done) return out;
  }
}
function readUleb(bytes, at) {
  let result = 0, shift = 0, byte;
  do {
    byte = bytes[at++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return [result >>> 0, at];
}

const I32_CONST = (v) => [0x41, ...sleb(v | 0)];
const LOAD = [0x28, 0x02, 0x00]; // i32.load align=4 offset=0
const ATOMIC_LOAD = [0xfe, 0x10, 0x02, 0x00]; // i32.atomic.load
const ATOMIC_XCHG = [0xfe, 0x41, 0x02, 0x00]; // i32.atomic.rmw.xchg
const LOCAL_GET = (i) => [0x20, ...uleb(i)], LOCAL_SET = (i) => [0x21, ...uleb(i)], LOCAL_TEE = (i) => [0x22, ...uleb(i)];
const CALL = (f) => [0x10, ...uleb(f)];
const IF = [0x04, 0x40], END = 0x0b, RETURN = 0x0f, I32_EQ = 0x46, I32_GE_U = 0x4f;

function svFramePrologue(build) {
  // $0 = msec (param). $1 = first local, borrowed as scratch. The original body reads $1 as a loop counter
  // without setting it (it relies on locals starting at 0), so the prologue puts the 0 back.
  const { flags, functions } = build;
  return [
    ...I32_CONST(flags.cmd), ...I32_CONST(0), ...ATOMIC_XCHG, ...LOCAL_TEE(1),
    ...IF, ...I32_CONST(0), ...LOCAL_GET(1), ...CALL(functions.cbufAddText[0]), END,
    ...I32_CONST(0), ...LOCAL_SET(1),
    ...I32_CONST(flags.freeze), ...ATOMIC_LOAD,
    ...IF, ...CALL(functions.svWaitServer[0]), ...LOCAL_GET(0), RETURN, END,
  ];
}

function netGetLoopPacketPrologue(build) {
  // $0 = sock, $1 = from, $2 = msg (params). $4 = second local, borrowed as scratch and reset to 0 afterwards.
  const { flags, loopback } = build;
  const ring1 = loopback.base + loopback.stride;
  return [
    ...LOCAL_GET(0), ...I32_CONST(1), I32_EQ,
    ...IF,
    ...I32_CONST(flags.inq), ...ATOMIC_LOAD, ...LOCAL_TEE(4),
    ...IF,
    ...I32_CONST(ring1 + loopback.offGet), ...LOAD, ...I32_CONST(ring1 + loopback.offSend), ...LOAD, I32_GE_U,
    ...IF, ...LOCAL_GET(4), ...LOCAL_SET(0), END,
    END,
    ...I32_CONST(0), ...LOCAL_SET(4),
    END,
  ];
}

function readSleb(bytes, at) {
  let result = 0, shift = 0, byte;
  do {
    byte = bytes[at++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  if (shift < 32 && byte & 0x40) result |= -1 << shift;
  return [result, at];
}

// P3: the handler opens a stack frame (global.get sp; i32.const N; i32.sub; local.tee F; global.set sp) and ends
// with "global.set sp; unreachable; end", leaving that frame open. Replace the unreachable with
// "local.get F; i32.const N; i32.add; global.set sp; i32.const 1; return".
function nonFatalAssert(body, params) {
  let [groups, p] = readUleb(body, 0);
  for (let g = 0; g < groups; g += 1) p = readUleb(body, p)[1] + 1;
  const fail = (why) => { throw new Error(`assert handler: ${why}`); };
  if (body[p] !== 0x23) fail("no stack frame");
  const [sp, a] = readUleb(body, p + 1);
  if (body[a] !== 0x41) fail("no frame size");
  const [frame, b] = readSleb(body, a + 1);
  if (body[b] !== 0x6b || body[b + 1] !== 0x22) fail("unexpected prologue");
  const [frameLocal, c] = readUleb(body, b + 2);
  if (frameLocal < params || body[c] !== 0x24 || readUleb(body, c + 1)[0] !== sp) fail("unexpected prologue");
  const end = body.length;
  if (body[end - 1] !== 0x0b || body[end - 2] !== 0x00) fail("does not end with unreachable");
  const tail = [...LOCAL_GET(frameLocal), ...I32_CONST(frame), 0x6a, 0x24, ...uleb(sp), ...I32_CONST(1), RETURN, END];
  const out = new Uint8Array(end - 2 + tail.length);
  out.set(body.subarray(0, end - 2), 0);
  out.set(tail, end - 2);
  return out;
}

// P4: replace every "call <callee>" in a body with drops of its arguments. The call must take `args` values and
// return nothing, so the stack is unchanged and the following instructions run as before.
function neutralizeCalls(body, callee, args, expected) {
  const pattern = Uint8Array.from([0x10, ...uleb(callee)]);
  const out = Uint8Array.from(body);
  let found = 0;
  for (let i = 0; i + pattern.length <= out.length; i += 1) {
    if (pattern.every((byte, k) => out[i + k] === byte)) {
      if (pattern.length !== args) throw new Error("neutralizeCalls: call and drops differ in size");
      for (let k = 0; k < args; k += 1) out[i + k] = 0x1a; // drop
      found += 1;
      i += pattern.length - 1;
    }
  }
  if (found !== expected) throw new Error(`neutralizeCalls: found ${found} calls, expected ${expected}`);
  return out;
}

/** Section table, import count and function names of a wasm binary. */
export function inspectWasm(bytes) {
  if (bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error("not a wasm module");
  const sections = [];
  let importedFunctions = 0, nameSection = null;
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at];
    const [size, body] = readUleb(bytes, at + 1);
    const section = { id, start: at, body, end: body + size };
    sections.push(section);
    if (id === 2) importedFunctions = countImportedFunctions(bytes, body);
    if (id === 0) {
      const [nameLength, nameAt] = readUleb(bytes, body);
      if (new TextDecoder().decode(bytes.subarray(nameAt, nameAt + nameLength)) === "name") nameSection = { at: nameAt + nameLength, end: section.end };
    }
    at = section.end;
  }
  return { sections, importedFunctions, nameSection };
}

function countImportedFunctions(bytes, at) {
  let [count, p] = readUleb(bytes, at);
  let functions = 0;
  for (let i = 0; i < count; i += 1) {
    let length;
    [length, p] = readUleb(bytes, p); p += length; // module
    [length, p] = readUleb(bytes, p); p += length; // field
    const kind = bytes[p++];
    if (kind === 0) { functions += 1; p = readUleb(bytes, p)[1]; }
    else if (kind === 1) { p += 1; const limits = bytes[p++]; p = readUleb(bytes, p)[1]; if (limits & 1) p = readUleb(bytes, p)[1]; }
    else if (kind === 2) { const limits = bytes[p++]; p = readUleb(bytes, p)[1]; if (limits & 1) p = readUleb(bytes, p)[1]; }
    else if (kind === 3) p += 2;
    else if (kind === 4) { p += 1; p = readUleb(bytes, p)[1]; }
    else throw new Error(`unknown import kind ${kind}`);
  }
  return functions;
}

/** Names of the given function indices, from the "name" custom section. */
export function functionNames(bytes, nameSection, wanted) {
  const names = new Map();
  if (!nameSection) return names;
  const want = new Set(wanted);
  let at = nameSection.at;
  while (at < nameSection.end) {
    const kind = bytes[at++];
    const [size, body] = readUleb(bytes, at);
    if (kind === 1) {
      let [count, p] = readUleb(bytes, body);
      for (let i = 0; i < count && names.size < want.size; i += 1) {
        let index, length;
        [index, p] = readUleb(bytes, p);
        [length, p] = readUleb(bytes, p);
        if (want.has(index)) names.set(index, new TextDecoder().decode(bytes.subarray(p, p + length)));
        p += length;
      }
    }
    at = body + size;
  }
  return names;
}

/**
 * Returns the patched module bytes. Throws if the binary is not exactly the build `build` describes.
 * `build` defaults to the BUILDS entry for `hash`.
 */
export function patchEngine(input, hash, build = BUILDS[hash]) {
  if (!build) throw new Error(`unknown engine build ${hash?.slice(0, 12)}`);
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { sections, importedFunctions, nameSection } = inspectWasm(bytes);

  const indices = Object.values(build.functions).map(([index]) => index);
  const names = functionNames(bytes, nameSection, indices);
  for (const [index, expected] of Object.values(build.functions)) {
    if (names.get(index) !== expected) throw new Error(`function ${index} is ${names.get(index)}, expected ${expected}`);
  }

  const code = sections.find((section) => section.id === 10);
  // [prologue, params, scratch local index]: the scratch local must be a declared i32.
  const targets = new Map([
    [build.functions.svFrame[0] - importedFunctions, [svFramePrologue(build), 1, 1]],
    [build.functions.netGetLoopPacket[0] - importedFunctions, [netGetLoopPacketPrologue(build), 3, 4]],
  ]);

  // Optional per build (P3, P4).
  const assertIndex = build.functions.assertHandler ? build.functions.assertHandler[0] - importedFunctions : -1;
  const cachedTagIndex = build.functions.cachedTagUpdate && build.functions.comError ? build.functions.cachedTagUpdate[0] - importedFunctions : -1;

  let [count, at] = readUleb(bytes, code.body);
  const parts = [Uint8Array.from(uleb(count))];
  let patched = 0;
  for (let i = 0; i < count; i += 1) {
    const [size, bodyStart] = readUleb(bytes, at);
    const bodyEnd = bodyStart + size;
    const target = targets.get(i);
    if (assertIndex === i) {
      const body = nonFatalAssert(bytes.subarray(bodyStart, bodyEnd), 4);
      parts.push(Uint8Array.from(uleb(body.length)), body);
      patched += 1;
    } else if (cachedTagIndex === i) {
      // Com_Error(errorParm_t, const char*, ...) takes three i32s in wasm (code, format, varargs pointer).
      const body = neutralizeCalls(bytes.subarray(bodyStart, bodyEnd), build.functions.comError[0], 3, 2);
      parts.push(Uint8Array.from(uleb(body.length)), body);
      patched += 1;
    } else if (target) {
      const [prologue, params, scratch] = target;
      // Skip the local declarations; the prologue goes before the first instruction.
      let [groups, p] = readUleb(bytes, bodyStart);
      let next = params, scratchType = null;
      for (let g = 0; g < groups; g += 1) {
        let n;
        [n, p] = readUleb(bytes, p);
        if (scratch >= next && scratch < next + n) scratchType = bytes[p];
        next += n;
        p += 1;
      }
      if (scratchType !== 0x7f) throw new Error(`patch target ${i + importedFunctions}: local ${scratch} is not an i32`);
      const body = new Uint8Array(size + prologue.length);
      body.set(bytes.subarray(bodyStart, p), 0);
      body.set(prologue, p - bodyStart);
      body.set(bytes.subarray(p, bodyEnd), p - bodyStart + prologue.length);
      parts.push(Uint8Array.from(uleb(body.length)), body);
      patched += 1;
    } else {
      parts.push(bytes.subarray(at, bodyEnd));
    }
    at = bodyEnd;
  }
  if (patched !== targets.size + (assertIndex >= 0 ? 1 : 0) + (cachedTagIndex >= 0 ? 1 : 0)) throw new Error("patch targets not found");

  const bodyLength = parts.reduce((sum, part) => sum + part.length, 0);
  const header = Uint8Array.from([10, ...uleb(bodyLength)]);
  const out = new Uint8Array(code.start + header.length + bodyLength + (bytes.length - code.end));
  out.set(bytes.subarray(0, code.start), 0);
  let o = code.start;
  out.set(header, o); o += header.length;
  for (const part of parts) { out.set(part, o); o += part.length; }
  out.set(bytes.subarray(code.end), o);
  return out;
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
