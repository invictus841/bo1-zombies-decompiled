import assert from "node:assert/strict";
import test from "node:test";

import { GamepadControl } from "../extension/src/gamepad.js";

// A fake standard-mapping pad and engine; update() is driven by hand with frame times.
function rig({ menu = false } = {}) {
  const pad = { id: "DualSense Wireless Controller (STANDARD GAMEPAD)", connected: true, mapping: "standard",
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
  Object.defineProperty(globalThis.navigator, "getGamepads", { configurable: true, value: () => [pad] });
  const commands = [], inputs = [];
  const engine = {
    Module: { _KB_UIState: () => (menu ? 1 : 0), _KB_Input: (...a) => { inputs.push(a); return 1; } },
    command: (text) => { commands.push(...text.split(";")); return true; },
  };
  const control = new GamepadControl({ engine: () => engine, canvasSize: () => ({ width: 1280, height: 720 }) });
  let time = 0;
  const frame = () => control.update((time += 16));
  const press = (i, on = true) => { pad.buttons[i] = { pressed: on, value: on ? 1 : 0 }; };
  return { pad, control, commands, inputs, frame, press, setMenu: (v) => { menu = v; } };
}

test("buttons trigger the engine actions on press and release", () => {
  const { commands, frame, press } = rig();
  frame();
  press(7); frame(); // R2
  press(7, false); frame();
  press(11); frame(); // R3
  press(11, false); frame();
  press(3); frame(); // Triangle
  assert.deepEqual(commands, ["+attack", "-attack", "+melee", "-melee", "weapnext"]);
});

test("the left stick drives analog movement with private key numbers", () => {
  const { pad, commands, frame } = rig();
  pad.axes = [0, -1, 0, 0]; frame();
  pad.axes = [0, -0.5, 0, 0]; frame();
  pad.axes = [0, 0, 0, 0]; frame();
  assert.equal(commands[0], "+forward 301 0 1");
  assert.match(commands[1], /^\+forward 301 0 0\.4/);
  assert.equal(commands[2], "-forward 301");
});

test("circle: tap crouches, hold goes prone", async () => {
  const { commands, frame, press } = rig();
  press(1); frame(); press(1, false); frame();
  assert.deepEqual(commands, ["togglecrouch"]);
  press(1); frame();
  await new Promise((r) => setTimeout(r, 380));
  frame(); press(1, false); frame();
  assert.deepEqual(commands, ["togglecrouch", "toggleprone"]);
});

test("the right stick aims through mouse motion; nothing inside the deadzone", () => {
  const { pad, inputs, frame } = rig();
  frame();
  pad.axes = [0, 0, 0.05, 0.05]; frame();
  assert.equal(inputs.length, 0);
  pad.axes = [0, 0, 1, 0]; frame(); frame();
  const motion = inputs.filter((i) => i[0] === 2);
  assert.ok(motion.length > 0 && motion.every(([, dx, dy]) => dx > 0 && dy === 0));
});

test("in a menu the stick moves the cursor and cross clicks; held actions are released", () => {
  const r = rig();
  r.press(7); r.frame(); // fire held
  r.setMenu(true);
  r.press(7, false);
  r.pad.axes = [1, 0, 0, 0]; r.frame();
  r.press(0); r.frame(); r.press(0, false); r.frame();
  assert.ok(r.commands.includes("-attack"));
  assert.ok(r.inputs.some((i) => i[0] === 4 && i[1] > 640));
  assert.ok(r.inputs.some((i) => i[0] === 0 && i[1] === 200 && i[2] === 1));
  assert.ok(r.inputs.some((i) => i[0] === 0 && i[1] === 200 && i[2] === 0));
});
