import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromeShellTool } from '@/entrypoints/background/tools/browser/semantic-shell';
import { parseShellProgram } from '@/entrypoints/background/tools/browser/semantic-shell-dsl';
import { renderSemanticDelta, renderSemanticState } from '@/entrypoints/background/tools/browser/semantic-state-core';
import * as state from '@/entrypoints/background/tools/browser/semantic-state';
import { ForegroundScope } from '@/entrypoints/background/tools/browser/background-session';

const page = (version: number, nodes: object[]) =>
  ({ url: 'http://127.0.0.1:1234/', title: 'fixture', version, capabilities: [], nodes }) as any;
const save = (disabled: boolean) => ({ ref: 'ref_2', role: 'button', name: 'Save', states: { disabled } }) as any;
const email = { ref: 'ref_1', role: 'textbox', name: 'Email', value: '', states: { disabled: false, required: false, invalid: false } };

describe('inspect output', () => {
  it('lists only the states that differ from their defaults', () => {
    const text = renderSemanticState(page(3, [email, save(true), { ref: 'ref_3', role: 'checkbox', name: 'On', states: { checked: false } }]));
    expect(text).toContain('- ref_1 textbox "Email"\n');
    expect(text).toContain('- ref_2 button "Save" disabled=true');
    expect(text).toContain('- ref_3 checkbox "On" checked=false');
  });

  it('keeps default values on an updated node, where they are the change', () => {
    const text = renderSemanticDelta({ fromVersion: 3, toVersion: 4, added: [], updated: [save(false)], removed: [], events: [], api: [] });
    expect(text).toContain('~ ref_2 button "Save" disabled=false');
  });
});

describe('a wait in vain', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports the state of the tab, with the failure on the status line', async () => {
    vi.stubGlobal('chrome', {
      ...chrome,
      tabs: { ...chrome.tabs, get: vi.fn().mockResolvedValue({ id: 91, active: false, status: 'complete', windowId: 1, url: 'http://127.0.0.1/' }) },
      windows: { get: vi.fn().mockResolvedValue({ state: 'minimized', focused: false }) },
      scripting: { executeScript: vi.fn(async ({ func }: any) => [{ result: func.length ? false : 'visible' }]) },
    });
    const result = await chromeShellTool.execute({ script: 'wait text="Saved" timeout=50', tabId: 91 });
    const text = (result.content[0] as any).text as string;
    expect(result.isError).toBe(true);
    expect(text.split('\n')[0]).toMatch(/^failed tab=91 .* error=wait: Text "Saved" did not appear within 50ms/);
    expect(text).toContain('(tab 91 complete, background tab, window minimized, page visible)');
  });
});

describe('inspect since=', () => {
  beforeEach(() => vi.stubGlobal('chrome', {
    ...chrome,
    tabs: { ...chrome.tabs, get: vi.fn().mockResolvedValue({ id: 91, active: true, windowId: 1 }) },
    windows: { get: vi.fn().mockResolvedValue({ state: 'normal', focused: true }) },
  }));
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const runtime = () => ({
    tabId: 91, vars: {}, pipelineNodes: [], records: [] as any[], lines: [] as string[], logs: [],
    artifacts: [], workspaceTools: [], actionCounter: 0, lastSuccess: true,
    deferredPrograms: [], observationDeltas: [], learningResults: [], toolDepth: 0, foreground: new ForegroundScope(), warnings: [],
  });
  const run = async (script: string) => {
    const context = runtime();
    const ok = await (chromeShellTool as any).executeCommand(parseShellProgram(script).statements[0].pipeline[0], context, Date.now() + 2000);
    return { ok, text: context.lines.join('\n'), records: context.records };
  };

  it('prints only what changed since an inspect of the same view in an earlier program', async () => {
    const read = vi.spyOn(state, 'readSemanticPageState');
    read.mockResolvedValueOnce(page(5, [email, save(true)]));
    expect((await run('inspect forms')).text).toContain('state=v5');
    read.mockResolvedValueOnce(page(6, [email, save(false), { ref: 'ref_9', role: 'status', name: 'Saved' }]));
    const { text } = await run('inspect forms since=v5');
    expect(text).toBe('delta v5->v6\n+ ref_9 status "Saved"\n~ ref_2 button "Save" disabled=false');
  });

  it('fails fast when the baseline is not a recent inspect of that view', async () => {
    const read = vi.spyOn(state, 'readSemanticPageState').mockResolvedValue(page(7, [email]));
    await run('inspect forms');
    read.mockResolvedValue(page(8, [email]));
    const other = await run('inspect interactive since=v7');
    expect(other.ok).toBe(false);
    expect(other.records[0].detail).toContain('since=v7: no recent inspect of this view');
  });
});
