// Two-player end-to-end test on the real vel.gg game: a host and a guest Chrome (separate profiles), the extension
// injected into both, and a relay (default: local `npm run dev:relay` on :8787; RELAY=https://... for a deployed one).
//   node e2e/coop.mjs            MAP=kino (default)  HEADFUL=1 to watch  EXTRA_QUERY='&coopUncapped=0'
import fs from "node:fs";
import path from "node:path";
import { launch, openMap, waitFor, describePage, sleep, TEST_PRELUDE, POINTER_SHIM, OUT } from "./harness.mjs";
import { createRoomCode } from "../shared/protocol.js";

const relay = process.env.RELAY ?? "http://127.0.0.1:8787";
const map = process.env.MAP ?? "kino";
const headless = !process.env.HEADFUL;
const room = createRoomCode();
const extension = fs.readFileSync(new URL("../extension/dist/coop-main.js", import.meta.url), "utf8");
const scripts = [TEST_PRELUDE, ...(headless ? [POINTER_SHIM] : []), extension];
const url = (role) => `https://vel.gg/bo1z/${map}?coop=${role}&room=${room}&coopRelay=${encodeURIComponent(relay)}&telemetry=0${process.env.EXTRA_QUERY ?? ""}`;
const failed = () => { const c = window.__bo1zCoop; return c?.error ? { fail: c.error } : c?.phase === "failed" ? { fail: "phase failed" } : null; };

console.log(`room ${room}, relay ${relay}, map ${map}`);
const host = await launch("host", { headless, scripts });
const guest = await launch("guest", { headless, scripts });
let ok = false;
try {
  await openMap(host.page, url("host"), "host");
  await waitFor(host.page, () => window.five?.screen === "ready" ? true : window.__bo1zCoop?.error ? { fail: window.__bo1zCoop.error } : null,
    { label: "host:ready", describe: describePage });
  console.log("host ready, start gated:", await host.page.evaluate(() => window.__bo1zCoop.gate));

  await openMap(guest.page, url("join"), "guest");
  await waitFor(guest.page, (f) => window.__bo1zCoop?.phase === "connected" ? true : new Function(`return (${f})()`)(),
    { label: "guest:connected", describe: describePage, arg: failed.toString(), timeout: 900000 });
  await waitFor(host.page, () => window.__bo1zCoop?.guestSlot?.state === 5 ? true : null, { label: "host:guest-active", describe: describePage, timeout: 120000 });
  console.log("host sees player 2 active:", JSON.stringify(await host.page.evaluate(() => window.__bo1zCoop.guestSlot)));

  // Both click in ("Click to start"); the start gate is open now.
  for (const p of [host, guest]) await p.page.keyboard.press("Enter");
  for (const p of [host, guest]) await waitFor(p.page, () => window.five?.screen === "playing" ? true : null, { label: `${p.name}:playing`, describe: describePage, timeout: 60000 });
  await sleep(8000);
  for (const p of [host, guest]) await p.page.screenshot({ path: path.join(OUT, `${p.name}-1.png`) });

  // Player 2 walks forward and turns; player 1 shoots once.
  await guest.page.keyboard.down("KeyW"); await sleep(2500); await guest.page.keyboard.up("KeyW");
  await host.page.mouse.down(); await sleep(150); await host.page.mouse.up();
  await sleep(4000);
  for (const p of [host, guest]) await p.page.screenshot({ path: path.join(OUT, `${p.name}-2.png`) });

  await host.page.evaluate(() => window.__bo1zCoop.mem.command("status"));
  await sleep(1500);
  for (const p of [host, guest]) console.log(p.name, JSON.stringify(await p.page.evaluate(describePage)));
  ok = true;
  console.log("COOP OK");
} catch (error) {
  console.log("COOP FAIL", error.stack ?? error);
  for (const p of [host, guest]) {
    console.log(p.name, JSON.stringify(await p.page.evaluate(describePage).catch((e) => String(e))));
    await p.page.screenshot({ path: path.join(OUT, `${p.name}-fail.png`) }).catch(() => {});
  }
} finally {
  for (const p of [host, guest]) {
    const log = await p.page.evaluate(() => window.__bo1zCoop?.log?.join("\n")).catch(() => "");
    console.log(`--- ${p.name} co-op log\n${log}`);
    await p.browser.close().catch(() => {});
  }
  process.exit(ok ? 0 : 1);
}
