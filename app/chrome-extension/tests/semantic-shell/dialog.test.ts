import { afterEach, expect, it, vi } from 'vitest';
import { handleDialogTool } from '@/entrypoints/background/tools/browser/dialog';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

afterEach(() => vi.restoreAllMocks());

it('handles a blocking dialog without waiting for Page.enable', async () => {
  vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 91, url: 'https://example.test' } as chrome.tabs.Tab);
  vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tab, _owner, callback) => callback());
  const send = vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});
  const result = await handleDialogTool.execute({ tabId: 91, action: 'accept' });
  expect(result.isError).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(91, 'Page.handleJavaScriptDialog', { accept: true, promptText: undefined });
});
