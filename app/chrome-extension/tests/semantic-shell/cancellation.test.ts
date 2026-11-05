import { describe, expect, it, vi } from 'vitest';
import { openTabHandler } from '@/entrypoints/background/semantic-actions/handlers/tabs';

describe('semantic action cancellation', () => {
  it('closes a newly created tab when its command is aborted during load', async () => {
    const create = vi.mocked(chrome.tabs.create);
    const get = vi.mocked(chrome.tabs.get);
    const remove = vi.mocked(chrome.tabs.remove);
    (create as any).mockResolvedValueOnce({ id: 99 } as chrome.tabs.Tab);
    (get as any).mockResolvedValue({
      id: 99,
      status: 'loading',
    } as chrome.tabs.Tab);
    const controller = new AbortController();
    const execution = openTabHandler.run(
      {
        vars: {},
        tabId: 1,
        signal: controller.signal,
        log: vi.fn(),
      },
      { id: 'open', type: 'openTab', params: { url: 'https://slow.test' } },
    );
    setTimeout(() => controller.abort(), 10);

    await expect(execution).resolves.toEqual(
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({ code: 'TIMEOUT' }),
      }),
    );
    expect(remove).toHaveBeenCalledWith(99);
  });
});
