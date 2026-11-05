import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchesDownload, waitForDownload } from '@/entrypoints/background/tools/browser/download';

type CreatedListener = (item: chrome.downloads.DownloadItem) => void;
type ChangedListener = (change: chrome.downloads.DownloadDelta) => void;

const options = { startedAfter: '2026-09-21T10:00:00.000Z', pageUrl: 'https://example.test/report', timeoutMs: 500 };
const item = (overrides = {}) => ({ id: 1, startTime: '2026-09-21T10:00:01.000Z', filename: '/tmp/fixture.txt', url: 'https://example.test/file?token=fixture', state: 'complete', ...overrides }) as chrome.downloads.DownloadItem;

afterEach(() => vi.unstubAllGlobals());

describe('download correlation', () => {
  it('rejects old history and downloads from unrelated pages', () => {
    expect(matchesDownload(item({ startTime: '2026-09-15T10:00:00.000Z' }), options)).toBe(false);
    expect(matchesDownload(item({ url: 'https://other.test/file' }), options)).toBe(false);
    expect(matchesDownload(item(), options)).toBe(true);
    expect(matchesDownload(item({ url: 'https://cdn.test/file', referrer: 'https://example.test/report' }), options)).toBe(true);
  });

  it('finds an already-complete owned download and strips signed query data', async () => {
    const created = new Set<CreatedListener>(); const changed = new Set<ChangedListener>();
    const search = vi.fn().mockImplementation(async () => {
      expect(created.size).toBe(1); expect(changed.size).toBe(1);
      return [item({ id: 99, startTime: '2020-01-01T00:00:00Z' }), item()];
    });
    vi.stubGlobal('chrome', { ...chrome, downloads: {
      search,
      onCreated: { addListener: (fn: CreatedListener) => created.add(fn), removeListener: (fn: CreatedListener) => created.delete(fn) },
      onChanged: { addListener: (fn: ChangedListener) => changed.add(fn), removeListener: (fn: ChangedListener) => changed.delete(fn) },
    } });
    const result = await waitForDownload(options);
    expect(result.id).toBe(1); expect(result.url).toBe('https://example.test/file');
    expect(result.urlRedacted).toBe(true);
    expect(created.size).toBe(0); expect(changed.size).toBe(0);
  });

  it('fails on ambiguous simultaneous matches instead of choosing the first', async () => {
    vi.stubGlobal('chrome', { ...chrome, downloads: {
      search: vi.fn().mockResolvedValue([item(), item({ id: 2 })]),
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    } });
    await expect(waitForDownload(options)).rejects.toThrow('Ambiguous recent downloads');
  });
});
