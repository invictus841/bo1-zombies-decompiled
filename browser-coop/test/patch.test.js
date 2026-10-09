import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { BUILDS } from "../extension/src/layout.js";
import { functionNames, inspectWasm, patchEngine, sha256Hex } from "../extension/src/patch.js";

const uleb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const str = (s) => [...uleb(s.length), ...new TextEncoder().encode(s)];
const section = (id, body) => [id, ...uleb(body.length), ...body];
const vec = (items) => [...uleb(items.length), ...items.flat()];

/**
 * A tiny module shaped like the engine where it matters: one imported function (so indices shift), a shared
 * memory, the four functions the patch uses with the same signatures, and a name section.
 */
function miniEngine() {
  const types = vec([
    [0x60, 1, 0x7f, 1, 0x7f], // 0: (i32) -> i32          SV_Frame wrapper
    [0x60, 3, 0x7f, 0x7f, 0x7f, 1, 0x7f], // 1: (i32 i32 i32) -> i32   NET_GetLoopPacket
    [0x60, 2, 0x7f, 0x7f, 0], // 2: (i32 i32) -> ()       Cbuf_AddText
    [0x60, 0, 0], // 3: () -> ()             SV_WaitServer
  ]);
  const imports = vec([
    [...str("env"), ...str("tick"), 0x00, 3],
    [...str("env"), ...str("memory"), 0x02, 0x03, 1, 1], // shared, min 1, max 1 page
  ]);
  const functions = vec([[2], [3], [0], [1]]); // indices 1..4
  const body = (bytes) => [...uleb(bytes.length), ...bytes];
  const code = vec([
    body([0x00, 0x0b]),
    body([0x00, 0x0b]),
    body([0x01, 0x02, 0x7f, 0x20, 0x00, 0x0b]), // 2 x i32 locals; return msec
    body([0x01, 0x02, 0x7f, 0x41, 0x00, 0x0b]), // 2 x i32 locals; return 0
  ]);
  const names = vec([[1, ...str("cbuf")], [2, ...str("wait")], [3, ...str("svframe")], [4, ...str("getloop")]]);
  const nameSection = [...str("name"), ...section(1, names)];
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, types), ...section(2, imports), ...section(3, functions), ...section(10, code), ...section(0, nameSection),
  ]);
}

const miniBuild = {
  ...Object.values(BUILDS)[0],
  functions: { svFrame: [3, "svframe"], netGetLoopPacket: [4, "getloop"], cbufAddText: [1, "cbuf"], svWaitServer: [2, "wait"] },
  flags: { cmd: 1024, freeze: 1028, inq: 1032 },
  loopback: { ...Object.values(BUILDS)[0].loopback, base: 0 },
};

test("inspectWasm counts imported functions and finds names", () => {
  const bytes = miniEngine();
  assert.ok(WebAssembly.validate(bytes));
  const { importedFunctions, nameSection } = inspectWasm(bytes);
  assert.equal(importedFunctions, 1);
  assert.deepEqual([...functionNames(bytes, nameSection, [3, 4]).entries()], [[3, "svframe"], [4, "getloop"]]);
});

test("patchEngine adds both prologues and the result is valid wasm", () => {
  const bytes = miniEngine();
  const out = patchEngine(bytes, "mini", miniBuild);
  assert.ok(WebAssembly.validate(out), "patched module must validate");
  assert.ok(out.length > bytes.length);
  // The patched bodies contain the atomic xchg (CMD) and atomic loads of FREEZE/INQ.
  const hex = Buffer.from(out).toString("hex");
  assert.ok(hex.includes("fe41"), "i32.atomic.rmw.xchg");
  assert.ok(hex.includes("fe10"), "i32.atomic.load");
});

test("patchEngine refuses builds whose function names do not match", () => {
  const wrong = { ...miniBuild, functions: { ...miniBuild.functions, svFrame: [3, "something_else"] } };
  assert.throws(() => patchEngine(miniEngine(), "mini", wrong), /expected something_else/);
  assert.throws(() => patchEngine(miniEngine(), "not-a-known-hash"), /unknown engine build/);
});

test("patchEngine refuses a scratch local that is not an i32", () => {
  const bytes = miniEngine();
  // Turn the SV_Frame stand-in's locals into f32 (0x7d): its body declares `01 02 7f`.
  const at = Buffer.from(bytes).indexOf(Buffer.from([0x01, 0x02, 0x7f, 0x20, 0x00, 0x0b]));
  bytes[at + 2] = 0x7d;
  assert.throws(() => patchEngine(bytes, "mini", miniBuild), /not an i32/);
});

// With the real engine (BO1Z_ENGINE_WASM=/path/to/KisakBlack-web.wasm, as served by vel.gg): the known build patches
// into a valid module. Skipped when the file is not available.
const enginePath = process.env.BO1Z_ENGINE_WASM;
test("the real vel.gg engine patches into a valid module", { skip: !enginePath && "set BO1Z_ENGINE_WASM to run" }, async () => {
  const bytes = new Uint8Array(fs.readFileSync(enginePath));
  const hash = await sha256Hex(bytes);
  assert.ok(BUILDS[hash], `engine ${hash} is not a known build`);
  const out = patchEngine(bytes, hash);
  assert.ok(WebAssembly.validate(out));
});
