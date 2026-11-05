import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  diffSemanticStates,
  inspectSemanticPage,
  renderSemanticDelta,
} from '@/entrypoints/background/tools/browser/semantic-state-core';

function visibleTree(): void {
  document.querySelectorAll('*').forEach((node) => {
    (node as any).getClientRects = () => [{ width: 10, height: 10 }];
  });
}

beforeEach(() => {
  if (!(globalThis as any).CSS) (globalThis as any).CSS = {};
  if (!(globalThis as any).CSS.escape) {
    (globalThis as any).CSS.escape = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }
});

afterEach(() => {
  document.body.innerHTML = '';
  delete (window as any).__chromeShellElementMap;
  delete (window as any).__chromeShellRefCounter;
  delete (window as any).__chromeShellElementRefMap;
  delete (window as any).__chromeShellSemanticMeta;
  (window as any).__chromeShellSemanticSignal?.observer?.disconnect?.();
  delete (window as any).__chromeShellSemanticSignal;
});

describe('semantic page state', () => {
  it('excludes the control value and option text from wrapping labels', () => {
    document.body.innerHTML = '<label>Category <select><option value="basic">Basic</option><option value="policy">Policy</option></select></label><label>Notes <textarea>Initial value</textarea></label><label>Name <input placeholder="Enter name"></label>';
    visibleTree();
    const snapshot = inspectSemanticPage({ mode: 'interactive' });
    expect(snapshot.nodes.find((node) => node.role === 'combobox')?.name).toBe('Category');
    expect(snapshot.nodes.find((node) => node.kind === 'textarea')?.name).toBe('Notes');
    expect(snapshot.nodes.find((node) => node.kind === 'input')?.name).toBe('Name');
    expect(snapshot.nodes.filter((node) => node.role === 'option').map((node) => node.name)).toEqual(['Basic', 'Policy']);
  });
  it('keeps refs stable for the same DOM node and versions actual state changes', () => {
    document.body.innerHTML = `
      <form aria-label="创建网站">
        <label for="domain">域名</label>
        <input id="domain" required value="mail.example.com">
        <button id="save">保存</button>
      </form>`;
    visibleTree();

    const first = inspectSemanticPage({ mode: 'interactive' });
    const second = inspectSemanticPage({ mode: 'interactive' });
    expect(second.version).toBe(first.version);
    expect(second.nodes.map((node) => node.ref)).toEqual(first.nodes.map((node) => node.ref));

    const input = document.querySelector<HTMLInputElement>('#domain')!;
    input.value = 'new.example.com';
    const third = inspectSemanticPage({ mode: 'interactive' });
    expect(third.version).toBe(first.version + 1);
    const delta = diffSemanticStates(first, third);
    expect(delta.updated).toHaveLength(1);
    expect(delta.updated[0].ref).toBe(first.nodes.find((n) => n.role === 'textbox')!.ref);
    expect(delta.updated[0].value).toBe('new.example.com');
  });

  it('returns actionable refs for added nodes and reports removed refs', () => {
    document.body.innerHTML = '<button id="a">A</button>';
    visibleTree();
    const before = inspectSemanticPage({ mode: 'interactive' });

    const added = document.createElement('button');
    added.id = 'b';
    added.textContent = 'B';
    (added as any).getClientRects = () => [{ width: 10, height: 10 }];
    document.body.appendChild(added);
    const afterAdd = inspectSemanticPage({ mode: 'interactive' });
    const addDelta = diffSemanticStates(before, afterAdd);
    expect(addDelta.added).toHaveLength(1);
    expect(addDelta.added[0].ref).toMatch(/^ref_\d+$/);
    expect(renderSemanticDelta(addDelta)).toContain(`+ ${addDelta.added[0].ref} button "B"`);

    document.querySelector('#a')!.remove();
    const afterRemove = inspectSemanticPage({ mode: 'interactive' });
    const removeDelta = diffSemanticStates(afterAdd, afterRemove);
    expect(removeDelta.removed).toEqual([before.nodes[0].ref]);
  });

  it('versions semantically identical DOM replacements and expires the old ref', () => {
    document.body.innerHTML = '<button id="save">Save</button>';
    visibleTree();
    const before = inspectSemanticPage({ mode: 'interactive' });
    const oldRef = before.nodes[0].ref;

    const replacement = document.querySelector('button')!.cloneNode(true) as HTMLButtonElement;
    (replacement as any).getClientRects = () => [{ width: 10, height: 10 }];
    document.querySelector('button')!.replaceWith(replacement);
    const after = inspectSemanticPage({ mode: 'interactive' });
    const delta = diffSemanticStates(before, after);

    expect(after.version).toBe(before.version + 1);
    expect(after.nodes[0].ref).not.toBe(oldRef);
    expect(delta.removed).toEqual([oldRef]);
    expect(delta.added[0].ref).toBe(after.nodes[0].ref);
  });

  it('distinguishes equal refs that belong to different frames', () => {
    const before = {
      version: 1,
      url: 'https://a.test',
      title: 'test',
      capabilities: ['native'],
      nodes: [{ ref: 'ref_1', frameId: 0, role: 'button', source: 'native' as const }],
    };
    const after = {
      ...before,
      version: 2,
      nodes: [{ ref: 'ref_1', frameId: 7, role: 'button', source: 'native' as const }],
    };
    const delta = diffSemanticStates(before, after);
    expect(delta.removed).toEqual(['ref_1']);
    expect(delta.added[0].frameId).toBe(7);
  });

  it('supports dialog scope, filtering and native select options', () => {
    document.body.innerHTML = `
      <button>页面按钮</button>
      <div role="dialog" aria-label="选择协议">
        <select aria-label="协议"><option value="http">HTTP</option><option value="https">HTTPS</option></select>
        <button>确定</button>
      </div>`;
    visibleTree();
    const state = inspectSemanticPage({ mode: 'dialog', query: '协议' });
    expect(state.nodes.some((node) => node.role === 'combobox')).toBe(true);
    const select = state.nodes.find((node) => node.role === 'combobox')!;
    expect(select.options).toEqual(['http:HTTP', 'https:HTTPS']);
    expect(state.nodes.some((node) => node.name === '页面按钮')).toBe(false);

    const optionState = inspectSemanticPage({ mode: 'interactive', query: 'HTTPS' });
    expect(optionState.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'option',
          name: 'HTTPS',
          ref: expect.stringMatching(/^ref_/),
        }),
      ]),
    );
  });

  it('treats visible Element UI dropdown items as actionable options', () => {
    document.body.innerHTML = `
      <ul class="el-select-dropdown__list">
        <li class="el-select-dropdown__item">基础平台</li>
        <li class="el-select-dropdown__item">加工事业部贸易</li>
      </ul>`;
    visibleTree();

    const state = inspectSemanticPage({ mode: 'interactive', query: '加工事业部贸易' });

    expect(state.nodes).toEqual([
      expect.objectContaining({
        role: 'option',
        name: '加工事业部贸易',
        ref: expect.stringMatching(/^ref_/),
      }),
    ]);
  });

  it('filters rows by their own content instead of the shared table context', () => {
    document.body.innerHTML = `
      <table>
        <tbody>
          <tr><td>ROLE_001</td><td><button>查看</button></td></tr>
          <tr><td>ROLE_002</td><td><button>查看</button></td></tr>
        </tbody>
      </table>`;
    visibleTree();

    const state = inspectSemanticPage({ mode: 'tables', query: 'ROLE_001' });

    expect(state.nodes.filter((node) => node.role === 'row')).toEqual([
      expect.objectContaining({ name: 'ROLE_001查看' }),
    ]);
  });

  it('keeps semantic versions independent of query mode and output limit', () => {
    document.body.innerHTML = `
      <main>
        <button>A</button>
        <button>B</button>
        <p>status text</p>
      </main>`;
    visibleTree();

    const limited = inspectSemanticPage({ mode: 'interactive', limit: 1 });
    const expanded = inspectSemanticPage({ mode: 'interactive', limit: 20 });
    const queried = inspectSemanticPage({ mode: 'text', query: 'status' });

    expect(expanded.version).toBe(limited.version);
    expect(queried.version).toBe(limited.version);
    expect(diffSemanticStates(limited, expanded)).toEqual(
      expect.objectContaining({ added: [], updated: [], removed: [] }),
    );
  });
  it('names nodes from rendered text only and normalizes invisible characters', () => {
    document.body.innerHTML = `
      <div tabindex="0">Picker<style>.picker{z-index:1}</style><script>var x = 1</script></div>
      <select><option>A</option><option>B</option></select>
      <button>发送 &#x202A;(Ctrl-Enter)&#x202C;</button>`;
    visibleTree();
    const state = inspectSemanticPage({ mode: 'interactive' });
    const names = state.nodes.filter((node) => node.role !== 'option').map((node) => node.name);
    expect(names).toEqual(['Picker', undefined, '发送 (Ctrl-Enter)']);
  });

  it('filters role and name before applying the limit', () => {
    document.body.innerHTML = `${'<button>菜单</button>'.repeat(30)}<button>导出账单CSV</button>`;
    visibleTree();
    const state = inspectSemanticPage({ mode: 'interactive', role: 'button', name: '导出账单CSV', limit: 5 });
    expect(state.nodes.map((node) => node.name)).toEqual(['导出账单CSV']);
    const contains = inspectSemanticPage({ mode: 'interactive', nameContains: '账单', limit: 5 });
    expect(contains.nodes).toHaveLength(1);
  });

  it('excludes content under an aria-hidden ancestor and selects dialogs by role', () => {
    document.body.innerHTML = `
      <div aria-hidden="true"><button>隐藏</button></div>
      <div role="dialog" aria-label="确认提示"><button>好的</button></div>`;
    visibleTree();
    expect(inspectSemanticPage({ mode: 'interactive' }).nodes.map((node) => node.name)).toEqual(['好的']);
    const dialogs = inspectSemanticPage({ mode: 'interactive', role: 'dialog' });
    expect(dialogs.nodes.map((node) => node.name)).toEqual(['确认提示']);
  });

  it('picks the dialog named by the query instead of the first visible one', () => {
    document.body.innerHTML = `
      <div role="dialog" aria-label="产品面板"><button>展开</button></div>
      <div role="dialog" aria-label="导出账单CSV"><button>确定导出</button></div>`;
    visibleTree();
    const state = inspectSemanticPage({ mode: 'dialog', query: '导出账单CSV' });
    expect(state.nodes.map((node) => node.name)).toContain('确定导出');
    expect(state.nodes.map((node) => node.name)).not.toContain('展开');
  });

  it('reports text blocks once instead of repeating every ancestor', () => {
    document.body.innerHTML = `<main><article><p>第一段 <b>加粗</b></p><p>第二段</p></article></main>`;
    visibleTree();
    const names = inspectSemanticPage({ mode: 'text' }).nodes.map((node) => node.name);
    expect(names).toEqual(['第一段 加粗', '第二段']);
  });

  it('treats scripted anchors and pointer cards as clickable', () => {
    document.body.innerHTML = `
      <a onclick="void 0">下载</a>
      <div style="cursor:pointer"><span>SSH服务器</span></div>`;
    visibleTree();
    const state = inspectSemanticPage({ mode: 'interactive' });
    expect(state.nodes.map((node) => [node.role, node.name])).toEqual([
      ['link', '下载'],
      ['generic', 'SSH服务器'],
    ]);
  });

  it('returns a scope error marker instead of throwing inside the page', () => {
    document.body.innerHTML = '<button>x</button>';
    visibleTree();
    const state = inspectSemanticPage({ scopeRef: 'ref_999' });
    expect(state.capabilities[0]).toMatch(/^semantic-error:scope ref "ref_999"/);
  });
});
