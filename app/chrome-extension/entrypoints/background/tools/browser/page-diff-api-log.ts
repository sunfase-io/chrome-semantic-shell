/**
 * Lightweight per-tab API activity log for change observation.
 *
 * Answers "what did this button actually call?" without the cost of a full
 * network capture: method / url / status / duration only, never bodies. Reach
 * for chrome_network_capture when payloads matter.
 *
 * Runs on webRequest (no debugger attach), so it never conflicts with an open
 * DevTools panel or with performance tracing.
 */

export interface ApiCall {
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  failed?: string;
}

interface PendingCall extends ApiCall {
  startedAt: number;
}

/** XHR/fetch only — documents, scripts, images and beacons are noise here. */
const OBSERVED_TYPES = new Set(['xmlhttprequest', 'other']);
const MAX_CALLS = 40;

interface TabLog {
  calls: ApiCall[];
  pending: Map<string, PendingCall>;
  dropped: number;
  lastActivityAt: number;
}

const logs = new Map<number, TabLog>();
let listenersInstalled = false;

/** Analytics/telemetry endpoints drown out the business calls we care about. */
function isNoise(url: string): boolean {
  return /google-analytics|googletagmanager|sentry|hm\.baidu|umeng|beacon|\.(png|jpe?g|gif|svg|css|js|woff2?)(\?|$)/i.test(
    url,
  );
}

/** Strip query strings down to a marker — they bloat the line without informing. */
function compactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname.length > 120 ? u.pathname.slice(0, 120) + '…' : u.pathname;
    return path + (u.search ? '?…' : '');
  } catch {
    return raw.slice(0, 120);
  }
}

function record(tabId: number, mutate: (log: TabLog) => void): void {
  const log = logs.get(tabId);
  if (log) {
    log.lastActivityAt = Date.now();
    mutate(log);
  }
}

function installListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;

  chrome.webRequest.onBeforeRequest.addListener(
    (d) => {
      if (d.tabId < 0 || !OBSERVED_TYPES.has(d.type) || isNoise(d.url)) return;
      record(d.tabId, (log) =>
        log.pending.set(d.requestId, {
          method: d.method,
          url: compactUrl(d.url),
          startedAt: d.timeStamp,
        }),
      );
    },
    { urls: ['<all_urls>'] },
  );

  const settle = (requestId: string, tabId: number, patch: Partial<ApiCall>, at: number) => {
    record(tabId, (log) => {
      const pending = log.pending.get(requestId);
      if (!pending) return;
      log.pending.delete(requestId);
      if (log.calls.length >= MAX_CALLS) {
        log.dropped++;
        return;
      }
      const { startedAt, ...call } = pending;
      log.calls.push({ ...call, durationMs: Math.max(0, Math.round(at - startedAt)), ...patch });
    });
  };

  chrome.webRequest.onCompleted.addListener(
    (d) => settle(d.requestId, d.tabId, { status: d.statusCode }, d.timeStamp),
    { urls: ['<all_urls>'] },
  );
  chrome.webRequest.onErrorOccurred.addListener(
    (d) => settle(d.requestId, d.tabId, { failed: d.error }, d.timeStamp),
    { urls: ['<all_urls>'] },
  );
}

/** Start collecting API calls for a tab (idempotent: resets the log). */
export function beginApiLog(tabId: number): void {
  installListeners();
  logs.set(tabId, { calls: [], pending: new Map(), dropped: 0, lastActivityAt: Date.now() });
}

/** Stop collecting and return what was seen. */
export function collectApiLog(tabId: number): { calls: ApiCall[]; dropped: number } {
  const log = logs.get(tabId);
  logs.delete(tabId);
  if (!log) return { calls: [], dropped: 0 };
  return { calls: log.calls, dropped: log.dropped };
}

/** True while an observed fetch/XHR has not completed yet. */
export function hasPendingApiCalls(tabId: number): boolean {
  return (logs.get(tabId)?.pending.size || 0) > 0;
}

export async function waitForApiIdle(
  tabId: number,
  timeoutMs: number,
  idleMs = 300,
): Promise<void> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const idleThreshold = Math.max(50, idleMs);
  while (Date.now() < deadline) {
    const log = logs.get(tabId);
    if (log && log.pending.size === 0 && Date.now() - log.lastActivityAt >= idleThreshold) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`network idle timed out after ${timeoutMs}ms on tab ${tabId}`);
}

/** Render as one compact segment for the changes line. */
export function formatApiCalls(calls: ApiCall[], dropped = 0): string {
  if (!calls.length) return '';
  const parts = calls.map((c) => {
    const outcome = c.failed ? c.failed : c.status;
    const ms = c.durationMs !== undefined ? ` ${c.durationMs}ms` : '';
    return `${c.method} ${c.url} ${outcome}${ms}`;
  });
  if (dropped > 0) parts.push(`+${dropped} more`);
  return 'api: ' + parts.join('; ');
}
