// Game controller (PS5 DualSense, PS4, Xbox, ...) for the vel.gg game, through the browser Gamepad API.
// Buttons trigger the engine's own actions (+attack, +melee, ...) as console commands through the patched engine's
// command mailbox, so they do not depend on keyboard bindings. The left stick drives the analog movement buttons
// (+forward ... take a strength as their third argument); the right stick aims through the same mouse-motion input
// the page sends. When a game menu owns the cursor, the stick moves the cursor and Cross clicks.

// Standard Gamepad mapping (https://w3c.github.io/gamepad/#remapping), PlayStation names.
const B = { cross: 0, circle: 1, square: 2, triangle: 3, l1: 4, r1: 5, l2: 6, r2: 7, create: 8, options: 9,
  l3: 10, r3: 11, up: 12, down: 13, left: 14, right: 15 };

// Held actions: pressing sends "+name", releasing sends "-name".
const HOLD = new Map([
  [B.cross, "gostand"], // jump
  [B.square, "usereload"], // reload; hold to use / buy / revive
  [B.l1, "smoke"], // special grenade (monkey bomb, ...)
  [B.r1, "frag"], // grenade
  [B.l2, "speed_throw"], // aim down sights
  [B.r2, "attack"], // fire
  [B.create, "scores"],
  [B.r3, "melee"],
]);
const SLOTS = new Map([[B.up, 1], [B.down, 2], [B.left, 3], [B.right, 4]]); // +actionslot N
// Engine key codes (the page's input.js): menu navigation.
const KEY = { escape: 27, enter: 13, up: 154, down: 155, left: 156, right: 157, mouse1: 200 };
// Private "key numbers" for the movement buttons, so releasing them never releases a held keyboard key.
const MOVE = { forward: 301, back: 302, moveleft: 303, moveright: 304 };

const STICK_DEADZONE = 0.16, AIM_DEADZONE = 0.12, TRIGGER = 0.35, PRONE_HOLD_MS = 350;

export const AIM_SPEEDS = [400, 600, 800, 1000, 1250, 1500, 1800, 2100, 2500, 3000]; // px/s at full tilt

export class GamepadControl {
  /**
   * engine(): { Module, command(text) } or null while the game is not ready; canvasSize(): { width, height }.
   */
  constructor({ engine, canvasSize, aimLevel = 4 }) {
    this.engine = engine;
    this.canvasSize = canvasSize;
    this.aimLevel = aimLevel;
    this.pad = null;
    this.prev = [];
    this.held = new Set(); // actions currently "+"
    this.move = { forward: 0, back: 0, moveleft: 0, moveright: 0 };
    this.sprinting = false;
    this.circleAt = 0;
    this.proned = false;
    this.aimCarry = [0, 0];
    this.cursor = null;
    this.queue = [];
    this.lastTime = 0;
    this.status = "none";
    this.name = "";
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const frame = (time) => {
      if (!this.running) return;
      try { this.update(time); } catch (error) { this.status = `error: ${error.message}`; }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    addEventListener("blur", () => this.releaseAll());
  }

  findPad() {
    const pads = navigator.getGamepads?.() ?? [];
    return [...pads].find((pad) => pad && pad.connected && pad.mapping === "standard") ?? [...pads].find((pad) => pad && pad.connected) ?? null;
  }

  update(time) {
    const dt = this.lastTime ? Math.min(0.1, (time - this.lastTime) / 1000) : 0;
    this.lastTime = time;
    const pad = this.findPad();
    if (!pad) {
      if (this.pad) this.releaseAll();
      this.pad = null;
      this.status = "none";
      return;
    }
    this.pad = pad;
    this.name = pad.id;
    const engine = this.engine();
    if (!engine) { this.status = "waiting"; return; }
    this.status = "active";

    const pressed = pad.buttons.map((b, i) => (i === B.l2 || i === B.r2 ? b.value > TRIGGER : b.pressed));
    const edge = (i) => pressed[i] && !this.prev[i];
    const released = (i) => !pressed[i] && this.prev[i];
    const menu = Boolean(engine.Module._KB_UIState?.() & 1);

    if (menu) {
      this.releaseGameplay();
      this.menuInput(engine, pad, pressed, edge, released, dt);
    } else {
      this.cursor = null;
      this.gameplayInput(engine, pad, pressed, edge, released, dt);
    }
    this.prev = pressed;
    this.flush(engine);
  }

  gameplayInput(engine, pad, pressed, edge, released, dt) {
    for (const [button, action] of HOLD) {
      if (edge(button)) this.press(action);
      if (released(button)) this.lift(action);
    }
    for (const [button, slot] of SLOTS) {
      if (edge(button)) this.queue.push(`+actionslot ${slot}`);
      if (released(button)) this.queue.push(`-actionslot ${slot}`);
    }
    if (edge(B.triangle)) this.queue.push("weapnext");
    if (edge(B.options)) this.tapKey(engine, KEY.escape);
    // Circle: tap = crouch / stand, hold = prone.
    if (edge(B.circle)) { this.circleAt = performance.now(); this.proned = false; }
    if (pressed[B.circle] && !this.proned && performance.now() - this.circleAt > PRONE_HOLD_MS) { this.queue.push("toggleprone"); this.proned = true; }
    if (released(B.circle) && !this.proned) this.queue.push("togglecrouch");

    // Left stick: analog movement.
    const [lx, ly] = radial(pad.axes[0] ?? 0, pad.axes[1] ?? 0, STICK_DEADZONE);
    this.setMove("forward", Math.max(0, -ly));
    this.setMove("back", Math.max(0, ly));
    this.setMove("moveleft", Math.max(0, -lx));
    this.setMove("moveright", Math.max(0, lx));
    // L3: sprint until the stick comes back (as on console).
    if (edge(B.l3) && !this.sprinting) { this.queue.push("+breath_sprint"); this.sprinting = true; }
    if (this.sprinting && Math.hypot(lx, ly) < 0.3) { this.queue.push("-breath_sprint"); this.sprinting = false; }

    // Right stick: aim, with a curve for precision near the centre and slower while aiming down sights.
    const [rx, ry] = radial(pad.axes[2] ?? 0, pad.axes[3] ?? 0, AIM_DEADZONE);
    const magnitude = Math.hypot(rx, ry);
    if (magnitude > 0) {
      const speed = AIM_SPEEDS[this.aimLevel] * magnitude ** 1.6 / magnitude * (pressed[B.l2] ? 0.5 : 1);
      this.aimCarry[0] += rx * speed * dt;
      this.aimCarry[1] += ry * speed * dt;
      const dx = Math.trunc(this.aimCarry[0]), dy = Math.trunc(this.aimCarry[1]);
      this.aimCarry[0] -= dx; this.aimCarry[1] -= dy;
      if (dx || dy) engine.Module._KB_Input(2, dx, dy);
    }
  }

  menuInput(engine, pad, pressed, edge, released, dt) {
    const size = this.canvasSize();
    if (!this.cursor) this.cursor = [size.width / 2, size.height / 2];
    const [lx, ly] = radial(pad.axes[0] ?? 0, pad.axes[1] ?? 0, STICK_DEADZONE);
    const [rx, ry] = radial(pad.axes[2] ?? 0, pad.axes[3] ?? 0, AIM_DEADZONE);
    const vx = lx || rx, vy = ly || ry;
    if (vx || vy) {
      const speed = size.height * 1.1; // a screen height per second at full tilt
      this.cursor[0] = clamp(this.cursor[0] + vx * speed * dt, 0, size.width - 1);
      this.cursor[1] = clamp(this.cursor[1] + vy * speed * dt, 0, size.height - 1);
      engine.Module._KB_Input(4, Math.round(this.cursor[0]), Math.round(this.cursor[1]));
    }
    if (edge(B.cross)) engine.Module._KB_Input(0, KEY.mouse1, 1);
    if (released(B.cross)) engine.Module._KB_Input(0, KEY.mouse1, 0);
    if (edge(B.circle) || edge(B.options)) this.tapKey(engine, KEY.escape);
    for (const [button, key] of [[B.up, KEY.up], [B.down, KEY.down], [B.left, KEY.left], [B.right, KEY.right]]) {
      if (edge(button)) this.tapKey(engine, key);
    }
  }

  press(action) { if (!this.held.has(action)) { this.held.add(action); this.queue.push(`+${action}`); } }
  lift(action) { if (this.held.delete(action)) this.queue.push(`-${action}`); }
  tapKey(engine, key) { engine.Module._KB_Input(0, key, 1); engine.Module._KB_Input(0, key, 0); }

  setMove(action, value) {
    const previous = this.move[action];
    const rounded = Math.round(value * 20) / 20; // 5% steps: fewer commands
    if (rounded === previous) return;
    this.move[action] = rounded;
    if (rounded > 0) this.queue.push(`+${action} ${MOVE[action]} 0 ${rounded}`);
    else this.queue.push(`-${action} ${MOVE[action]}`);
  }

  releaseGameplay() {
    for (const action of [...this.held]) this.lift(action);
    for (const action of Object.keys(this.move)) this.setMove(action, 0);
    if (this.sprinting) { this.queue.push("-breath_sprint"); this.sprinting = false; }
  }

  releaseAll() {
    this.releaseGameplay();
    this.prev = [];
    const engine = this.engine();
    if (engine) this.flush(engine);
  }

  /** One command string per frame through the mailbox; kept while the previous one is still pending. */
  flush(engine) {
    if (!this.queue.length) return;
    if (this.queue.length > 200) this.queue.splice(0, this.queue.length - 200);
    // The mailbox buffer holds 1 KB: send what fits, the rest next frame.
    let count = 0, length = 0;
    while (count < this.queue.length && length + this.queue[count].length + 1 < 900) length += this.queue[count++].length + 1;
    if (engine.command(this.queue.slice(0, count).join(";"))) this.queue.splice(0, count);
  }
}

function radial(x, y, deadzone) {
  const magnitude = Math.hypot(x, y);
  if (magnitude < deadzone) return [0, 0];
  const scaled = Math.min(1, (magnitude - deadzone) / (1 - deadzone));
  return [(x / magnitude) * scaled, (y / magnitude) * scaled];
}

function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
