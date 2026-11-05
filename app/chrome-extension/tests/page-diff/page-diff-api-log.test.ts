import { describe, it, expect, beforeAll } from 'vitest';
import {
  beginApiLog,
  collectApiLog,
  formatApiCalls,
  waitForApiIdle,
} from '@/entrypoints/background/tools/browser/page-diff-api-log';

type Listener = (details: any) => void;

/** Grab the listeners the module registers on first use. */
function getListeners(): { before: Listener; completed: Listener; errored: Listener } {
  const wr = (globalThis as any).chrome.webRequest;
  const last = (m: any): Listener => m.addListener.mock.calls.at(-1)[0];
  return {
    before: last(wr.onBeforeRequest),
    completed: last(wr.onCompleted),
    errored: last(wr.onErrorOccurred),
  };
}

const TAB = 42;
let L: ReturnType<typeof getListeners>;

function request(
  requestId: string,
  url: string,
  opts: { tabId?: number; type?: string; method?: string; at?: number } = {},
) {
  L.before({
    requestId,
    tabId: opts.tabId ?? TAB,
    type: opts.type ?? 'xmlhttprequest',
    method: opts.method ?? 'POST',
    url,
    timeStamp: opts.at ?? 1000,
  });
}

function complete(requestId: string, statusCode: number, at = 1312, tabId = TAB) {
  L.completed({ requestId, tabId, statusCode, timeStamp: at });
}

beforeAll(() => {
  // installListeners() is idempotent and runs on the first beginApiLog call
  beginApiLog(TAB);
  collectApiLog(TAB);
  L = getListeners();
});

describe('page-diff api log', () => {
  it('records method, compact url, status and duration', () => {
    beginApiLog(TAB);
    request('r1', 'https://erp.test/tradegateway/purchase/order/enable?x=1');
    complete('r1', 200);
    const { calls } = collectApiLog(TAB);
    expect(calls).toEqual([
      {
        method: 'POST',
        url: '/tradegateway/purchase/order/enable?…',
        status: 200,
        durationMs: 312,
      },
    ]);
  });

  it('renders one compact segment', () => {
    expect(
      formatApiCalls([
        { method: 'POST', url: '/order/enable', status: 200, durationMs: 312 },
        { method: 'GET', url: '/order/list', status: 500, durationMs: 40 },
      ]),
    ).toBe('api: POST /order/enable 200 312ms; GET /order/list 500 40ms');
  });

  it('returns an empty segment when nothing was called', () => {
    expect(formatApiCalls([])).toBe('');
  });

  it('reports failed requests with the error reason', () => {
    beginApiLog(TAB);
    request('r2', 'https://erp.test/api/sync');
    L.errored({ requestId: 'r2', tabId: TAB, error: 'net::ERR_TIMED_OUT', timeStamp: 1500 });
    const { calls } = collectApiLog(TAB);
    expect(calls[0].failed).toBe('net::ERR_TIMED_OUT');
    expect(formatApiCalls(calls)).toContain('net::ERR_TIMED_OUT');
  });

  it('ignores static assets, analytics and non-xhr resource types', () => {
    beginApiLog(TAB);
    request('a', 'https://erp.test/static/app.js');
    request('b', 'https://www.google-analytics.com/collect');
    request('c', 'https://erp.test/page', { type: 'main_frame' });
    request('d', 'https://erp.test/logo.png');
    ['a', 'b', 'c', 'd'].forEach((id) => complete(id, 200));
    expect(collectApiLog(TAB).calls).toEqual([]);
  });

  it('scopes calls to their own tab', () => {
    beginApiLog(TAB);
    request('mine', 'https://erp.test/api/mine');
    request('other', 'https://erp.test/api/other', { tabId: 99 });
    complete('mine', 200);
    complete('other', 200, 1312, 99);
    const { calls } = collectApiLog(TAB);
    expect(calls.map((c) => c.url)).toEqual(['/api/mine']);
  });

  it('caps the log and reports how many were dropped', () => {
    beginApiLog(TAB);
    for (let i = 0; i < 45; i++) {
      request(`m${i}`, `https://erp.test/api/${i}`);
      complete(`m${i}`, 200);
    }
    const { calls, dropped } = collectApiLog(TAB);
    expect(calls).toHaveLength(40);
    expect(dropped).toBe(5);
    expect(formatApiCalls(calls, dropped)).toContain('+5 more');
  });

  it('collect is one-shot: a second collect returns nothing', () => {
    beginApiLog(TAB);
    request('x', 'https://erp.test/api/x');
    complete('x', 200);
    expect(collectApiLog(TAB).calls).toHaveLength(1);
    expect(collectApiLog(TAB).calls).toEqual([]);
  });

  it('drops requests that arrive with no active log (no leak between runs)', () => {
    request('stray', 'https://erp.test/api/stray');
    complete('stray', 200);
    beginApiLog(TAB);
    expect(collectApiLog(TAB).calls).toEqual([]);
  });

  it('waits for pending requests and tab-local quiet time', async () => {
    beginApiLog(TAB);
    request('idle', 'https://erp.test/api/idle');
    setTimeout(() => complete('idle', 200), 20);
    await expect(waitForApiIdle(TAB, 500, 50)).resolves.toBeUndefined();
    collectApiLog(TAB);
  });
});
