import { afterEach, describe, expect, it, vi } from 'vitest';
import { clickTool, fillTool } from '@/entrypoints/background/tools/browser/interaction';

const originalTabsGet = chrome.tabs.get;
const originalTabsSendMessage = chrome.tabs.sendMessage;
const originalScripting = (chrome as any).scripting;

afterEach(() => {
  (chrome.tabs as any).get = originalTabsGet;
  (chrome.tabs as any).sendMessage = originalTabsSendMessage;
  (chrome as any).scripting = originalScripting;
});

describe('framed interaction helpers', () => {
  it.each([
    {
      name: 'click',
      file: 'inject-scripts/click-helper.js',
      action: 'clickElement',
      execute: () => clickTool.execute({ tabId: 91, frameId: 7, ref: 'ref_1' }),
    },
    {
      name: 'fill',
      file: 'inject-scripts/fill-helper.js',
      action: 'fillElement',
      execute: () => fillTool.execute({ tabId: 91, frameId: 7, ref: 'ref_1', value: 'framed' }),
    },
  ])('injects the $name helper into the target frame', async ({ file, action, execute }) => {
    const executeScript = vi.fn().mockResolvedValue([]);
    const sendMessage = vi.fn(async (_tabId: number, message: any) => {
      if (String(message.action).endsWith('_ping')) {
        throw new Error('Receiving end does not exist');
      }
      if (message.action === action) {
        return { success: true, message: 'ok', elementInfo: {} };
      }
      throw new Error(`Unexpected action: ${message.action}`);
    });
    (chrome.tabs as any).get = vi.fn().mockResolvedValue({
      id: 91,
      url: 'https://example.test/frame',
    });
    (chrome.tabs as any).sendMessage = sendMessage;
    (chrome as any).scripting = { executeScript };

    const result = await execute();

    expect(result.isError).toBe(false);
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 91, frameIds: [7] },
        files: [file],
        world: 'ISOLATED',
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(91, expect.objectContaining({ action }), {
      frameId: 7,
    });
  });
});
