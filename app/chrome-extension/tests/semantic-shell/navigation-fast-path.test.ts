import { beforeEach, describe, expect, it, vi } from 'vitest';
import { navigateTool } from '@/entrypoints/background/tools/browser/common';

const tab = { id: 91, windowId: 1, url: 'http://127.0.0.1:61234/' } as chrome.tabs.Tab;

beforeEach(() => {
  vi.mocked(chrome.tabs.get).mockReset().mockResolvedValue(tab);
  vi.mocked(chrome.tabs.update).mockReset().mockResolvedValue(undefined as any);
  vi.mocked(chrome.tabs.query).mockClear();
  (chrome as any).windows = { update: vi.fn(), create: vi.fn(), getLastFocused: vi.fn() };
});

describe('pinned navigation', () => {
  it('navigates localhost with a port without a global URL-pattern query', async () => {
    const result = await navigateTool.execute({ tabId: 91, url: tab.url });
    expect(result.isError).toBe(false);
    expect(chrome.tabs.query).not.toHaveBeenCalled();
    expect(chrome.tabs.update).toHaveBeenCalledWith(91, { url: tab.url });
  });

  it('does not switch to another tab when the explicit target has gone', async () => {
    vi.mocked(chrome.tabs.get).mockRejectedValueOnce(new Error('No tab'));
    const result = await navigateTool.execute({ tabId: 91, url: 'https://example.test' });
    expect(result.isError).toBe(true);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('navigates a background tab without activating it or focusing its window', async () => {
    await navigateTool.execute({ tabId: 91, url: 'https://example.test/next' });
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(91, { url: 'https://example.test/next' });
    expect(chrome.windows.update).not.toHaveBeenCalled();
  });

  it('walks history in place', async () => {
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) =>
      method === 'Page.getNavigationHistory' ? { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }] } : {},
    );
    const result = await navigateTool.execute({ tabId: 91, url: 'back' });
    expect(result.isError).toBe(false);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 91 }, 'Page.navigateToHistoryEntry', { entryId: 1 });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.windows.update).not.toHaveBeenCalled();
  });
});
