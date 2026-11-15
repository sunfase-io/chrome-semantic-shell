import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: any[]) => void;

function stubChrome(tab: Partial<chrome.tabs.Tab> = { id: 7, active: false, windowId: 1 }, window: Partial<chrome.windows.Window> = { state: 'normal', focused: true }) {
  const detach: Handler[] = [];
  const api = {
    attach: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn().mockResolvedValue({}),
    onEvent: { addListener: vi.fn() },
    onDetach: { addListener: vi.fn((fn: Handler) => detach.push(fn)) },
  };
  const tabs = { ...chrome.tabs, get: vi.fn().mockResolvedValue(tab), onRemoved: { addListener: vi.fn() } };
  const windows = { get: vi.fn().mockResolvedValue(window) };
  vi.stubGlobal('chrome', { ...chrome, debugger: api, tabs, windows });
  return { api, tabs, windows, endByChrome: (tabId: number, reason: string) => detach.forEach((fn) => fn({ tabId }, reason)) };
}

const session = () => import('@/entrypoints/background/tools/browser/background-session');
const methods = (api: { sendCommand: ReturnType<typeof vi.fn> }) => api.sendCommand.mock.calls.map((call) => call[1]);

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('background session', () => {
  it('keeps a background tab rendering with focus emulation and a minimal screencast', async () => {
    const { api } = stubChrome();
    const hold = await (await session()).holdForeground(7, true);
    expect(api.attach).toHaveBeenCalledTimes(1);
    expect(api.sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    expect(api.sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'Page.startScreencast', expect.objectContaining({ maxWidth: 32 }));
    hold.release();
    expect(api.detach).not.toHaveBeenCalled();
  });

  it('adds capture to a running focus-only session', async () => {
    const { api } = stubChrome();
    const { holdForeground } = await session();
    const focus = await holdForeground(7, false);
    const capture = await holdForeground(7, true);
    expect(api.attach).toHaveBeenCalledTimes(1);
    expect(methods(api)).toEqual(['Emulation.setFocusEmulationEnabled', 'Page.startScreencast']);
    capture.release();
    focus.release();
  });

  it('shares one session between nested holds and lingers before tearing down', async () => {
    const { api } = stubChrome();
    const { holdForeground } = await session();
    const outer = await holdForeground(7, true);
    const inner = await holdForeground(7, false);
    inner.release();
    outer.release();
    outer.release(); // a second release of the same hold is ignored
    await vi.advanceTimersByTimeAsync(14_000);
    expect(api.detach).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(methods(api)).toEqual(expect.arrayContaining(['Page.stopScreencast']));
    expect(api.sendCommand).toHaveBeenCalledWith({ tabId: 7 }, 'Emulation.setFocusEmulationEnabled', { enabled: false });
    expect(api.detach).toHaveBeenCalledTimes(1);
  });

  it('reuses a lingering session for the next program', async () => {
    const { api } = stubChrome();
    const { holdForeground } = await session();
    (await holdForeground(7, true)).release();
    await vi.advanceTimersByTimeAsync(5_000);
    const next = await holdForeground(7, true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.attach).toHaveBeenCalledTimes(1);
    expect(api.detach).not.toHaveBeenCalled();
    next.release();
  });

  it('marks its holds ended when Chrome ends the session, without attaching again by itself', async () => {
    const { api, endByChrome } = stubChrome();
    const hold = await (await session()).holdForeground(7, true);
    endByChrome(7, 'target_closed');
    expect(hold.ended).toBe('target_closed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.attach).toHaveBeenCalledTimes(1);
    hold.release();
  });

  it('fails fast when the tab cannot be kept rendering', async () => {
    const { api } = stubChrome();
    api.attach.mockRejectedValue(new Error('Cannot access a chrome:// URL'));
    await expect((await session()).holdForeground(7, true)).rejects.toThrow(
      'cannot keep tab 7 rendering in the background: Cannot access a chrome:// URL',
    );
  });

  it.each([
    [{ active: false }, { state: 'normal', focused: true }, 'hidden'],
    [{ active: true }, { state: 'minimized', focused: false }, 'hidden'],
    [{ active: true }, { state: 'maximized', focused: false }, 'behind'],
    [{ active: true }, { state: 'normal', focused: true }, 'front'],
  ])('sees tab %j in window %j as %s', async (tab, window, expected) => {
    stubChrome({ id: 7, windowId: 1, ...tab }, window as Partial<chrome.windows.Window>);
    expect(await (await session()).tabView(7)).toBe(expected);
  });

  it('sees every tab as hidden while the screen is locked', async () => {
    stubChrome({ id: 7, windowId: 1, active: true }, { state: 'normal', focused: true });
    vi.stubGlobal('chrome', { ...chrome, idle: { queryState: vi.fn().mockResolvedValue('locked') } });
    expect(await (await session()).tabView(7)).toBe('hidden');
  });
});

describe('foreground scope of a program', () => {
  it('leaves a tab the user is looking at alone', async () => {
    const { api } = stubChrome({ id: 7, active: true, windowId: 1 }, { state: 'normal', focused: true });
    const scope = new (await session()).ForegroundScope();
    await scope.keep(7);
    expect(api.attach).not.toHaveBeenCalled();
    expect(scope.release()).toEqual([]);
  });

  it('uses focus emulation for a window behind another application and adds capture once the tab is hidden', async () => {
    const { api, tabs } = stubChrome({ id: 7, active: true, windowId: 1 }, { state: 'maximized', focused: false });
    const scope = new (await session()).ForegroundScope();
    await scope.keep(7);
    await scope.keep(7);
    expect(methods(api)).toEqual(['Emulation.setFocusEmulationEnabled']);
    tabs.get.mockResolvedValue({ id: 7, active: false, windowId: 1 }); // the user switched to another tab
    await scope.keep(7);
    expect(methods(api)).toEqual(['Emulation.setFocusEmulationEnabled', 'Page.startScreencast']);
    expect(api.attach).toHaveBeenCalledTimes(1);
    scope.release();
  });

  it('attaches again without capture after Chrome ended the session, and reports it', async () => {
    const { api, endByChrome } = stubChrome();
    const scope = new (await session()).ForegroundScope();
    await scope.keep(7);
    endByChrome(7, 'target_closed');
    api.sendCommand.mockClear();
    await scope.keep(7);
    expect(api.attach).toHaveBeenCalledTimes(2);
    expect(methods(api)).toEqual(['Emulation.setFocusEmulationEnabled']);
    expect(scope.release()).toEqual([expect.stringMatching(/tab 7 \(target_closed: an email field.*attached again without screen capture/)]);
  });

  it('gives up on a tab Chrome keeps detaching and runs the rest on the hidden page', async () => {
    const { api, endByChrome } = stubChrome();
    const scope = new (await session()).ForegroundScope();
    for (let i = 0; i < 4; i++) {
      await scope.keep(7);
      endByChrome(7, 'target_closed');
    }
    await scope.keep(7);
    expect(api.attach).toHaveBeenCalledTimes(3);
    const warnings = scope.release();
    expect(warnings).toHaveLength(3);
    expect(warnings[2]).toContain('the rest of the program runs on the hidden page');
  });

  it('respects a cancelled debugging bar for the rest of the program', async () => {
    const { api, endByChrome } = stubChrome();
    const scope = new (await session()).ForegroundScope();
    await scope.keep(7);
    endByChrome(7, 'canceled_by_user');
    await scope.keep(7);
    await scope.keep(7);
    expect(api.attach).toHaveBeenCalledTimes(1);
    expect(scope.release()).toEqual([expect.stringContaining('(canceled_by_user); the rest of the program runs on the hidden page')]);
  });

  it('reports a session Chrome ended during the last command', async () => {
    const { endByChrome } = stubChrome();
    const scope = new (await session()).ForegroundScope();
    await scope.keep(7);
    endByChrome(7, 'target_closed');
    expect(scope.release()).toEqual([expect.stringMatching(/ended the debugging session of tab 7 \(target_closed: .*took focus\)$/)]);
  });
});
