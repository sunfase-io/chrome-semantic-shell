import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  inspectFrameworkAdapters,
  mergeFrameworkInspection,
  readFrameworkInspection,
} from '@/entrypoints/background/tools/browser/framework-adapters';

beforeEach(() => {
  if (!(globalThis as any).CSS) (globalThis as any).CSS = {};
  if (!(globalThis as any).CSS.escape) (globalThis as any).CSS.escape = (value: string) => value;
});

afterEach(() => {
  document.body.innerHTML = '';
  delete (chrome as any).scripting;
});

describe('framework adapters', () => {
  it('extracts Vue 2 Element UI form fields', () => {
    const host = document.createElement('div') as any;
    host.innerHTML = '<input id="supplier">';
    document.body.appendChild(host);
    const field: any = {
      $options: { name: 'ElFormItem' },
      prop: 'supplier',
      label: '供应商',
      $el: host,
      $children: [],
    };
    const form: any = {
      $options: { name: 'ElForm' },
      model: { supplier: 'S001' },
      rules: { supplier: [{ required: true }] },
      $children: [field],
    };
    field.$parent = form;
    const root: any = { $options: {}, $children: [form] };
    form.$parent = root;
    root.$root = root;
    host.__vue__ = root;

    const result = inspectFrameworkAdapters();
    expect(result.capabilities).toContain('vue2');
    expect(result.fields[0]).toMatchObject({ name: '供应商', value: 'S001', required: true });
  });

  it('extracts closed Vue 2 ElSelect options and exposes the proxy input as a combobox', () => {
    const host = document.createElement('div') as any;
    host.innerHTML = '<div class="el-select"><input id="system" placeholder="基础平台"></div>';
    document.body.appendChild(host);
    const selectHost = host.querySelector('.el-select') as any;
    const select: any = {
      $options: { name: 'ElSelect' },
      $el: selectHost,
      value: 44,
      disabled: false,
      options: [
        { value: 1, currentLabel: '基础平台' },
        { value: 44, currentLabel: '加工事业部贸易' },
      ],
      $children: [],
    };
    const field: any = {
      $options: { name: 'ElFormItem' },
      prop: 'sysid',
      label: '所属系统',
      $el: host,
      $children: [select],
    };
    const form: any = {
      $options: { name: 'ElForm' },
      model: { sysid: 44 },
      rules: {},
      $children: [field],
    };
    const root: any = { $options: {}, $children: [form] };
    root.$root = root;
    form.$parent = root;
    field.$parent = form;
    select.$parent = field;
    host.__vue__ = root;

    const result = inspectFrameworkAdapters();

    expect(result.fields[0]).toMatchObject({
      role: 'combobox',
      name: '所属系统',
      value: '44',
      options: ['1:基础平台', '44:加工事业部贸易'],
      optionsTotal: 2,
    });
  });

  it('finds labels through custom wrapper ancestors around a standalone ElSelect', () => {
    const host = document.createElement('div') as any;
    host.innerHTML =
      '<div class="el-select"><input id="wrapped-system" placeholder="请选择"></div>';
    document.body.appendChild(host);
    const select: any = {
      $options: { name: 'ElSelect' },
      $el: host.querySelector('.el-select'),
      value: 44,
      options: [{ value: 44, currentLabel: '加工事业部贸易' }],
      $children: [],
    };
    const trSelect: any = { $options: { name: 'TrSelect' }, $children: [select] };
    const trCell: any = {
      $options: { name: 'TrCell' },
      $props: { label: '所属系统' },
      $children: [trSelect],
    };
    const root: any = { $options: {}, $children: [trCell] };
    root.$root = root;
    trCell.$parent = root;
    trSelect.$parent = trCell;
    select.$parent = trSelect;
    host.__vue__ = root;

    expect(inspectFrameworkAdapters().fields[0]).toMatchObject({
      role: 'combobox',
      name: '所属系统',
      value: '44',
      options: ['44:加工事业部贸易'],
    });
  });

  it('keeps deeply nested sibling controls distinct', () => {
    const page = document.createElement('main') as any;
    page.innerHTML = `
      <section><div><div><div><div><div class="el-select"><input></div></div></div></div></div></section>
      <section><div><div><div><div><div class="el-select"><input></div></div></div></div></div></section>
    `;
    document.body.appendChild(page);
    const controls = page.querySelectorAll('.el-select');
    const first: any = {
      $options: { name: 'ElSelect' },
      $el: controls[0],
      value: 1,
      options: [{ value: 1, currentLabel: '基础平台' }],
      $children: [],
    };
    const second: any = {
      $options: { name: 'ElSelect' },
      $el: controls[1],
      value: 10,
      options: [{ value: 10, currentLabel: '10条/页' }],
      $children: [],
    };
    const firstWrapper: any = {
      $options: { name: 'TrCell' },
      $props: { label: '所属系统' },
      $children: [first],
    };
    const secondWrapper: any = {
      $options: { name: 'ElPagination' },
      $children: [second],
    };
    const root: any = { $options: {}, $children: [firstWrapper, secondWrapper] };
    root.$root = root;
    firstWrapper.$parent = root;
    secondWrapper.$parent = root;
    first.$parent = firstWrapper;
    second.$parent = secondWrapper;
    page.__vue__ = root;

    const fields = inspectFrameworkAdapters().fields;

    expect(fields).toHaveLength(2);
    expect(new Set(fields.map((field) => field.selector)).size).toBe(2);
    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '所属系统', options: ['1:基础平台'] }),
        expect.objectContaining({ options: ['10:10条/页'] }),
      ]),
    );
  });

  it('extracts Vue 3 and React public props when available', () => {
    const app = document.createElement('div') as any;
    app.__vue_app__ = {};
    const vueInput = document.createElement('input') as any;
    vueInput.id = 'vue3';
    vueInput.__vueParentComponent = {
      props: { label: '组织', modelValue: '铜材', required: true },
      parent: null,
    };
    app.appendChild(vueInput);

    const reactInput = document.createElement('input') as any;
    reactInput.id = 'react';
    reactInput.__reactProps$test = {
      'aria-label': '邮箱',
      value: 'sun@example.com',
      required: true,
    };
    app.appendChild(reactInput);
    document.body.appendChild(app);

    const result = inspectFrameworkAdapters();
    expect(result.capabilities).toEqual(expect.arrayContaining(['vue3', 'react']));
    expect(result.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'vue3', name: '组织', value: '铜材' }),
        expect.objectContaining({ source: 'react', name: '邮箱', value: 'sun@example.com' }),
      ]),
    );
  });

  it('fails fast when MAIN-world injection returns no result', async () => {
    (chrome as any).scripting = {
      executeScript: vi.fn().mockResolvedValue([{ frameId: 0 }]),
    };

    await expect(readFrameworkInspection(123)).rejects.toThrow(
      'Framework adapter injection returned an invalid result',
    );
  });

  it('surfaces MAIN-world injection errors', async () => {
    (chrome as any).scripting = {
      executeScript: vi.fn().mockResolvedValue([{ error: 'Cannot access contents of the page' }]),
    };

    await expect(readFrameworkInspection(123)).rejects.toThrow(
      'Framework adapter injection failed: Cannot access contents of the page',
    );
  });

  it('prefers an exact selector over an earlier placeholder-name match', () => {
    const state: any = {
      version: 1,
      url: 'https://example.com',
      title: 'Example',
      capabilities: ['native'],
      nodes: [
        {
          ref: 'ref_1',
          role: 'textbox',
          kind: 'input',
          name: '请选择',
          source: 'native',
          states: {},
          locatorHints: [{ kind: 'css', value: '#system' }],
        },
      ],
    };
    const inspection: any = {
      capabilities: ['vue2'],
      fields: [
        {
          selector: '#pagination',
          role: 'combobox',
          name: '请选择',
          value: '10',
          options: ['10:10条/页'],
          source: 'vue2',
        },
        {
          selector: '#system',
          role: 'combobox',
          name: '所属系统',
          value: '1',
          options: ['1:基础平台', '44:加工事业部贸易'],
          source: 'vue2',
        },
      ],
    };

    expect(mergeFrameworkInspection(state, inspection).nodes[0]).toMatchObject({
      role: 'combobox',
      name: '所属系统',
      value: '1',
      options: ['1:基础平台', '44:加工事业部贸易'],
      source: 'vue2',
    });
  });
});
