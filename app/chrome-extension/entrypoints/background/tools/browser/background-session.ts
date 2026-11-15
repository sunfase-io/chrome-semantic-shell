import { cdpSessionManager } from '@/utils/cdp-session-manager';

/**
 * Keeps a tab the user is not looking at behaving like a foreground tab, without activating it or
 * focusing its window (measured in docs/browser-background-probe-2026-11-13.json).
 *
 * Chrome stops animation frames, freezes transitions, throttles timers to 1 Hz and drops CDP input
 * for a page it considers hidden. Focus emulation makes the page visible and focused again; that
 * alone restores full rendering for the active tab of a window behind another application. A
 * background tab or a minimized window also needs a minimal screencast to keep frames coming.
 *
 * With saved autofill data Chrome ends the debugging session when an email field keeps the focus of
 * such a page: its suggestion popup cannot show there. With capture the field needs only ~30 ms of
 * focus, with focus emulation alone ~300 ms; a fill focuses for ~100 ms. A program therefore attaches
 * again before its next command and leaves capture off for that tab afterwards (ForegroundScope).
 *
 * A session lingers briefly after its last hold so consecutive programs reuse one debugger attachment
 * instead of flashing Chrome's "started debugging" bar on every call.
 */
const OWNER = 'background-session';
const LINGER_MS = 15_000;
// The cheapest capture that still keeps frames coming: Chrome rarely even emits one.
const SCREENCAST = { format: 'jpeg', quality: 1, maxWidth: 32, maxHeight: 32, everyNthFrame: 60 };
/** Endings by Chrome a program tolerates per tab before running it on the hidden page. */
const MAX_ENDINGS = 2;

/**
 * front: active tab of the focused window. behind: active tab of a window behind another application.
 * hidden: the rest, and every tab while the screen is locked.
 */
export type TabView = 'front' | 'behind' | 'hidden';

export interface ForegroundHold {
  release(): void;
  /** Why Chrome ended the session while held; the hold no longer keeps the tab rendering. */
  readonly ended?: string;
}

interface Hold {
  ended?: string;
}

interface Session {
  holds: Set<Hold>;
  capture: boolean;
  ready: Promise<void>;
  linger?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<number, Session>();
const stopping = new Map<number, Promise<void>>();
let listening = false;

const send = (tabId: number, method: string, params?: object) => cdpSessionManager.sendCommand(tabId, method, params);

function listen(): void {
  if (listening) return;
  listening = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method !== 'Page.screencastFrame' || source.tabId === undefined || !sessions.has(source.tabId)) return;
    const frame = params as { sessionId: number };
    void chrome.debugger.sendCommand(source, 'Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
  });
  cdpSessionManager.onDetached((tabId, reason) => {
    const session = sessions.get(tabId);
    if (!session) return;
    drop(tabId);
    for (const hold of session.holds) hold.ended = reason;
  });
  chrome.tabs.onRemoved.addListener(drop);
}

function drop(tabId: number): void {
  clearTimeout(sessions.get(tabId)?.linger);
  sessions.delete(tabId);
}

async function start(tabId: number, capture: boolean): Promise<void> {
  await stopping.get(tabId);
  await cdpSessionManager.attach(tabId, OWNER);
  try {
    await send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    if (capture) await send(tabId, 'Page.startScreencast', SCREENCAST);
  } catch (error) {
    await cdpSessionManager.detach(tabId, OWNER);
    throw error;
  }
}

async function stop(tabId: number, capture: boolean): Promise<void> {
  // Teardown of a tab that may already be gone: each step is independent and allowed to miss.
  if (capture) await send(tabId, 'Page.stopScreencast').catch(() => undefined);
  await send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
  await cdpSessionManager.detach(tabId, OWNER);
}

function release(tabId: number, session: Session, hold: Hold): void {
  session.holds.delete(hold);
  if (session.holds.size || sessions.get(tabId) !== session) return;
  session.linger = setTimeout(() => {
    if (sessions.get(tabId) !== session) return;
    sessions.delete(tabId);
    const done = session.ready
      .catch(() => undefined)
      .then(() => stop(tabId, session.capture))
      .finally(() => stopping.get(tabId) === done && stopping.delete(tabId));
    stopping.set(tabId, done);
  }, LINGER_MS);
}

/**
 * Keep `tabId` rendering and accepting input like a foreground tab until the hold is released or
 * Chrome ends the session. `capture` adds the screencast a background tab or a minimized window needs.
 */
export async function holdForeground(tabId: number, capture: boolean): Promise<ForegroundHold> {
  listen();
  let session = sessions.get(tabId);
  if (!session) {
    session = { holds: new Set(), capture, ready: start(tabId, capture) };
    sessions.set(tabId, session);
  } else {
    clearTimeout(session.linger);
    session.linger = undefined;
    if (capture && !session.capture) {
      session.capture = true;
      session.ready = session.ready.then(() => send(tabId, 'Page.startScreencast', SCREENCAST));
    }
  }
  const held = session;
  const hold: Hold = {};
  held.holds.add(hold);
  try {
    await held.ready;
  } catch (error) {
    held.holds.delete(hold);
    if (sessions.get(tabId) === held) sessions.delete(tabId);
    throw new Error(`cannot keep tab ${tabId} rendering in the background: ${error instanceof Error ? error.message : error}`);
  }
  let released = false;
  return {
    get ended() {
      return hold.ended;
    },
    release: () => {
      if (released) return;
      released = true;
      release(tabId, held, hold);
    },
  };
}

export async function tabView(tabId: number): Promise<TabView> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) return 'hidden';
  // A locked screen hides no window by itself (docs/browser-lock-probe-2026-11-14.json), but the display
  // that turns off after it may hide them all; while locked, nobody sees the debugging bar either.
  const [window, idle] = await Promise.all([chrome.windows.get(tab.windowId), chrome.idle.queryState(15)]);
  if (window.state === 'minimized' || idle === 'locked') return 'hidden';
  return window.focused ? 'front' : 'behind';
}

interface ScopeEntry {
  hold?: ForegroundHold;
  capture: boolean;
  endings: number;
}

/** The tabs one program keeps rendering, checked before each command that needs a live page. */
export class ForegroundScope {
  private readonly tabs = new Map<number, ScopeEntry>();
  private readonly warnings: string[] = [];

  async keep(tabId: number): Promise<void> {
    // Checked per command: the user may switch away from the tab mid-program.
    const view = await tabView(tabId);
    if (view === 'front') return;
    const want = view === 'hidden';
    let entry = this.tabs.get(tabId);
    if (!entry) this.tabs.set(tabId, (entry = { capture: false, endings: 0 }));
    if (entry.hold?.ended) this.ended(tabId, entry, true);
    if (entry.endings > MAX_ENDINGS) return;
    if (entry.hold && (entry.capture || !want || entry.endings)) return;
    entry.hold?.release();
    // After an ending, capture would end the next session at once while the field keeps focus.
    entry.capture = want && !entry.endings;
    entry.hold = await holdForeground(tabId, entry.capture);
  }

  /** End the program's holds; returns what Chrome forced meanwhile. */
  release(): string[] {
    for (const [tabId, entry] of this.tabs) {
      if (entry.hold?.ended) this.ended(tabId, entry, false);
      entry.hold?.release();
    }
    this.tabs.clear();
    return this.warnings;
  }

  /** Record a session Chrome ended; `resuming` when the program attaches again for its next command. */
  private ended(tabId: number, entry: ScopeEntry, resuming: boolean): void {
    const reason = entry.hold!.ended!;
    entry.hold!.release();
    entry.hold = undefined;
    // A cancelled debugging bar is the user's decision: no new session in this program.
    entry.endings = reason === 'canceled_by_user' ? MAX_ENDINGS + 1 : entry.endings + 1;
    const cause = `Chrome ended the debugging session of tab ${tabId} (${reason}${
      reason === 'target_closed' ? ': an email field with saved autofill data took focus' : ''
    })`;
    this.warnings.push(
      !resuming
        ? cause
        : entry.endings > MAX_ENDINGS
          ? `${cause}; the rest of the program runs on the hidden page`
          : `${cause}; attached again without screen capture, so animations in a background tab may lag`,
    );
  }
}
