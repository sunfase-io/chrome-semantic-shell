import { describe, it, expect, afterEach } from 'vitest';
import {
  beginPageDiff,
  collectPageDiff,
  formatChanges,
} from '@/entrypoints/background/tools/browser/page-diff-core';

const flushObserver = () => new Promise((r) => setTimeout(r, 0));

if (!(globalThis as any).CSS) (globalThis as any).CSS = {};
if (!(globalThis as any).CSS.escape) (globalThis as any).CSS.escape = (value: string) => value;

function el(html: string): Element {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  const node = tpl.content.firstElementChild!;
  document.body.appendChild(node);
  return node;
}

afterEach(() => {
  collectPageDiff(); // tears down any leftover observer/state
  document.body.innerHTML = '';
});

describe('beginPageDiff / collectPageDiff', () => {
  it('reports expired when collect is called without begin', () => {
    expect(collectPageDiff().expired).toBe(true);
  });

  it('captures newly appeared validation errors', async () => {
    beginPageDiff();
    el('<div class="el-form-item__error">供应商不能为空</div>');
    await flushObserver();
    const d = collectPageDiff();
    expect(d.errorsAdded).toEqual(['供应商不能为空']);
    expect(d.errorsRemoved).toEqual([]);
    // exact error text is filtered out of the generic text delta
    expect(d.newText).not.toContain('供应商不能为空');
  });

  it('captures cleared validation errors', async () => {
    const err = el('<div class="el-form-item__error">数量必须大于0</div>');
    beginPageDiff();
    err.remove();
    await flushObserver();
    const d = collectPageDiff();
    expect(d.errorsAdded).toEqual([]);
    expect(d.errorsRemoved).toEqual(['数量必须大于0']);
  });

  it('captures opened dialogs with their title', async () => {
    beginPageDiff();
    el(
      '<div class="el-dialog__wrapper"><div class="el-dialog__title">选择供应商</div><div>正文内容</div></div>',
    );
    await flushObserver();
    const d = collectPageDiff();
    expect(d.dialogsOpened).toEqual(['选择供应商']);
    expect(d.dialogsClosed).toEqual([]);
  });

  it('captures generic ARIA dialogs and transient live-region toasts', async () => {
    beginPageDiff();
    el('<section role="dialog" aria-label="创建网站"><button>确认</button></section>');
    const toast = el('<div role="status">创建成功</div>');
    await flushObserver();
    toast.remove();
    const d = collectPageDiff();
    expect(d.dialogsOpened).toEqual(['创建网站']);
    expect(d.toasts).toEqual(['创建成功']);
  });

  it('pairs aria-invalid errors with their field label', () => {
    document.body.innerHTML = `
      <label for="domain">域名</label>
      <input id="domain" aria-invalid="true" aria-errormessage="domain-error">
      <span id="domain-error">格式错误</span>`;
    beginPageDiff();
    const input = document.querySelector('#domain')!;
    input.setAttribute('aria-errormessage', 'domain-error-2');
    const error = document.createElement('span');
    error.id = 'domain-error-2';
    error.textContent = '域名不能为空';
    document.body.appendChild(error);
    const d = collectPageDiff();
    expect(d.errorsAdded).toContain('域名: 域名不能为空');
  });

  it('captures transient toasts via the observer, separate from newText', async () => {
    beginPageDiff();
    const toast = el('<div class="el-message">保存成功</div>');
    await flushObserver();
    toast.remove(); // toast auto-dismissed before collect — must still be reported
    const d = collectPageDiff();
    expect(d.toasts).toEqual(['保存成功']);
    expect(d.newText).not.toContain('保存成功');
  });

  it('dedupes generic new text and ignores non-element nodes', async () => {
    beginPageDiff();
    el('<div>加载完成</div>');
    el('<div>加载完成</div>');
    await flushObserver();
    const d = collectPageDiff();
    expect(d.newText).toEqual(['加载完成']);
  });

  it('pairs validation errors with their form-item label', async () => {
    beginPageDiff();
    el(
      '<div class="el-form-item"><label class="el-form-item__label">供应商:</label>' +
        '<div class="el-form-item__error">必填项</div></div>',
    );
    await flushObserver();
    const d = collectPageDiff();
    expect(d.errorsAdded).toEqual(['供应商: 必填项']);
  });

  it('re-begin resets the baseline', async () => {
    beginPageDiff();
    el('<div class="el-form-item__error">旧错误</div>');
    await flushObserver();
    beginPageDiff(); // new baseline includes 旧错误
    const d = collectPageDiff();
    expect(d.errorsAdded).toEqual([]);
  });
});

describe('formatChanges', () => {
  it('renders a compact combined line', () => {
    const text = formatChanges(
      {
        errorsAdded: ['供应商不能为空'],
        dialogsOpened: ['选择供应商'],
        toasts: ['保存成功'],
        newText: ['第 2 页'],
      },
      { consoleErrors: ['TypeError: x is undefined'] },
    );
    expect(text).toBe(
      'changes: errors added: 供应商不能为空 | dialogs opened: 选择供应商 | toasts: 保存成功 | console errors: TypeError: x is undefined | new text: 第 2 页',
    );
  });

  it('collapses exact repeated errors with a count', () => {
    const text = formatChanges({ errorsAdded: ['必填项', '必填项', '必填项', '数量必须大于0'] });
    expect(text).toBe('changes: errors added: 必填项 ×3; 数量必须大于0');
  });

  it('includes the api segment, and keeps it when the page navigated away', () => {
    const api = 'api: POST /order/enable 200 312ms';
    expect(formatChanges({ toasts: ['启用成功'] }, { apiCalls: api })).toBe(
      'changes: toasts: 启用成功 | ' + api,
    );
    // a navigation tears down the DOM observer, but the calls that caused it still matter
    expect(formatChanges({ expired: true }, { apiCalls: api })).toContain(api);
  });

  it('reports none detected with the settle window', () => {
    expect(formatChanges({}, { settleMs: 300 })).toBe('changes: none detected (settled 300ms)');
  });

  it('reports navigation reset with the url change', () => {
    const text = formatChanges(
      { expired: true },
      { urlBefore: 'https://a/x', urlAfter: 'https://a/y' },
    );
    expect(text).toBe(
      'changes: url: https://a/x -> https://a/y | page navigated/reloaded (observation context reset)',
    );
  });
});
