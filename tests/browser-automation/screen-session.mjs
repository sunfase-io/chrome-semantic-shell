#!/usr/bin/env node
/**
 * Hide the whole screen, then measure while it stays hidden: raw CDP measures in a throwaway Chrome
 * (background-probe.mjs) and chrome-shell end to end on the user's Chrome (run_live.py, rendering
 * cases). The user restores the screen afterwards.
 *
 *   lock         the Windows lock screen
 *   display-off  the display turned off the way the idle timeout does (a monitor's own button leaves it
 *                on for Windows and Chrome)
 *
 * The screen state is recorded before, during and after, as Chrome (chrome.idle; LogonUI.exe may keep
 * running after an unlock) and Windows (display-state.ps1) report it.
 *
 *   node tests/browser-automation/screen-session.mjs --screen display-off --date 2026-11-15
 */
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    screen: { type: 'string' },
    date: { type: 'string' },
    endpoint: { type: 'string', default: 'http://127.0.0.1:12306/chrome/shell' },
    cases: {
      type: 'string',
      default:
        'perception,form,check,dblclick,keyboard,hover,scroll,drag,async-wait,wait-idle-gone,dialog-role,type-trusted,' +
        'screenshot,screenshot-element,screenshot-full,element-fixed-row,element-message-box,element-select,browser-dialog',
    },
  },
});
const here = dirname(fileURLToPath(import.meta.url));
const docs = resolve(here, '../../docs');
const EXTENSION_PAGE = 'chrome-extension://hnhimbinihlfejljamlgfniplabkaamk/offscreen.html';

async function shell(script, tabId) {
  const response = await fetch(args.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ script, output: 'json', timeoutMs: 15_000, ...(tabId ? { tabId } : {}) }),
  });
  const envelope = await response.json();
  const result = JSON.parse(envelope.content[0].text);
  if (!result.ok) throw new Error(`${script}: ${JSON.stringify(result.steps.at(-1))}`);
  return result;
}

/** chrome.idle as the extension sees it: active, idle or locked. */
async function idleState() {
  const tab = (await shell(`tab new ${EXTENSION_PAGE}`)).tabId;
  try {
    const { steps } = await shell('js code="chrome.idle.queryState(15)"', tab);
    return JSON.parse(steps[0].detail).result;
  } finally {
    await shell(`tab close ${tab}`);
  }
}

const display = (...flags) =>
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'display-state.ps1'), ...flags], {
    encoding: 'utf8',
  }).trim();

const state = async () => ({ idle: await idleState(), display: display() });

const SCREENS = {
  lock: {
    hidden: (s) => s.idle === 'locked',
    hide: () => execFileSync('rundll32.exe', ['user32.dll,LockWorkStation']),
  },
  'display-off': {
    hidden: (s) => s.display === 'off',
    hide: () => display('-Off'),
  },
};
const screen = SCREENS[args.screen];
if (!screen) throw new Error(`--screen must be one of ${Object.keys(SCREENS).join(', ')}`);
if (!args.date) throw new Error('--date is required');

function run(command, commandArgs) {
  return new Promise((resolveRun) => {
    const child = spawn(command, commandArgs, { cwd: here, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => resolveRun(code));
  });
}

const report = { generated_utc: new Date().toISOString(), screen: args.screen, before: await state() };
// A screen the user or Windows already hid is measured as it is.
if (!screen.hidden(report.before)) screen.hide();
for (let waited = 0; !screen.hidden(await state()); waited += 500) {
  if (waited > 15_000) throw new Error(`the screen did not reach ${args.screen}`);
  await sleep(500);
}
await sleep(3000); // Chrome recomputes window occlusion asynchronously
report.during = await state();
const probe = join(docs, `browser-${args.screen}-probe-${args.date}.json`);
report.probe = { file: basename(probe), exitCode: await run(process.execPath, ['background-probe.mjs', '--out', probe]) };
const regression = join(docs, `browser-${args.screen}-regression-${args.date}.json`);
report.regression = {
  file: basename(regression),
  exitCode: await run('python', ['-X', 'utf8', 'run_live.py', '--endpoint', args.endpoint, '--cases', args.cases, '--out', regression]),
};
report.after = await state();
writeFileSync(join(docs, `browser-${args.screen}-session-${args.date}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
