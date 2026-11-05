import type { SemanticPageState } from 'chrome-semantic-shell-shared';
import {
  inspectSemanticPage,
  inspectSemanticSignal,
  SEMANTIC_ERROR_CAPABILITY,
  type SemanticInspectOptions,
  type SemanticPageSignal,
} from './semantic-state-core';
import { mergeFrameworkInspection, readFrameworkInspection } from './framework-adapters';
import { listWebMcpTools } from './webmcp-adapter';

interface TabSemanticVersion {
  documentId?: string;
  nativeSignature: string;
  version: number;
  url: string;
  enrichmentSignature?: string;
}

const tabVersions = new Map<number, TabSemanticVersion>();

export function normalizeSemanticStateVersion(
  tabId: number,
  state: SemanticPageState,
  documentId?: string,
  enrichmentSignature?: string,
  nativeSignature = `${documentId || ''}:${state.version}:${state.url}`,
): SemanticPageState {
  const previous = tabVersions.get(tabId);
  const documentChanged = Boolean(
    previous?.documentId && documentId && previous.documentId !== documentId,
  );
  const nativeChanged = Boolean(
    previous &&
    (documentChanged || previous.url !== state.url || previous.nativeSignature !== nativeSignature),
  );
  const enrichmentChanged = Boolean(
    previous?.enrichmentSignature !== undefined &&
    enrichmentSignature !== undefined &&
    previous.enrichmentSignature !== enrichmentSignature,
  );
  const version = previous
    ? previous.version + (nativeChanged || enrichmentChanged ? 1 : 0)
    : Math.max(1, state.version);

  tabVersions.set(tabId, {
    documentId: documentId || previous?.documentId,
    nativeSignature,
    version,
    url: state.url,
    enrichmentSignature: enrichmentSignature ?? previous?.enrichmentSignature,
  });
  return state.version === version ? state : { ...state, version };
}

export function resetSemanticStateVersions(): void {
  tabVersions.clear();
}

export async function readSemanticPageState(
  tabId: number,
  options: SemanticInspectOptions = {},
): Promise<SemanticPageState> {
  const { scopeFrameId, ...pageOptions } = options;
  const results = (await chrome.scripting.executeScript({
    target:
      scopeFrameId === undefined ? { tabId, allFrames: true } : { tabId, frameIds: [scopeFrameId] },
    world: 'ISOLATED',
    func: inspectSemanticPage,
    args: [pageOptions],
  } as any)) as Array<{ documentId?: string; frameId?: number; result?: SemanticPageState }>;
  const frames = results
    .filter((result): result is typeof result & { result: SemanticPageState } =>
      Boolean(result.result),
    )
    .sort((left, right) => (left.frameId || 0) - (right.frameId || 0));
  const top = frames.find((result) => (result.frameId || 0) === 0) || frames[0];
  if (!top) {
    throw new Error(
      `No semantic state returned from ${scopeFrameId === undefined ? 'the page' : `frame ${scopeFrameId}`} (the page may be a browser-internal, error, or still-loading document)`,
    );
  }
  const errorOf = (result: (typeof frames)[number]) =>
    result.result.capabilities.find((capability) => capability.startsWith(SEMANTIC_ERROR_CAPABILITY));
  // A scope ref lives in one frame; the others legitimately report it as missing.
  const healthy = frames.filter((result) => !errorOf(result));
  if (!healthy.length) throw new Error(errorOf(frames[0])!.slice(SEMANTIC_ERROR_CAPABILITY.length));
  frames.splice(0, frames.length, ...healthy);
  let state: SemanticPageState = {
    version: Math.max(...frames.map((result) => result.result.version)),
    url: top.result.url,
    title: top.result.title,
    nodes: frames.flatMap((result) =>
      result.result.nodes.map((node) => ({ ...node, frameId: result.frameId || 0 })),
    ),
    capabilities: [...new Set(frames.flatMap((result) => result.result.capabilities))],
  };
  const documentId = frames
    .map((result) => `${result.frameId || 0}:${result.documentId || ''}`)
    .join('|');
  const nativeSignature = frames
    .map(
      (result) =>
        `${result.frameId || 0}:${result.documentId || ''}:${result.result.version}:${result.result.url}`,
    )
    .join('|');
  let enrichmentSignature: string | undefined;
  if (options.includeAdapters !== false) {
    let inspection: Awaited<ReturnType<typeof readFrameworkInspection>> | undefined;
    try {
      inspection = await readFrameworkInspection(tabId);
      state = mergeFrameworkInspection(state, inspection);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.capabilities = [
        ...state.capabilities,
        `framework-adapter-error:${message.slice(0, 160)}`,
      ];
    }
    let toolNames: string[] = [];
    try {
      const tools = await listWebMcpTools(tabId);
      toolNames = tools.map((tool) => tool.name).sort();
      if (tools.length) state.capabilities = [...new Set([...state.capabilities, 'webmcp'])];
    } catch {
      // WebMCP is origin/feature gated; absence is not an extraction failure.
    }
    enrichmentSignature = JSON.stringify({ inspection, toolNames });
  }
  return normalizeSemanticStateVersion(
    tabId,
    state,
    documentId,
    enrichmentSignature,
    nativeSignature,
  );
}

export async function readSemanticPageSignal(
  tabId: number,
): Promise<Array<SemanticPageSignal & { documentId?: string; frameId: number }>> {
  const results = (await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'ISOLATED',
    func: inspectSemanticSignal,
  } as any)) as Array<{ documentId?: string; frameId?: number; result?: SemanticPageSignal }>;
  return results
    .filter((result): result is typeof result & { result: SemanticPageSignal } =>
      Boolean(result.result),
    )
    .map((result) => ({
      ...result.result,
      documentId: result.documentId,
      frameId: result.frameId || 0,
    }))
    .sort((left, right) => left.frameId - right.frameId);
}
