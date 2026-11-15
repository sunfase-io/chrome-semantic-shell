#!/usr/bin/env node
/**
 * Measure which CDP measures keep a hidden Chrome page running: requestAnimationFrame, timers, CSS
 * transitions, IntersectionObserver, CDP input and screenshots. Runs a throwaway Chrome instance with
 * its own temporary profile, so the user's browser and profile are never touched.
 *
 *   node tests/browser-automation/background-probe.mjs --out docs/browser-background-probe-<date>.json
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    chrome: { type: 'string', default: 'C:/Program Files/Google/Chrome/Application/chrome.exe' },
    scenarios: { type: 'string' },
    measures: { type: 'string' },
  },
});
const only = (list) => (name) => !list || list.split(',').includes(name);
if (!args.out) throw new Error('--out is required');

const PAGE = `<!doctype html><meta charset="utf-8"><title>background probe</title>
<style>#box{opacity:0;transition:opacity 120ms linear}#box.on{opacity:1}
#btn{position:fixed;left:20px;top:60px;width:120px;height:40px}</style>
<div id="box">box</div><button id="btn">btn</button><div style="height:3000px"></div><div id="far">far</div>
<script>
const c = { raf: 0, timeout: 0, clicks: 0, trusted: 0, moves: 0, io: 0 };
const raf = () => { c.raf++; requestAnimationFrame(raf); };
requestAnimationFrame(raf);
const tick = () => { c.timeout++; setTimeout(tick, 0); };
setTimeout(tick, 0);
btn.addEventListener('click', (e) => { c.clicks++; if (e.isTrusted) c.trusted++; });
addEventListener('mousemove', () => c.moves++);
new IntersectionObserver((entries) => { c.io += entries.filter((e) => e.isIntersecting).length; }).observe(far);
window.__probe = {
  reset() { for (const k in c) c[k] = 0; box.classList.remove('on'); box.offsetWidth; box.classList.add('on'); },
  read: () => ({ ...c, visibility: document.visibilityState, hasFocus: document.hasFocus(), opacity: getComputedStyle(box).opacity }),
};
</script>`;

class Cdp {
  #id = 0;
  #pending = new Map();
  #listeners = new Set();

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolveOpen, reject) => {
      ws.onopen = resolveOpen;
      ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
    });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.ws = ws;
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id === undefined) return this.#listeners.forEach((listener) => listener(message));
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) pending?.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending?.resolve(message.result);
    };
  }

  send(method, params = {}, sessionId, timeoutMs = 10_000) {
    const id = ++this.#id;
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectSend(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
      this.#pending.set(id, { method, resolve: settle(resolveSend), reject: settle(rejectSend) });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener) {
    this.#listeners.add(listener);
  }
}

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await Promise.resolve().then(fn).catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${what} not ready after ${timeoutMs}ms`);
    await sleep(100);
  }
}

async function timed(fn) {
  const start = performance.now();
  const ms = () => Math.round(performance.now() - start);
  try {
    await fn();
    return { ok: true, ms: ms() };
  } catch (error) {
    return { ok: false, ms: ms(), error: error.message };
  }
}

const server = createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE));
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync(join(tmpdir(), 'chrome-probe-'));
const browser = spawn(
  args.chrome,
  [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--window-position=0,0', '--window-size=1000,760', 'about:blank'],
  { stdio: 'ignore' },
);

let cdp;
try {
  const [port, path] = await waitFor(
    () => readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n'),
    20_000,
    'DevToolsActivePort',
  );
  cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
  const send = (method, params, sessionId, timeoutMs) => cdp.send(method, params, sessionId, timeoutMs);
  const evaluate = (sessionId, expression, timeoutMs = 5000) =>
    send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId, timeoutMs).then((r) => {
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    });

  const frames = new Map();
  cdp.on(({ method, params, sessionId }) => {
    if (method !== 'Page.screencastFrame') return;
    frames.set(sessionId, (frames.get(sessionId) || 0) + 1);
    send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => undefined);
  });

  const bounds = { left: 120, top: 120, width: 900, height: 680 };
  const windowOf = async (targetId) => (await send('Browser.getWindowForTarget', { targetId })).windowId;
  const place = async (targetId) =>
    send('Browser.setWindowBounds', { windowId: await windowOf(targetId), bounds: { windowState: 'normal' } })
      .then(async () => send('Browser.setWindowBounds', { windowId: await windowOf(targetId), bounds }));
  const newWindow = async (target) => {
    const { targetId } = await send('Target.createTarget', { url: target, newWindow: true, background: true });
    await place(targetId);
    return targetId;
  };

  // Each scenario hides the probe page for a different reason; `hide` runs after the page has loaded.
  const SCENARIOS = {
    // The window the user looks at; only a locked screen hides it.
    'front-window': {
      open: async () => {
        const targetId = await newWindow(url);
        await send('Target.activateTarget', { targetId });
        return targetId;
      },
    },
    'background-tab': {
      open: async () => (await send('Target.createTarget', { url, background: true })).targetId,
    },
    'unfocused-window': { open: () => newWindow(url) },
    'occluded-window': {
      open: () => newWindow(url),
      hide: async () => [await newWindow('about:blank')],
    },
    'minimized-window': {
      open: () => newWindow(url),
      hide: async (targetId) => {
        await send('Browser.setWindowBounds', { windowId: await windowOf(targetId), bounds: { windowState: 'minimized' } });
        return [];
      },
    },
  };
  const screencast = (sessionId) =>
    send('Page.startScreencast', { format: 'jpeg', quality: 10, maxWidth: 160, maxHeight: 120, everyNthFrame: 1 }, sessionId);
  // The production setting: the cheapest capture that still keeps the compositor producing frames.
  const liteScreencast = (sessionId) =>
    send('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 32, maxHeight: 32, everyNthFrame: 60 }, sessionId);
  const focus = (sessionId) => send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
  const MEASURES = {
    none: async () => undefined,
    focus,
    screencast,
    'focus+screencast': async (sessionId) => { await focus(sessionId); await screencast(sessionId); },
    'focus+lite': async (sessionId) => { await focus(sessionId); await liteScreencast(sessionId); },
  };

  async function sample(sessionId) {
    frames.set(sessionId, 0);
    await evaluate(sessionId, '__probe.reset()');
    await sleep(1000);
    const rates = await evaluate(sessionId, '__probe.read()');
    const rafAwait = await timed(() => evaluate(sessionId, 'new Promise((r) => requestAnimationFrame(() => r(true)))', 2000));
    const timer50 = await timed(() => evaluate(sessionId, 'new Promise((r) => setTimeout(() => r(true), 50))', 3000));
    const mouseMove = await timed(() => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 80, y: 80 }, sessionId, 3000));
    const click = await timed(async () => {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: 80, y: 80, button: 'left', clickCount: 1 }, sessionId, 3000);
      }
    });
    await evaluate(sessionId, 'far.scrollIntoView(), true');
    await sleep(500);
    const screenshot = await timed(() => send('Page.captureScreenshot', { format: 'png' }, sessionId, 3000));
    const after = await evaluate(sessionId, '__probe.read()');
    return {
      visibility: rates.visibility,
      hasFocus: rates.hasFocus,
      rafPerSec: rates.raf,
      timeoutsPerSec: rates.timeout,
      transitionDone: rates.opacity === '1',
      rafAwait,
      timer50,
      mouseMove,
      click,
      trustedClicks: after.trusted,
      intersection: after.io > 0,
      screenshot,
      screencastFrames: frames.get(sessionId),
    };
  }

  const version = await send('Browser.getVersion');
  const results = [];
  for (const [scenario, { open, hide }] of Object.entries(SCENARIOS).filter(([name]) => only(args.scenarios)(name))) {
    for (const [measure, apply] of Object.entries(MEASURES).filter(([name]) => only(args.measures)(name))) {
      const targetId = await open();
      const extra = [];
      try {
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
        await send('Page.enable', {}, sessionId);
        await waitFor(() => evaluate(sessionId, 'document.readyState === "complete" && !!window.__probe'), 10_000, 'probe page');
        if (hide) extra.push(...(await hide(targetId)));
        await sleep(1000); // native occlusion is recalculated asynchronously
        const baseline = await evaluate(sessionId, '({ visibility: document.visibilityState, hasFocus: document.hasFocus() })');
        await apply(sessionId);
        await sleep(300);
        const row = { scenario, measure, baseline, ...(await sample(sessionId)) };
        results.push(row);
        console.log(
          [scenario.padEnd(17), measure.padEnd(17), `base=${baseline.visibility}`.padEnd(15), `vis=${row.visibility}`.padEnd(13),
            `raf/s=${row.rafPerSec}`.padEnd(10), `timers/s=${row.timeoutsPerSec}`.padEnd(14), `transition=${row.transitionDone}`,
            `rafAwait=${row.rafAwait.ok ? row.rafAwait.ms : 'X'}`, `timer50=${row.timer50.ms}`, `move=${row.mouseMove.ok ? row.mouseMove.ms : 'X'}`,
            `click=${row.click.ok ? row.click.ms : 'X'}/${row.trustedClicks}`, `io=${row.intersection}`,
            `shot=${row.screenshot.ok ? row.screenshot.ms : 'X'}`, `frames=${row.screencastFrames}`].join(' '),
        );
      } finally {
        for (const id of [targetId, ...extra]) await send('Target.closeTarget', { targetId: id }).catch(() => undefined);
      }
    }
  }
  const report = { generated_utc: new Date().toISOString(), chrome: version.product, platform: process.platform, results };
  writeFileSync(resolve(args.out), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`report -> ${resolve(args.out)}`);
} finally {
  await cdp?.send('Browser.close').catch(() => undefined);
  cdp?.ws.close();
  server.close();
  // A Chrome that ignores Browser.close (it hung once with the display off) must not hold the probe.
  if (browser.exitCode === null) {
    const exited = new Promise((resolveExit) => browser.once('exit', resolveExit));
    if (!(await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]))) {
      execFileSync('taskkill', ['/PID', String(browser.pid), '/T', '/F']);
      await exited;
    }
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
