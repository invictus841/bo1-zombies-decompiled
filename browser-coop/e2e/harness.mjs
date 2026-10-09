// Drives real Chrome on vel.gg with the extension's script injected at document_start (as the MAIN-world content
// script would be). One Chrome profile per player: the game keeps each player's map pack in that profile's storage.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

export const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const PROFILES = process.env.E2E_PROFILES ?? path.join(path.dirname(new URL(import.meta.url).pathname), ".profiles");
export const OUT = process.env.E2E_OUT ?? path.join(path.dirname(new URL(import.meta.url).pathname), ".out");
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Test-only page settings. Automated Chrome has no audio output, which stalls the load video's clock: mute.
// Headless Chrome cannot lock the pointer: pretend it did.
export const TEST_PRELUDE = `globalThis.__kisakMuted = true;`;
export const POINTER_SHIM = `(() => { let lock = null;
  Object.defineProperty(Document.prototype, 'pointerLockElement', { configurable: true, get() { return lock; } });
  Element.prototype.requestPointerLock = function () { lock = this; queueMicrotask(() => document.dispatchEvent(new Event('pointerlockchange'))); return Promise.resolve(); };
  Document.prototype.exitPointerLock = function () { lock = null; queueMicrotask(() => document.dispatchEvent(new Event('pointerlockchange'))); };
})();`;

export async function launch(name, { headless = true, scripts = [], width = 1280, height = 720 } = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  const userDataDir = path.join(PROFILES, name);
  fs.mkdirSync(userDataDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless, userDataDir, defaultViewport: { width, height }, protocolTimeout: 600000,
    args: ["--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required",
      "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessForWorkers,PrivateNetworkAccessRespectPreflightResults,BackgroundVideoTrackOptimization,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
      "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
      "--enable-unsafe-webgpu", `--window-size=${width},${height + 100}`],
  });
  const [page] = await browser.pages();
  const log = fs.createWriteStream(path.join(OUT, `${name}.console.log`), { flags: "w" });
  const stamp = () => new Date().toISOString().slice(11, 23);
  page.on("console", (m) => log.write(`[${stamp()}] ${m.type()} ${m.text()}\n`));
  page.on("pageerror", (e) => log.write(`[${stamp()}] PAGEERROR ${e.stack ?? e}\n`));
  for (const script of scripts) await page.evaluateOnNewDocument(script);
  return { browser, page, log, name };
}

export async function waitFor(page, fn, { timeout = 600000, every = 1000, label = "", arg, describe } = {}) {
  const started = Date.now();
  let last = "";
  for (;;) {
    const value = await page.evaluate(fn, arg).catch((error) => ({ __error: String(error) }));
    if (value?.fail) throw new Error(`${label}: ${value.fail}`);
    if (value && !value.__error) return value;
    const status = describe ? JSON.stringify(await page.evaluate(describe).catch((e) => String(e))) : "";
    if (status !== last) { console.log(`[${label}] ${((Date.now() - started) / 1000).toFixed(0)}s ${status}`); last = status; }
    if (Date.now() - started > timeout) throw new Error(`timeout: ${label}`);
    await sleep(every);
  }
}

export const describePage = () => {
  const c = window.__bo1zCoop;
  return { screen: window.five?.screen, load: window.five?.load?.label, phase: c?.phase, socket: c?.socket, peer: c?.peer,
    error: c?.error, patched: c?.patched, conn: c?.mem?.connectionState(), slot: c?.guestSlot, gate: c?.gate, stats: c?.stats && { out: c.stats.packetsOut, in: c.stats.packetsIn, lost: c.stats.lost, rtt: c.stats.rtt && Math.round(c.stats.rtt) } };
};

/** Opens a map page and presses a key at "Press any key to start". */
export async function openMap(page, url, label) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitFor(page, () => { const b = document.getElementById("play"); return b && !b.disabled && /key/i.test(b.textContent) ? true : null; },
    { label: `${label}:start-key`, timeout: 120000, describe: describePage });
  await page.keyboard.press("Enter");
}
