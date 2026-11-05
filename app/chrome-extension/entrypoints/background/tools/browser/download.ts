import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-semantic-shell-shared';

interface HandleDownloadParams {
  filenameContains?: string;
  timeoutMs?: number;
  waitForComplete?: boolean;
  startedAfter?: string;
  pageUrl?: string;
}

export function matchesDownload(item: chrome.downloads.DownloadItem, options: HandleDownloadParams): boolean {
  const after = Date.parse(options.startedAfter || '');
  const started = Date.parse(item.startTime);
  if (!Number.isFinite(after) || !Number.isFinite(started) || started < after) return false;
  if (options.filenameContains) {
    const name = (item.filename || '').split(/[/\\]/).pop() || '';
    if (!name.includes(options.filenameContains) && !item.url.includes(options.filenameContains)) return false;
  }
  if (options.pageUrl) {
    const expected = new URL(options.pageUrl).origin;
    const belongs = [item.url, item.referrer].some((url) => {
      try { return new URL(url).origin === expected; } catch { return false; }
    });
    if (!belongs) return false;
  }
  return true;
}

function safeDownload(item: chrome.downloads.DownloadItem) {
  const url = new URL(item.url);
  const redacted = Boolean(url.search || url.hash || url.username || url.password);
  url.search = ''; url.hash = ''; url.username = ''; url.password = '';
  return { id: item.id, filename: item.filename, url: url.href, urlRedacted: redacted,
    mime: item.mime, fileSize: item.fileSize ?? item.totalBytes, state: item.state,
    danger: item.danger, startTime: item.startTime, endTime: item.endTime, exists: item.exists };
}

export async function waitForDownload(options: HandleDownloadParams): Promise<ReturnType<typeof safeDownload>> {
  const timeoutMs = Math.max(1, Math.min(Number(options.timeoutMs ?? 30000), 120000));
  const complete = options.waitForComplete !== false;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error, item?: chrome.downloads.DownloadItem) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(onCreated);
      chrome.downloads.onChanged.removeListener(onChanged);
      if (error) reject(error);
      else {
        try { resolve(safeDownload(item!)); } catch (failure) { reject(failure); }
      }
    };
    const consider = (item: chrome.downloads.DownloadItem) => {
      if (!matchesDownload(item, options)) return;
      if (item.state === 'interrupted') return finish(new Error(`Download interrupted: ${item.error || 'unknown'}`));
      if (!complete || item.state === 'complete') finish(undefined, item);
    };
    const onCreated = (item: chrome.downloads.DownloadItem) => consider(item);
    const onChanged = (change: chrome.downloads.DownloadDelta) => {
      if (finished || (!change.state && !change.filename)) return;
      void chrome.downloads.search({ id: change.id }).then((items) => {
        if (items[0]) consider(items[0]);
      }).catch((error) => finish(new Error(String(error))));
    };
    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
    const timer = setTimeout(() => finish(new Error('Download wait timed out')), timeoutMs);
    // Register listeners before searching, including downloads that completed
    // between the initiating click and this command. Never inspect old history.
    void chrome.downloads.search({ startedAfter: options.startedAfter, orderBy: ['-startTime'], limit: 100 }).then((items) => {
      const candidates = items.filter((item) => matchesDownload(item, options));
      if (candidates.length > 1) return finish(new Error('Ambiguous recent downloads; specify filename='));
      if (candidates[0]) consider(candidates[0]);
    }).catch((error) => finish(new Error(String(error))));
  });
}

class HandleDownloadTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.HANDLE_DOWNLOAD;
  async execute(args: HandleDownloadParams): Promise<ToolResult> {
    try {
      const options = { ...args, startedAfter: args.startedAfter || new Date(Date.now() - 60000).toISOString() };
      if (!Number.isFinite(Date.parse(options.startedAfter))) throw new Error('Invalid download start time');
      const download = await waitForDownload(options);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, download }) }], isError: false };
    } catch (error) {
      return createErrorResponse(`Handle download failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export const handleDownloadTool = new HandleDownloadTool();
