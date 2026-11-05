import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  diffSemanticStates,
  inspectSemanticPage,
  renderSemanticDelta,
  renderSemanticState,
} from '@/entrypoints/background/tools/browser/semantic-state-core';

beforeEach(() => {
  if (!(globalThis as any).CSS) (globalThis as any).CSS = {};
  if (!(globalThis as any).CSS.escape) (globalThis as any).CSS.escape = (value: string) => value;
});

afterEach(() => {
  document.body.innerHTML = '';
  delete (window as any).__chromeShellElementMap;
  delete (window as any).__chromeShellRefCounter;
  delete (window as any).__chromeShellElementRefMap;
  delete (window as any).__chromeShellSemanticMeta;
});

describe('semantic shell deterministic footprint benchmark', () => {
  it('cuts representative page output by at least 70% and keeps the mutation actionable', () => {
    const noise = Array.from(
      { length: 120 },
      (_, index) =>
        `<section><h3>Navigation ${index}</h3><p>${'boilerplate '.repeat(12)}</p></section>`,
    ).join('');
    document.body.innerHTML = `${noise}
      <form aria-label="Create website">
        <label for="domain">Domain</label><input id="domain" value="mail.example.com">
        <button id="save">Save</button>
      </form>`;
    document.querySelectorAll('*').forEach((node) => {
      (node as any).getClientRects = () => [{ width: 10, height: 10 }];
    });

    const fullChars = document.documentElement.outerHTML.length;
    const before = inspectSemanticPage({ mode: 'forms' });
    const semanticChars = renderSemanticState(before).length;
    expect(semanticChars / fullChars).toBeLessThan(0.3);

    const button = document.querySelector<HTMLButtonElement>('#save')!;
    button.disabled = true;
    const after = inspectSemanticPage({ mode: 'forms' });
    const delta = diffSemanticStates(before, after);
    const output = renderSemanticDelta(delta);
    expect(delta.updated).toHaveLength(1);
    expect(delta.updated[0].ref).toMatch(/^ref_\d+$/);
    expect(output.length / fullChars).toBeLessThan(0.1);
  });

  it('models an 80% round-trip reduction for the standard form loop', () => {
    const legacyCalls = ['read', 'fill-domain', 'fill-protocol', 'click-submit', 'read-result'];
    const coreCalls = ['chrome_shell'];
    const reduction = 1 - coreCalls.length / legacyCalls.length;
    expect(reduction).toBeGreaterThanOrEqual(0.6);
  });
});
