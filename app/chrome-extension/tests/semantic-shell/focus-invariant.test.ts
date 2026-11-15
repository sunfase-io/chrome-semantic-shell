import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openTabHandler, switchTabHandler } from '@/entrypoints/background/semantic-actions/handlers/tabs';

/**
 * The user keeps working while the agent operates: nothing may activate a tab or raise a window
 * except an explicit `tab switch`. This scan catches a new call anywhere in the extension.
 */
const ROOT = resolve(__dirname, '../..');
const SOURCES = ['entrypoints', 'utils', 'common', 'shared', 'inject-scripts'];
const STEALS_FOCUS = [
  /chrome\.(?:tabs|windows)\.(?:update|create)\([^;]{0,300}?\b(?:active|focused):\s*true\b/g,
  /\b(?:Page\.bringToFront|Target\.activateTarget|tabs\.highlight|drawAttention)\b/g,
];
const ALLOWED = { 'entrypoints/background/semantic-actions/handlers/tabs.ts': 2 }; // switchTabHandler

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(?:ts|js)$/.test(name)) yield path;
  }
}

describe('focus invariant', () => {
  it('lets only tab switch activate a tab or raise a window', () => {
    const found: Record<string, number> = {};
    for (const dir of SOURCES) {
      for (const path of files(join(ROOT, dir))) {
        const source = readFileSync(path, 'utf8');
        const count = STEALS_FOCUS.reduce((sum, pattern) => sum + (source.match(pattern)?.length ?? 0), 0);
        if (count) found[relative(ROOT, path).replaceAll('\\', '/')] = count;
      }
    }
    expect(found).toEqual(ALLOWED);
  });
});

describe('tab actions', () => {
  const ctx = { vars: {}, tabId: 1 } as any;

  beforeEach(() => {
    (chrome.tabs.create as any).mockReset().mockResolvedValue({ id: 5 });
    (chrome.tabs.update as any).mockReset().mockResolvedValue({});
    vi.mocked(chrome.tabs.get).mockReset().mockResolvedValue({ id: 5, windowId: 2 } as chrome.tabs.Tab);
    (chrome as any).windows = { update: vi.fn().mockResolvedValue({}) };
    (chrome as any).scripting = { executeScript: vi.fn().mockResolvedValue([{ result: true }]) };
  });

  it('opens a new tab behind the user', async () => {
    await openTabHandler.run(ctx, { id: 'a', type: 'openTab', params: {} } as any);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'about:blank', active: false });
  });

  it('switches the tab without raising its window unless asked to', async () => {
    await switchTabHandler.run(ctx, { id: 'a', type: 'switchTab', params: { tabId: 5 } } as any);
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { active: true });
    expect(chrome.windows.update).not.toHaveBeenCalled();
    await switchTabHandler.run(ctx, { id: 'b', type: 'switchTab', params: { tabId: 5, focusWindow: true } } as any);
    expect(chrome.windows.update).toHaveBeenCalledWith(2, { focused: true });
  });

  it('returns a new tab as soon as its document is parsed', async () => {
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 5, status: 'loading' } as chrome.tabs.Tab);
    (chrome as any).scripting.executeScript.mockResolvedValue([{ result: 'interactive' }]);
    const result = await openTabHandler.run(ctx, { id: 'a', type: 'openTab', params: { url: 'https://slow.test', loadTimeoutMs: 5000 } } as any);
    expect(result).toEqual({ status: 'success', newTabId: 5 });
  });
});
