import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromeShellTool } from '@/entrypoints/background/tools/browser/semantic-shell';
import { parseShellProgram } from '@/entrypoints/background/tools/browser/semantic-shell-dsl';
import * as state from '@/entrypoints/background/tools/browser/semantic-state';
import * as observation from '@/entrypoints/background/tools/browser/page-diff';
import * as actions from '@/entrypoints/background/semantic-actions';

describe('session regression: direct role/name actions', () => {
  beforeEach(() => vi.stubGlobal('chrome', {
    ...chrome,
    tabs: { ...chrome.tabs, sendMessage: vi.fn().mockResolvedValue({ status: 'pong' }) },
  }));
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const runtime = () => ({
    tabId: 91, vars: { value: 'example' }, pipelineNodes: [], records: [], lines: [], logs: [],
    artifacts: [], workspaceTools: [], actionCounter: 0, lastSuccess: true,
    deferredPrograms: [], observationDeltas: [], learningResults: [], toolDepth: 0,
  });

  it('resolves a native labelled textbox through the semantic layer before fill', async () => {
    vi.spyOn(observation, 'beginObservation').mockResolvedValue();
    vi.spyOn(state, 'readSemanticPageState').mockResolvedValue({
      url: 'http://127.0.0.1:1234/', title: 'fixture', version: 1, capabilities: [],
      nodes: [{ ref: 'ref_7', role: 'textbox', name: 'Name', kind: 'input', frameId: 0, locatorHints: [] }],
    } as any);
    const execute = vi.fn().mockResolvedValue({ status: 'success' });
    vi.spyOn(actions, 'createSemanticActionRegistry').mockReturnValue({ execute } as any);
    const command = parseShellProgram('fill role=textbox name="Name" value=$value').statements[0].pipeline[0];
    const context = runtime();
    const result = await (chromeShellTool as any).executeCommand(command, context, Date.now() + 2000);
    expect(result, JSON.stringify(context.records)).toBe(true);
    expect(execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: 'fill', params: { target: expect.objectContaining({ ref: 'ref_7' }), value: 'example' },
    }));
  });

  it('rejects two same-named fields without executing a fill', async () => {
    vi.spyOn(observation, 'beginObservation').mockResolvedValue();
    vi.spyOn(state, 'readSemanticPageState').mockResolvedValue({
      nodes: [1, 2].map((i) => ({ ref: `ref_${i}`, role: 'textbox', name: 'Name', kind: 'input' })),
    } as any);
    const execute = vi.fn();
    vi.spyOn(actions, 'createSemanticActionRegistry').mockReturnValue({ execute } as any);
    const command = parseShellProgram('fill role=textbox name="Name" value=$value').statements[0].pipeline[0];
    const result = await (chromeShellTool as any).executeCommand(command, runtime(), Date.now() + 2000);
    expect(result).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});
