import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-semantic-shell-shared';
import { consoleBuffer } from './console-buffer';
import {
  beginPageDiff,
  collectPageDiff,
  formatChanges,
  type PageDiffResult,
} from './page-diff-core';
import {
  beginApiLog,
  collectApiLog,
  formatApiCalls,
  hasPendingApiCalls,
} from './page-diff-api-log';
import {
  diffSemanticStates,
  renderSemanticDelta,
  type SemanticInspectOptions,
} from './semantic-state-core';
import { readSemanticPageSignal, readSemanticPageState } from './semantic-state';
import type { SemanticPageState } from 'chrome-semantic-shell-shared';

interface ObservationState {
  ts: number;
  url: string;
  semantic?: SemanticPageState;
}

/** Per-tab observation bookkeeping (URL survives navigation; isolated world does not). */
const observations = new Map<number, ObservationState>();

async function resolveTabId(args: { tabId?: number; windowId?: number }): Promise<number> {
  if (typeof args?.tabId === 'number') {
    const tab = await chrome.tabs.get(args.tabId);
    if (!tab?.id) throw new Error(`Tab ${args.tabId} not found`);
    return tab.id;
  }
  const query: chrome.tabs.QueryInfo =
    typeof args?.windowId === 'number'
      ? { active: true, windowId: args.windowId }
      : { active: true, currentWindow: true };
  const [tab] = await chrome.tabs.query(query);
  if (!tab?.id) throw new Error('No active tab found');
  return tab.id;
}

async function runInTab<T>(tabId: number, func: () => T): Promise<T> {
  const results = (await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func,
  } as any)) as { result?: T }[];
  const result = results?.[0]?.result;
  if (result === undefined || result === null) {
    throw new Error('No result from page script (page may be restricted)');
  }
  return result;
}

export async function beginObservation(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  beginApiLog(tabId);
  await runInTab(tabId, beginPageDiff);
  let semantic: SemanticPageState | undefined;
  try {
    semantic = await readSemanticPageState(tabId, {
      mode: 'interactive',
      limit: 300,
      includeAdapters: false,
    });
  } catch {
    semantic = undefined;
  }
  observations.set(tabId, { ts: Date.now(), url: tab.url || '', semantic });
}

async function collectAfterSemanticQuiet(
  tabId: number,
  maxWaitMs: number,
  options: SemanticInspectOptions,
): Promise<SemanticPageState | undefined> {
  const startedAt = Date.now();
  const cap = Math.max(0, maxWaitMs);
  let lastSignal = '';
  let stableRounds = 0;

  // Give microtasks and the first render frame a chance to publish changes.
  if (cap > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(50, cap)));
  while (true) {
    try {
      const current = (await readSemanticPageSignal(tabId))
        .map(
          (signal) =>
            `${signal.frameId}:${signal.documentId || ''}:${signal.revision}:${signal.url}`,
        )
        .join('|');
      stableRounds = lastSignal && current === lastSignal ? stableRounds + 1 : 0;
      lastSignal = current;
    } catch {
      break;
    }
    const elapsed = Date.now() - startedAt;
    if ((!hasPendingApiCalls(tabId) && stableRounds >= 1) || elapsed >= cap) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(32, Math.max(0, cap - elapsed))));
  }
  try {
    return await readSemanticPageState(tabId, options);
  } catch {
    return undefined;
  }
}

export async function collectObservation(tabId: number, settleMs: number): Promise<string> {
  const state = observations.get(tabId);
  if (!state) {
    throw new Error('No active observation on this tab — call begin first');
  }
  observations.delete(tabId);
  const semanticAfter = await collectAfterSemanticQuiet(tabId, settleMs, {
    mode: 'interactive',
    limit: 300,
    includeAdapters: false,
  });

  let diff: PageDiffResult;
  try {
    diff = await runInTab(tabId, collectPageDiff);
  } catch {
    // Injection failing after a successful begin means the page context was torn down.
    diff = { expired: true };
  }

  const tab = await chrome.tabs.get(tabId);
  const buffered = consoleBuffer.read(tabId, { onlyErrors: true, limit: 100 });
  const consoleErrors = (buffered?.messages || [])
    .filter((m) => m.timestamp >= state.ts)
    .slice(0, 3)
    .map((m) => m.text.slice(0, 100));

  const { calls, dropped } = collectApiLog(tabId);
  const text = formatChanges(diff, {
    urlBefore: state.url,
    urlAfter: tab.url || '',
    consoleErrors,
    apiCalls: formatApiCalls(calls, dropped),
    settleMs,
  });
  if (!state.semantic || !semanticAfter) return text;

  const semantic = diffSemanticStates(state.semantic, semanticAfter);
  semantic.api = calls.map((call) => ({ ...call }));
  if (!semantic.added.length && !semantic.updated.length && !semantic.removed.length) return text;
  // After a navigation every node is "new": the full listing is an inspect, not a delta.
  const page = (url: string) => url.split('#')[0];
  if (page(state.url) !== page(tab.url || '')) {
    return `${text}\ndelta v${semantic.fromVersion}->v${semantic.toVersion}: navigated to ${tab.url}; ${semanticAfter.nodes.length} interactive node(s), run inspect to list them`;
  }
  return `${text}\n${renderSemanticDelta(semantic)}`;
}

interface PageDiffToolParams {
  action: 'begin' | 'collect';
  tabId?: number;
  windowId?: number;
  settleMs?: number;
}

/**
 * chrome_page_diff — explicit begin/collect change observation for multi-step
 * interactions (open dropdown, pick option, then collect once). Single actions
 * should prefer `observeChanges: true` on the action tool itself.
 */
class PageDiffTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.PAGE_DIFF;

  async execute(args: PageDiffToolParams): Promise<ToolResult> {
    const { action, settleMs = 0 } = args || {};
    try {
      const tabId = await resolveTabId(args || {});
      if (action === 'begin') {
        await beginObservation(tabId);
        return {
          content: [{ type: 'text', text: `observation started on tab ${tabId}` }],
          isError: false,
        };
      }
      if (action === 'collect') {
        const text = await collectObservation(tabId, settleMs);
        return { content: [{ type: 'text', text }], isError: false };
      }
      return createErrorResponse('action must be "begin" or "collect"');
    } catch (e) {
      return createErrorResponse(e instanceof Error ? e.message : String(e));
    }
  }
}

export const pageDiffTool = new PageDiffTool();

export interface ObserveChangesArgs {
  observeChanges?: boolean;
  settleMs?: number;
  tabId?: number;
  windowId?: number;
}

/**
 * Decorator: adds opt-in `observeChanges` to an action tool without touching its
 * execute body. Begins observation before the action, collects after `settleMs`
 * (default 300), and appends the compact delta as an extra content block.
 * Observation failures degrade to a note — they never fail the action itself.
 */
export function withChangeObservation<T extends { execute(args: any): Promise<ToolResult> }>(
  tool: T,
): T {
  const original = tool.execute.bind(tool);
  tool.execute = async (args: ObserveChangesArgs) => {
    if (args?.observeChanges !== true) return original(args);
    // Strip the flag so tools that delegate internally (computer -> click/fill)
    // cannot trigger a nested second observation.
    const innerArgs = { ...args, observeChanges: undefined };

    let tabId: number;
    try {
      tabId = await resolveTabId(args);
      await beginObservation(tabId);
    } catch (e) {
      const result = await original(innerArgs);
      result.content.push({
        type: 'text',
        text: `changes: observation unavailable (${e instanceof Error ? e.message : String(e)})`,
      });
      return result;
    }

    const result = await original(innerArgs);
    if (result.isError) {
      observations.delete(tabId);
      collectApiLog(tabId); // discard, so the listener log does not leak into the next run
      try {
        await runInTab(tabId, collectPageDiff); // disconnect the DOM observer as well
      } catch {
        // Navigation/restricted pages may already have torn the observation context down.
      }
      return result;
    }
    try {
      const text = await collectObservation(tabId, args.settleMs ?? 300);
      result.content.push({ type: 'text', text });
    } catch (e) {
      result.content.push({
        type: 'text',
        text: `changes: collection failed (${e instanceof Error ? e.message : String(e)})`,
      });
    }
    return result;
  };
  return tool;
}
