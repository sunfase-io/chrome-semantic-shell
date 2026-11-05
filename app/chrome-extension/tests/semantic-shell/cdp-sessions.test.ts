import { afterEach, expect, it, vi } from 'vitest';
import { CDPSessionManager } from '@/utils/cdp-session-manager';

afterEach(() => vi.unstubAllGlobals());

it('serializes transitions while allowing a dialog alongside a pending evaluation', async () => {
  const api = { getTargets: vi.fn().mockResolvedValue([]), attach: vi.fn().mockResolvedValue(undefined), detach: vi.fn().mockResolvedValue(undefined), sendCommand: vi.fn().mockResolvedValue({}) };
  vi.stubGlobal('chrome', { ...chrome, debugger: api });
  const manager = new CDPSessionManager();
  await Promise.all([manager.attach(91, 'javascript'), manager.attach(91, 'dialog')]);
  expect(api.attach).toHaveBeenCalledTimes(1);
  await manager.detach(91, 'dialog');
  expect(api.detach).not.toHaveBeenCalled();
  await manager.sendCommand(91, 'Runtime.evaluate');
  await manager.detach(91, 'javascript');
  expect(api.detach).toHaveBeenCalledTimes(1);
});

it('does not reuse a session while its detach is still in progress', async () => {
  let release!: () => void;
  const api = { getTargets: vi.fn().mockResolvedValue([]), attach: vi.fn().mockResolvedValue(undefined), detach: vi.fn().mockImplementation(() => new Promise<void>((resolve) => { release = resolve; })) };
  vi.stubGlobal('chrome', { ...chrome, debugger: api });
  const manager = new CDPSessionManager();
  await manager.attach(91, 'first');
  const ending = manager.detach(91, 'first');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  let acquired = false;
  const next = manager.attach(91, 'next').then(() => { acquired = true; });
  await Promise.resolve();
  expect(acquired).toBe(false);
  release();
  await Promise.all([ending, next]);
  expect(api.attach).toHaveBeenCalledTimes(2);
});

it('counts nested uses by the same owner and ignores foreign releases', async () => {
  const api = { getTargets: vi.fn().mockResolvedValue([]), attach: vi.fn().mockResolvedValue(undefined), detach: vi.fn().mockResolvedValue(undefined) };
  vi.stubGlobal('chrome', { ...chrome, debugger: api });
  const manager = new CDPSessionManager();
  await manager.attach(91, 'javascript'); await manager.attach(91, 'javascript');
  await manager.detach(91, 'unrelated'); await manager.detach(91, 'javascript');
  expect(api.detach).not.toHaveBeenCalled();
  await manager.detach(91, 'javascript');
  expect(api.detach).toHaveBeenCalledTimes(1);
});

it('attaches alongside DevTools and reclaims its own stale session after a worker restart', async () => {
  const api = {
    attach: vi.fn().mockRejectedValueOnce(new Error('Another debugger is already attached to the tab with id: 91.')).mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
  };
  vi.stubGlobal('chrome', { ...chrome, debugger: api });
  await new CDPSessionManager().attach(91, 'javascript');
  expect(api.detach).toHaveBeenCalledWith({ tabId: 91 });
  expect(api.attach).toHaveBeenCalledTimes(2);
});

it('reports a foreign debugger it cannot detach', async () => {
  const api = {
    attach: vi.fn().mockRejectedValue(new Error('Another debugger is already attached to the tab with id: 91.')),
    detach: vi.fn().mockRejectedValue(new Error('Debugger is not attached to the tab with id: 91.')),
  };
  vi.stubGlobal('chrome', { ...chrome, debugger: api });
  await expect(new CDPSessionManager().attach(91, 'javascript')).rejects.toThrow('another client');
});
