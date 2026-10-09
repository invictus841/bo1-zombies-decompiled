// BO1 Zombies co-op for vel.gg: entry point, injected into vel.gg pages (MAIN world, document_start).
//
// Host:  plays as usual. The extension gives its server a second "loopback" player whose packets come from the relay.
// Guest: loads the same map as usual, then freezes its own local server and connects its player to the host instead.
// The relay (relay/src/index.js, a Cloudflare Durable Object) carries the engine's own packets between the two pages.
// Without ?coop= in the URL nothing is patched and the game runs exactly as on vel.gg.

import { BUILDS, CLIENT_STATE, CONNECTION } from "./layout.js";
import { patchEngine, sha256Hex } from "./patch.js";
import { EngineMemory } from "./engine-mem.js";
import { ringOffsets } from "./rings.js";
import { createRoomCode, normalizeRoomCode } from "../../shared/protocol.js";
import { Panel } from "./ui.js";
import { GamepadControl, AIM_SPEEDS } from "./gamepad.js";

/* global __PUMP_SOURCE__, __VERSION__ */
const VERSION = __VERSION__;
const DEFAULT_RELAY = "https://bo1-zombies-coop-relay.macosapp.workers.dev";
const BASE = "/bo1z/";
// maps.js MAP_LIST: zone -> page slug
const MAP_SLUGS = {
  zombie_pentagon: "five", zombie_theater: "kino", zombie_cod5_factory: "riese", zombie_cod5_prototype: "nacht",
  zombie_cod5_asylum: "verruckt", zombie_cod5_sumpf: "shinonuma", zombie_cosmodrome: "ascension", zombie_coast: "cotd",
  zombie_temple: "shangrila", zombie_moon: "moon",
};
const MAP_NAMES = {
  five: '"Five"', kino: "Kino der Toten", riese: "Der Riese", nacht: "Nacht der Untoten", verruckt: "Verrückt",
  shinonuma: "Shi No Numa", ascension: "Ascension", cotd: "Call of the Dead", shangrila: "Shangri-La", moon: "Moon",
};
// Dvars that change the game itself (mods, horde settings): the guest copies the host's values.
const GAME_DVARS = /^(fs_mods|horde_[a-z_]+|kisak_mod_[a-z_]+|r_mod_[a-z_]+|r_dobjLimit|cg_mod_[a-z_]+|zinfo|noperks)$/i;
const KICK_AFTER_MS = 15000;
const HOST_GONE_MS = 10000;

if (!window.__bo1zCoop) start();

function start() {
  const params = new URLSearchParams(location.search);
  const requested = params.get("coop");
  const room = normalizeRoomCode(params.get("room") ?? "");
  const relayOverride = params.get("coopRelay");
  const coop = (window.__bo1zCoop = {
    version: VERSION,
    mode: room && requested === "host" ? "host" : room && requested === "join" ? "guest" : null,
    room,
    relay: relayBase(relayOverride),
    relayParam: relayOverride && isLoopback(relayOverride) ? `&coopRelay=${encodeURIComponent(relayOverride)}` : "",
    uncapped: params.get("coopUncapped") !== "0",
    // Controller support needs the patched engine (its command mailbox), so with it on the engine is patched in
    // solo games too. Off: solo games run exactly as on vel.gg.
    controller: readSetting("bo1z-coop-controller", "1") !== "0",
    aimLevel: Math.max(0, Math.min(AIM_SPEEDS.length - 1, Number(readSetting("bo1z-coop-aim", "4")) || 0)),
    socket: "idle",
    peer: false,
    peerInfo: null,
    peerState: null,
    stats: null,
    hash: null,
    build: null,
    patched: false,
    error: null,
    notice: null,
    phase: "idle",
    mem: null,
    rings: null,
    zone: null,
    gameArgs: null,
    guestSlot: null,
    copiedAt: 0,
    refreshRate: 60,
    log: [],
  });
  const note = (text) => {
    coop.log.push(`${new Date().toISOString().slice(11, 23)} ${text}`);
    if (coop.log.length > 200) coop.log.shift();
  };
  coop.note = note;

  installWasmHook(coop);
  installCallMainHook(coop);
  measureRefreshRate(coop);

  const panel = new Panel({
    host: () => go(`${BASE}?coop=host&room=${createRoomCode()}${coop.relayParam}`),
    join: (text) => {
      const code = normalizeRoomCode(text);
      if (!code) { coop.notice = "That is not a room code. Paste the invite link or the 16-letter code."; return; }
      go(`${BASE}?coop=join&room=${code}${coop.relayParam}`);
    },
    copy: () => {
      navigator.clipboard?.writeText(inviteLink(coop)).then(() => { coop.copiedAt = Date.now(); }, () => { coop.notice = inviteLink(coop); });
    },
    leave: () => { coop.pump?.postMessage({ type: "close" }); go(location.pathname); },
    startNow: () => { coop.startAlone = true; },
    controller: () => {
      coop.controller = !coop.controller;
      saveSetting("bo1z-coop-controller", coop.controller ? "1" : "0");
      coop.notice = "Reload the page to apply the controller setting.";
    },
    aimDown: () => setAim(coop, coop.aimLevel - 1),
    aimUp: () => setAim(coop, coop.aimLevel + 1),
  });
  coop.panel = panel;
  panel.mount();

  if (coop.controller) {
    coop.gamepad = new GamepadControl({
      // Only while our player is in a game: the engine runs the commands and the menus own the cursor.
      engine: () => (coop.mem && coop.patched && coop.mem.connectionState() === CONNECTION.active
        ? { Module: coop.mem.Module, command: (text) => coop.mem.command(text) } : null),
      canvasSize: () => { const canvas = document.getElementById("game"); return { width: canvas?.width || 1280, height: canvas?.height || 720 }; },
      aimLevel: coop.aimLevel,
    });
    coop.gamepad.start();
  }

  if (coop.mode) {
    coop.phase = coop.mode === "host" ? "hosting" : "joining-room";
    coop.pump = startPump(coop);
    if (coop.mode === "host") installStartWait(coop, panel);
  }
  setInterval(() => tick(coop), 50);
}

// ---------------------------------------------------------------------------------------------------------------
// Hooks

function installWasmHook(coop) {
  const nativeInstantiate = WebAssembly.instantiate;
  const nativeStreaming = WebAssembly.instantiateStreaming;
  const isEngine = (url) => /\/artifacts\/KisakBlack-web\.wasm(\?|$)/.test(url ?? "");

  async function prepare(bytes) {
    coop.hash = await sha256Hex(bytes);
    coop.build = BUILDS[coop.hash] ?? null;
    if (!coop.build) {
      coop.error = "vel.gg updated its game engine, and this version of the extension does not know it yet: co-op and the controller are off.";
      coop.note(`unknown engine build ${coop.hash}`);
      return bytes;
    }
    try {
      const patched = patchEngine(bytes, coop.hash, coop.build);
      coop.patched = true;
      coop.note("engine patched");
      return patched;
    } catch (error) {
      coop.error = `Could not prepare the engine (${error.message}): co-op and the controller are off.`;
      coop.note(`patch failed: ${error.stack ?? error}`);
      return bytes;
    }
  }

  WebAssembly.instantiateStreaming = async function (source, imports) {
    if (!(coop.mode || coop.controller) || coop.hash) return nativeStreaming.call(WebAssembly, source, imports);
    const response = await source;
    if (!isEngine(response.url)) return nativeStreaming.call(WebAssembly, response, imports);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return nativeInstantiate.call(WebAssembly, await prepare(bytes), imports);
  };
  WebAssembly.instantiate = function (source, imports) {
    // The glue's fallback path (no streaming) passes the raw bytes.
    const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : null;
    if ((coop.mode || coop.controller) && !coop.hash && bytes && bytes.byteLength > 5e6) {
      return prepare(bytes.slice()).then((ready) => nativeInstantiate.call(WebAssembly, ready, imports));
    }
    return nativeInstantiate.call(WebAssembly, source, imports);
  };
}

// The Emscripten glue does Module["callMain"] = callMain on the object engine.js passed in, and engine.js calls
// module.callMain(args) later without awaiting it. A one-shot setter captures that Module and wraps callMain, which
// lets co-op set up its rings and adjust the arguments before the engine's main() runs.
function installCallMainHook(coop) {
  Object.defineProperty(Object.prototype, "callMain", {
    configurable: true,
    enumerable: false,
    set(original) {
      delete Object.prototype.callMain;
      const Module = this;
      Object.defineProperty(Module, "callMain", {
        configurable: true,
        enumerable: true,
        writable: true,
        value(args) {
          if (!coop.mode && coop.patched) coop.mem = new EngineMemory(Module, coop.build); // solo, for the controller
          if (!coop.mode || !coop.patched) return original.call(this, args);
          return (async () => {
            try {
              if (coop.mode === "host") setupHost(coop, Module, args);
              else await setupGuest(coop, Module, args);
            } catch (error) {
              coop.error = error.message;
              coop.note(`setup failed: ${error.stack ?? error}`);
              coop.mem?.setInboundRing(0);
            }
            return original.call(this, args);
          })();
        },
      });
    },
  });
}

// In BO1 zombies a player who joins after the round has started watches until the next round. So while player 2
// is in the room but not in the game yet, the host's "click to start" waits (the card offers "Start now").
// Only the host waits: a guest that cannot click in sends no moves and times out.
function installStartWait(coop, panel) {
  const block = (event) => {
    if (!coop.gate || event.composedPath?.().includes(panel.host)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
  };
  for (const type of ["keydown", "keyup", "mousedown", "mouseup", "click", "pointerdown", "pointerup"]) {
    window.addEventListener(type, block, true);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Relay pump (a worker; see pump-worker.js)

function startPump(coop) {
  const url = URL.createObjectURL(new Blob([__PUMP_SOURCE__], { type: "text/javascript" }));
  const worker = new Worker(url, { name: "bo1z-coop-pump" });
  worker.onmessage = (event) => {
    const message = event.data;
    if (message.type === "socket") {
      coop.socket = message.state;
      if (message.state !== "open") coop.peer = false;
      if (message.state === "closed" && message.code === 4001) coop.error = "This room was opened in another tab or window.";
      coop.note(`relay ${message.state}${message.code ? ` ${message.code}` : ""}`);
    } else if (message.type === "control") {
      onControl(coop, message.message);
    } else if (message.type === "stats") {
      coop.stats = message.stats;
    }
  };
  worker.onerror = (event) => { coop.error = `Co-op worker failed: ${event.message}`; };
  worker.postMessage({ type: "connect", relay: coop.relay, room: coop.room, role: coop.mode });
  return worker;
}

function send(coop, message) {
  coop.pump?.postMessage({ type: "send", message });
}

function onControl(coop, message) {
  switch (message.t) {
    case "welcome":
      coop.peer = Boolean(message.peer);
      coop.peerSeenAt = Date.now();
      if (coop.peer) greet(coop);
      return;
    case "peer":
      coop.peer = Boolean(message.present);
      if (coop.peer) { coop.peerSeenAt = Date.now(); greet(coop); }
      else coop.peerLeftAt = Date.now();
      coop.note(`other player ${coop.peer ? "joined the room" : "left the room"}`);
      return;
    case "error":
      coop.note(`relay error ${message.code}`);
      return;
    case "info":
      if (coop.mode === "guest") onHostInfo(coop, message);
      return;
    case "state":
      coop.peerState = message;
      return;
  }
}

function greet(coop) {
  if (coop.mode === "host") sendInfo(coop);
  else send(coop, { t: "state", phase: coop.phase, v: VERSION });
}

function sendInfo(coop) {
  const zone = coop.zone ?? currentZone();
  send(coop, {
    t: "info",
    v: VERSION,
    hash: coop.hash,
    zone,
    slug: MAP_SLUGS[zone] ?? null,
    horde: currentHorde(),
    gameArgs: coop.gameArgs,
  });
}

function onHostInfo(coop, info) {
  coop.peerInfo = info;
  if (!info.slug || coop.mem) return; // host still choosing, or our engine already runs
  if (currentSlug() === info.slug && currentHorde() === Boolean(info.horde)) return;
  coop.phase = "following";
  go(`${BASE}${info.slug}?coop=join&room=${coop.room}${info.horde ? "&horde=1" : ""}${coop.relayParam}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Engine setup (inside the callMain wrapper, before main() runs)

function setupHost(coop, Module, args) {
  const mem = new EngineMemory(Module, coop.build);
  if (!mem.mailboxesClear()) throw new Error("Unexpected engine memory: co-op is off.");
  const rings = mem.allocateRemoteRings();
  mem.setInboundRing(rings.inPort);
  coop.mem = mem;
  coop.rings = rings;
  // Keep the host's server running when its tab is hidden: drive the engine loop with a timer instead of
  // requestAnimationFrame (which stops in background tabs), capped at the display's refresh rate.
  if (coop.uncapped) insertBeforeDevmap(args, ["+set", "kisak_web_uncapped", "1", "+set", "com_maxfps", String(coop.refreshRate)]);
  coop.zone = devmapZone(args);
  coop.gameArgs = gameDvars(args);
  coop.pump.postMessage({
    type: "attach",
    memory: mem.memory,
    layout: coop.build,
    readBase: rings.out.base,
    writeBase: rings.in.base,
    writePort: rings.port,
    advanceGet: true,
    reading: true,
    injecting: true,
    dropOutOfBand: ["rcon"],
  });
  coop.note(`host rings: out ${rings.port} in ${rings.inPort}`);
  if (coop.peer) sendInfo(coop);
}

async function setupGuest(coop, Module, args) {
  const info = await until(() => (coop.peerInfo?.zone ? coop.peerInfo : null), 30000);
  if (!info) throw new Error("The host did not answer. Check that their game page is open, then reload.");
  if (info.hash && info.hash !== coop.hash) throw new Error("You and the host have different versions of the game. Reload both pages.");
  const zone = devmapZone(args);
  if (zone !== info.zone) throw new Error(`The host is playing ${MAP_NAMES[info.slug] ?? info.zone}. Reload this page.`);
  if (Array.isArray(info.gameArgs)) applyGameDvars(args, info.gameArgs);
  const mem = new EngineMemory(Module, coop.build);
  if (!mem.mailboxesClear()) throw new Error("Unexpected engine memory: co-op is off.");
  coop.mem = mem;
  coop.zone = zone;
  coop.pump.postMessage({
    type: "attach",
    memory: mem.memory,
    layout: coop.build,
    readBase: ringOffsets(coop.build, 1).base, // our client -> server ring: forwarded to the host once connected
    writeBase: ringOffsets(coop.build, 0).base, // server -> our client ring: the host's packets go here
    writePort: 0,
    advanceGet: true,
    reading: false,
    injecting: false,
  });
  coop.phase = "loading";
}

// ---------------------------------------------------------------------------------------------------------------
// Per-tick state machines

function tick(coop) {
  try {
    if (coop.mode === "host") hostTick(coop);
    if (coop.mode === "guest") guestTick(coop);
  } catch (error) {
    coop.error = error.message;
    coop.note(`tick failed: ${error.stack ?? error}`);
  }
  coop.panel.render(view(coop));
}

function hostTick(coop) {
  const screen = window.five?.screen;
  const mem = coop.mem;
  const ready = Boolean(mem) && (screen === "ready" || screen === "playing");
  const slot = mem && coop.rings ? mem.serverClients().find((c) => c.loopback && c.port === coop.rings.port) ?? null : null;
  coop.guestSlot = slot;
  const state = { t: "state", ready, slot: slot?.state ?? 0, screen };
  const key = JSON.stringify(state);
  if (coop.peer && key !== coop.lastStateKey) {
    coop.lastStateKey = key;
    send(coop, state);
  }
  if (!coop.peer) coop.lastStateKey = null;
  coop.gate = screen === "ready" && coop.peer && !coop.startAlone && !(slot && slot.state === CLIENT_STATE.active);
  // The start screen holds the whole game on its first frame (intro hold), and a held game answers nobody. Once
  // player 2 has loaded the map and is about to join, release the hold as the host's own click would.
  const guestJoining = ["waiting-host", "freezing", "connect", "challenging", "joining"].includes(coop.peerState?.phase);
  if (mem && coop.peer && guestJoining && screen === "ready" && !coop.introReleased && mem.int(coop.build.browser.introState) === 1) {
    coop.introReleased = true;
    mem.Module._KB_Input?.(7, 1, 0);
    coop.note("released the start hold so player 2 can join");
  }
  // A paused server ignores join requests, and alone the host's server pauses on the start screen (intro hold) and
  // in the pause menu. While player 2 is in the room but not in the game yet, keep it running. (With two players
  // in the game the server never pauses anyway.)
  if (mem && coop.peer && !(slot && slot.state === CLIENT_STATE.active)) {
    if (mem.dvarInt("clPaused")) mem.setDvarInt("clPaused", 0);
    if (mem.dvarInt("svPaused")) mem.setDvarInt("svPaused", 0);
  }
  // The guest closed its page: free its slot once it is clearly gone (a reload comes back within seconds).
  if (slot && !coop.peer && coop.peerLeftAt && Date.now() - coop.peerLeftAt > KICK_AFTER_MS && coop.kickedAt !== coop.peerLeftAt) {
    if (mem.command(`clientkick ${slot.slot}`)) {
      coop.kickedAt = coop.peerLeftAt;
      coop.note(`removed player 2 (slot ${slot.slot})`);
    }
  }
}

// Guest phases in which our client talks to the host. Pausing them would only stop our moves reaching the host
// (our own server is frozen), so the pause menu and the start hold must not pause the client.
const GUEST_LINKED = ["challenging", "joining", "connected"];

function guestTick(coop) {
  if (coop.mem && GUEST_LINKED.includes(coop.phase)) {
    if (coop.mem.dvarInt("clPaused")) coop.mem.setDvarInt("clPaused", 0);
    if (coop.mem.dvarInt("svPaused")) coop.mem.setDvarInt("svPaused", 0);
  }
  if (coop.peer && coop.phase !== coop.sentPhase) {
    coop.sentPhase = coop.phase;
    send(coop, { t: "state", phase: coop.phase, v: VERSION });
  }
  if (!coop.peer) coop.sentPhase = null;
  const mem = coop.mem;
  const screen = window.five?.screen;
  const conn = mem?.connectionState();
  const hostReady = coop.peer && coop.peerState?.ready;
  switch (coop.phase) {
    case "loading":
      if (screen === "ready" || screen === "playing") coop.phase = "waiting-host";
      break;
    case "waiting-host":
      if (hostReady) {
        // Freeze our own server: from now on nothing in our engine reads ring 1, so the page can forward it.
        mem.setFreeze(true);
        coop.freezeAt = Date.now();
        coop.phase = "freezing";
        coop.note("freezing local server");
      }
      break;
    case "freezing":
      if (!mem.serverDrainsPackets() || Date.now() - coop.freezeAt > 5000) {
        if (mem.serverDrainsPackets()) coop.note("local server still drains packets after 5 s; continuing");
        mem.setDvarInt("svPaused", 0); // the intro hold paused it; a paused listen server would freeze our clock
        coop.pump.postMessage({ type: "read", dropUntilConnect: true });
        coop.pump.postMessage({ type: "inject", on: false, clearInbox: true });
        coop.phase = "connect";
      }
      break;
    case "connect":
      // Our client must not sit on the start screen's hold: a held client sends no moves, and the host's server
      // times a player out while it waits for the first one. Release it as the page's own click would.
      if (!coop.introReleased && mem.int(coop.build.browser.introState) === 1) {
        coop.introReleased = true;
        mem.Module._KB_Input?.(7, 1, 0);
      }
      // "LOCALHOST", not "localhost": the exact lowercase name would also shut our local server down.
      if (mem.command("connect LOCALHOST")) {
        coop.joinedLate = coop.peerState?.screen === "playing";
        coop.connectAt = Date.now();
        coop.phase = "challenging";
        coop.note("connect sent");
      }
      break;
    case "challenging":
      // connect set our server address to loopback:3074; the host's packets arrive as loopback:0.
      if (conn >= CONNECTION.connecting && conn <= CONNECTION.challenging && mem.setServerAddressPort(0) && mem.serverAddressPort() === 0) {
        coop.pump.postMessage({ type: "inject", on: true });
        coop.phase = "joining";
        coop.note("challenging; injecting host packets");
      } else if (Date.now() - coop.connectAt > 15000) {
        coop.error = "Could not start the connection to the host. Reload both pages.";
        coop.phase = "failed";
      }
      break;
    case "joining":
      if (mem.serverAddressPort() !== 0) mem.setServerAddressPort(0);
      if (conn === CONNECTION.active) {
        coop.phase = "connected";
        coop.note("connected to host");
      } else if (Date.now() - coop.connectAt > 90000) {
        coop.error = "The host did not let us in. Reload both pages and try again.";
        coop.phase = "failed";
      }
      break;
    case "connected":
      if (conn < CONNECTION.challenging) {
        coop.phase = "ended";
        coop.note("disconnected");
      } else if (!coop.peer && coop.peerLeftAt && Date.now() - coop.peerLeftAt > HOST_GONE_MS) {
        coop.phase = "ended";
        coop.notice = "The host left the game.";
        mem.command("disconnect");
      }
      break;
    default:
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Panel view

function view(coop) {
  const blocks = [];
  const screen = window.five?.screen;
  const playing = screen === "playing";
  if (coop.error) blocks.push({ kind: "text", cls: "error", text: coop.error });
  if (coop.notice) blocks.push({ kind: "text", cls: "muted small", text: coop.notice });

  if (!coop.mode) {
    blocks.push({ kind: "text", cls: "muted", text: "Play zombies with a friend: one hosts, the other joins with the invite link. Both need this extension." });
    blocks.push({ kind: "buttons", buttons: [{ act: "host", label: "Host a game", primary: true }] });
    blocks.push({ kind: "join" });
    blocks.push(...controllerBlocks(coop));
    return { tone: "", blocks, compact: playing && !coop.error && !coop.notice, pill: coop.gamepad?.status === "active" ? "🎮" : "" };
  }

  const relay = coop.socket === "open" ? "connected" : coop.socket === "connecting" ? "connecting…" : coop.socket === "closed" ? "reconnecting…" : "starting…";
  const rtt = coop.stats?.rtt != null ? `${Math.round(coop.stats.rtt)} ms` : "–";
  let tone = coop.error ? "bad" : "wait";
  let pill = "";

  if (coop.mode === "host") {
    const slot = coop.guestSlot;
    const guestJoining = ["freezing", "connect", "challenging", "joining"].includes(coop.peerState?.phase);
    const p2 = !coop.peer ? (slot ? "reconnecting…" : "not here yet") : !slot ? (guestJoining ? "joining…" : "loading the map…") : slot.state === CLIENT_STATE.active ? "in the game" : "joining…";
    if (slot?.state === CLIENT_STATE.active && coop.peer) tone = "ok";
    blocks.push({ kind: "text", text: "You are hosting. Send this invite link to player 2:" });
    blocks.push({ kind: "code", text: coop.room });
    blocks.push({ kind: "buttons", buttons: [{ act: "copy", label: Date.now() - coop.copiedAt < 2000 ? "Copied!" : "Copy invite link", primary: true }] });
    blocks.push({ kind: "lines", lines: [["Relay", relay], ["Player 2", p2], ["Ping", rtt]] });
    if (!coop.mem && screen !== "loading" && screen !== "download") {
      blocks.push({ kind: "text", cls: "muted small", text: "Pick a map. Player 2 follows you to it." });
    } else if (coop.gate) {
      blocks.push({ kind: "text", text: "Player 2 is on the way. Your start waits for them, so they spawn with you." });
      blocks.push({ kind: "buttons", buttons: [{ act: "startNow", label: "Start now" }] });
    } else if (!(slot?.state === CLIENT_STATE.active)) {
      blocks.push({ kind: "text", cls: "muted small", text: "If you start before player 2 is in, they watch until the next round (the BO1 rule for latecomers)." });
    }
    pill = `Co-op · P2 ${slot?.state === CLIENT_STATE.active && coop.peer ? "in" : "not in"} · ${rtt}`;
  } else {
    const host = coop.peerInfo?.slug ? MAP_NAMES[coop.peerInfo.slug] : null;
    const steps = {
      "joining-room": coop.peer ? (host ? `Opening ${host}…` : "Waiting for the host to pick a map…") : "Waiting for the host…",
      following: `Opening ${host ?? "the host's map"}…`,
      loading: "Loading the map…",
      "waiting-host": coop.peer ? "Waiting for the host to finish loading…" : "Waiting for the host…",
      freezing: "Connecting…",
      connect: "Connecting…",
      challenging: "Connecting…",
      joining: "Joining the host's game…",
      connected: "In the host's game.",
      ended: "Disconnected from the host.",
      failed: "Could not join.",
    };
    if (coop.phase === "connected") tone = "ok";
    const onHostMap = coop.peerInfo?.slug && currentSlug() === coop.peerInfo.slug;
    if ((coop.phase === "loading" || (coop.phase === "joining-room" && onHostMap)) && screen === "landing") {
      blocks.push({ kind: "text", text: "Press any key on the page to load the map." });
    }
    blocks.push({ kind: "text", text: steps[coop.phase] ?? "Joining…" });
    if (coop.joinedLate && ["joining", "connected"].includes(coop.phase)) {
      blocks.push({ kind: "text", cls: "muted small", text: "The host had already started, so you watch until the next round, then spawn (the BO1 rule for latecomers)." });
    }
    blocks.push({ kind: "lines", lines: [["Room", coop.room], ["Relay", relay], ["Host", coop.peer ? "here" : "not here"], ["Ping", rtt]] });
    if (coop.phase === "connected" && screen === "ready") blocks.push({ kind: "text", cls: "muted small", text: "Click the game to play." });
    pill = `Co-op · ${coop.phase === "connected" ? "with host" : steps[coop.phase] ?? ""} · ${rtt}`;
  }
  if (coop.stats?.lost) blocks.push({ kind: "text", cls: "muted small", text: `${coop.stats.lost} packets dropped` });
  blocks.push(...controllerBlocks(coop));
  if (coop.gamepad?.status === "active") pill += " · 🎮";
  blocks.push({ kind: "buttons", buttons: [{ act: "leave", label: "Leave co-op" }] });
  return { tone, blocks, compact: playing && !coop.error, pill };
}

function controllerBlocks(coop) {
  const pad = coop.gamepad;
  const name = pad?.name ? pad.name.replace(/\s*\(.*$/, "").slice(0, 32) : "";
  const status = !coop.controller ? "off"
    : !coop.patched && coop.hash ? "unavailable"
    : !pad || pad.status === "none" ? "press any button on it"
    : pad.status === "active" ? `${name} · aim ${coop.aimLevel + 1}/${AIM_SPEEDS.length}`
    : `${name} · works once you are in the game`;
  const buttons = coop.controller && pad?.status !== "none"
    ? [{ act: "aimDown", label: "Aim −" }, { act: "aimUp", label: "Aim +" }, { act: "controller", label: "Turn off" }]
    : [{ act: "controller", label: coop.controller ? "Turn controller off" : "Turn controller on" }];
  return [{ kind: "lines", lines: [["Controller", status]] }, { kind: "buttons", buttons }];
}

function setAim(coop, level) {
  coop.aimLevel = Math.max(0, Math.min(AIM_SPEEDS.length - 1, level));
  if (coop.gamepad) coop.gamepad.aimLevel = coop.aimLevel;
  saveSetting("bo1z-coop-aim", String(coop.aimLevel));
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

function readSetting(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function saveSetting(key, value) {
  try { localStorage.setItem(key, value); } catch { /* not kept */ }
}

function go(url) { location.assign(url); }

function inviteLink(coop) { return `${location.origin}${BASE}?coop=join&room=${coop.room}${coop.relayParam}`; }

function isLoopback(url) {
  try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname); } catch { return false; }
}

function relayBase(override) {
  if (override && isLoopback(override)) return override;
  try {
    const saved = localStorage.getItem("bo1z-coop-relay");
    if (saved && /^(https|wss):\/\//.test(saved)) return saved;
  } catch { /* storage disabled */ }
  return DEFAULT_RELAY;
}

function currentZone() {
  const zone = document.documentElement?.dataset.map;
  if (zone) return zone;
  const slug = currentSlug();
  return Object.keys(MAP_SLUGS).find((z) => MAP_SLUGS[z] === slug) ?? null;
}
function currentSlug() {
  const zone = document.documentElement?.dataset.map;
  if (zone && MAP_SLUGS[zone]) return MAP_SLUGS[zone];
  const match = location.pathname.match(/^\/(?:bo1z\/)?([a-z]+)\/?$/);
  return match && Object.values(MAP_SLUGS).includes(match[1]) ? match[1] : null;
}
function currentHorde() {
  return document.documentElement?.dataset.mode === "horde" || new URLSearchParams(location.search).get("horde") === "1";
}

function devmapZone(args) {
  const i = args.indexOf("+devmap");
  return i >= 0 ? args[i + 1] : null;
}
function insertBeforeDevmap(args, extra) {
  const i = args.indexOf("+devmap");
  args.splice(i < 0 ? args.length : i, 0, ...extra);
}
function gameDvars(args) {
  const out = [];
  for (let i = 0; i + 2 < args.length; i += 1) if (args[i] === "+set" && GAME_DVARS.test(args[i + 1])) out.push([args[i + 1], args[i + 2]]);
  return out;
}
function applyGameDvars(args, dvars) {
  for (let i = args.length - 3; i >= 0; i -= 1) if (args[i] === "+set" && GAME_DVARS.test(args[i + 1])) args.splice(i, 3);
  const safe = dvars.filter(([k, v]) => typeof k === "string" && GAME_DVARS.test(k) && typeof v === "string" && /^[\w .-]{0,64}$/.test(v));
  insertBeforeDevmap(args, safe.flatMap(([k, v]) => ["+set", k, v]));
}

function until(fn, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      const value = fn();
      if (value || Date.now() - startedAt > timeoutMs) resolve(value ?? null);
      else setTimeout(check, 100);
    };
    check();
  });
}

function measureRefreshRate(coop) {
  const times = [];
  const step = (t) => {
    times.push(t);
    if (times.length < 30) { requestAnimationFrame(step); return; }
    const deltas = times.slice(1).map((v, i) => v - times[i]).sort((a, b) => a - b);
    const median = deltas[deltas.length >> 1];
    if (median > 0) coop.refreshRate = Math.max(30, Math.min(240, Math.round(1000 / median)));
  };
  requestAnimationFrame(step);
}
