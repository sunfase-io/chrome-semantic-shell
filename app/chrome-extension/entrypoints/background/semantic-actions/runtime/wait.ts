import { handleCallTool } from '@/entrypoints/background/tools';
import { TOOL_NAMES } from 'chrome-semantic-shell-shared';

export async function waitForNetworkIdle(totalTimeoutMs: number, idleThresholdMs: number) {
  const deadline = Date.now() + Math.max(500, totalTimeoutMs);
  const threshold = Math.max(200, idleThresholdMs);
  while (Date.now() < deadline) {
    await handleCallTool({
      name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE_START,
      args: {
        includeStatic: false,
        maxCaptureTime: Math.min(60_000, Math.max(threshold + 500, 2_000)),
        inactivityTimeout: 0,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, threshold + 200));
    const stopped = await handleCallTool({
      name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE_STOP,
      args: {},
    });
    const text = stopped.content.find((item) => item.type === 'text')?.text;
    try {
      const result = text ? JSON.parse(text) : null;
      const captureEnd = Number(result?.captureEndTime) || Date.now();
      const requests: any[] = Array.isArray(result?.requests) ? result.requests : [];
      const lastActivity = requests.reduce(
        (latest, request) =>
          Math.max(latest, Number(request.responseTime || request.requestTime || 0)),
        Number(result?.captureStartTime || 0),
      );
      if (captureEnd - lastActivity >= threshold) return;
    } catch {
      // A malformed sample is retried until the overall deadline.
    }
  }
  throw new Error('wait for network idle timed out');
}

export async function waitForNavigation(timeoutMs = 15_000, previousUrl?: string): Promise<void> {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (typeof active?.id !== 'number') throw new Error('Active tab not found');
  const tabId = active.id;
  const timeout = Math.max(1_000, Math.min(timeoutMs, 30_000));

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      chrome.webNavigation.onCompleted.removeListener(onCompleted);
      chrome.webNavigation.onHistoryStateUpdated?.removeListener(onHistoryStateUpdated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onCompleted = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
      if (details.tabId === tabId && details.frameId === 0) finish();
    };
    const onHistoryStateUpdated = (
      details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
    ) => {
      if (details.tabId === tabId && details.frameId === 0) finish();
    };
    const onUpdated = (updatedTabId: number, change: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId) return;
      if (change.status === 'complete') finish();
      if (change.url && (!previousUrl || change.url !== previousUrl)) finish();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`navigation timed out after ${timeout}ms`));
    }, timeout);

    chrome.webNavigation.onCompleted.addListener(onCompleted);
    chrome.webNavigation.onHistoryStateUpdated?.addListener(onHistoryStateUpdated);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

export async function waitForNavigationDone(previousUrl: string, timeoutMs?: number) {
  await waitForNavigation(timeoutMs, previousUrl);
}

export async function ensureReadPageIfWeb() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (/^(https?:|file:)/i.test(active?.url || '')) {
    await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: {} });
  }
}

export async function maybeQuickWaitForNav(previousUrl: string, timeoutMs?: number) {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (typeof active?.id !== 'number') return;
  await new Promise((resolve) => setTimeout(resolve, 350));
  const current = await chrome.tabs.get(active.id);
  if (current.status === 'loading' || (current.url && current.url !== previousUrl)) {
    await waitForNavigation(Math.min(timeoutMs || 15_000, 30_000), previousUrl).catch(() => {});
  }
}
