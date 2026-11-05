import { describe, expect, it, vi } from 'vitest';
import { navigateTool } from '@/entrypoints/background/tools/browser/common';

describe('pinned navigation', () => {
  it('navigates localhost with a port without a global URL-pattern query', async () => {
    const tab = { id: 91, windowId: 1, url: 'http://127.0.0.1:61234/' } as chrome.tabs.Tab;
    vi.mocked(chrome.tabs.get).mockResolvedValue(tab);
    vi.mocked(chrome.tabs.update).mockResolvedValue(undefined);
    vi.mocked(chrome.tabs.query).mockClear();
    const result = await navigateTool.execute({ tabId: 91, url: tab.url, background: true });
    expect(result.isError).toBe(false);
    expect(chrome.tabs.query).not.toHaveBeenCalled();
    expect(chrome.tabs.update).toHaveBeenCalledWith(91, { url: tab.url });
  });

  it('does not switch to another tab when the explicit target has gone', async () => {
    vi.mocked(chrome.tabs.get).mockRejectedValueOnce(new Error('No tab'));
    vi.mocked(chrome.tabs.update).mockClear();
    const result = await navigateTool.execute({ tabId: 91, url: 'https://example.test', background: true });
    expect(result.isError).toBe(true);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
});
