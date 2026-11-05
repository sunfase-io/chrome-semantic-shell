import type { SemanticNode, SemanticPageState, SemanticSource } from 'chrome-semantic-shell-shared';

interface FrameworkField {
  selector: string;
  role?: string;
  name?: string;
  value?: string;
  required?: boolean;
  disabled?: boolean;
  options?: string[];
  optionsTotal?: number;
  source: Extract<SemanticSource, 'vue2' | 'vue3' | 'react'>;
}

interface FrameworkInspection {
  capabilities: string[];
  fields: FrameworkField[];
}

/** MAIN-world, best-effort framework enrichment. Native/ARIA remains the baseline. */
export function inspectFrameworkAdapters(): FrameworkInspection {
  const capabilities = new Set<string>();
  const fields: FrameworkField[] = [];
  const seen = new Set<string>();

  const text = (value: any, max = 120): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value.slice(0, max);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return undefined;
  };
  const cssPath = (el: Element): string => {
    const html = el as HTMLElement;
    if (html.id) return `#${CSS.escape(html.id)}`;
    const testId = el.getAttribute('data-testid');
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body) {
      let part = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const same = (Array.from(parent.children) as Element[]).filter(
          (x) => x.tagName === cur!.tagName,
        );
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      const candidate = parts.join(' > ');
      if (document.querySelectorAll(candidate).length === 1) return candidate;
      cur = parent;
    }
    return `body > ${parts.join(' > ')}`;
  };
  const add = (el: Element | null | undefined, field: Omit<FrameworkField, 'selector'>) => {
    if (!el) return;
    const selector = cssPath(el);
    const key = `${field.source}|${selector}`;
    if (seen.has(key)) return;
    seen.add(key);
    // Keep this injected function self-contained. Object spread is lowered by the
    // extension build to an outer helper that does not exist in the MAIN world.
    fields.push(Object.assign({ selector }, field));
  };
  const getPath = (object: any, path: string): any =>
    String(path || '')
      .split('.')
      .filter(Boolean)
      .reduce((value, key) => (value == null ? value : value[key]), object);

  const vueName = (vm: any): string => vm?.$options?.name || '';
  const findVueAncestor = (vm: any, name: string): any => {
    for (let current = vm?.$parent; current; current = current.$parent) {
      if (vueName(current) === name) return current;
    }
    return undefined;
  };
  const findVueControl = (vm: any): any => {
    const controlNames = new Set([
      'ElSelect',
      'ElCascader',
      'ElDatePicker',
      'ElTimePicker',
      'ElTimeSelect',
      'ElInputNumber',
      'ElSwitch',
      'ElRadioGroup',
      'ElCheckboxGroup',
      'ElInput',
    ]);
    const queue = [...(vm?.$children || [])];
    for (let visited = 0; queue.length && visited < 200; visited++) {
      const current = queue.shift();
      if (!current) continue;
      if (controlNames.has(vueName(current))) return current;
      queue.push(...(current.$children || []));
    }
    return undefined;
  };
  const vue2Options = (controlVm: any): string[] => {
    if (vueName(controlVm) !== 'ElSelect') return [];
    const raw = Array.isArray(controlVm?.options) ? controlVm.options : [];
    return raw
      .map((option: any) => {
        const label = text(option?.currentLabel ?? option?.label ?? option?.$el?.textContent);
        const value = text(option?.value);
        return value && label && value !== label ? `${value}:${label}` : label || value || '';
      })
      .filter(Boolean);
  };
  const vueFieldMeta = (controlVm: any) => {
    for (
      let current = controlVm?.$parent, depth = 0;
      current && depth < 12;
      current = current.$parent, depth++
    ) {
      const label =
        text(current.label) || text(current.$props?.label) || text(current.$attrs?.label);
      const prop = text(current.prop) || text(current.$props?.prop) || text(current.$attrs?.prop);
      if (label || prop) {
        return {
          label: label || prop,
          prop,
          required: Boolean(
            current.required || current.$props?.required || current.$attrs?.required,
          ),
        };
      }
    }
    return {} as { label?: string; prop?: string; required?: boolean };
  };

  // Vue 2 / Element UI
  let vue2Root: any = null;
  for (const el of Array.from(document.querySelectorAll('*')).slice(0, 2000) as any[]) {
    if (el.__vue__) {
      vue2Root = el.__vue__.$root || el.__vue__;
      break;
    }
  }
  if (vue2Root) {
    capabilities.add('vue2');
    const stack = [vue2Root];
    let visited = 0;
    while (stack.length && visited++ < 8000) {
      const vm: any = stack.pop();
      if (!vm) continue;
      const componentName = vm.$options?.name;
      if (componentName === 'ElFormItem') {
        const form = findVueAncestor(vm, 'ElForm');
        const prop = String(vm.prop || '');
        const controlVm = findVueControl(vm);
        const control = controlVm?.$el?.matches?.(
          'input,textarea,select,[role="combobox"],[role="switch"]',
        )
          ? controlVm.$el
          : controlVm?.$el?.querySelector?.(
              'input,textarea,select,[role="combobox"],[role="switch"]',
            ) || vm.$el?.querySelector?.('input,textarea,select,[role="combobox"],[role="switch"]');
        const rules = ([] as any[]).concat(getPath(form?.rules, prop) || [], vm.rules || []);
        const options = vue2Options(controlVm);
        const isSelect = vueName(controlVm) === 'ElSelect';
        add(control, {
          role: isSelect ? 'combobox' : control?.getAttribute?.('role') || undefined,
          name: text(vm.label) || prop,
          value: text(getPath(form?.model, prop) ?? controlVm?.value ?? control?.value),
          required: Boolean(vm.required || vm.isRequired || rules.some((rule) => rule?.required)),
          disabled: Boolean(
            controlVm?.disabled ||
            control?.disabled ||
            control?.getAttribute?.('aria-disabled') === 'true',
          ),
          options: options.slice(0, 20),
          optionsTotal: options.length || undefined,
          source: 'vue2',
        });
      }
      if (componentName === 'ElSelect') {
        const control = vm.$el?.querySelector?.('input,[role="combobox"]');
        const meta = vueFieldMeta(vm);
        const options = vue2Options(vm);
        add(control, {
          role: 'combobox',
          name: meta.label || text(control?.getAttribute?.('placeholder')),
          value: text(vm.value ?? control?.value),
          required: meta.required,
          disabled: Boolean(
            vm.disabled || control?.disabled || control?.getAttribute?.('aria-disabled') === 'true',
          ),
          options: options.slice(0, 20),
          optionsTotal: options.length || undefined,
          source: 'vue2',
        });
      }
      for (const child of vm.$children || []) stack.push(child);
    }
  }

  // Vue 3 / Element Plus. Vue attaches __vueParentComponent to rendered DOM nodes.
  const appRoot = Array.from(document.querySelectorAll('*')).find(
    (el: any) => el.__vue_app__,
  ) as any;
  if (appRoot?.__vue_app__) capabilities.add('vue3');
  if (appRoot?.__vue_app__) {
    const controls = document.querySelectorAll(
      'input,textarea,select,button,[role="combobox"],[role="switch"],[role="checkbox"],[role="radio"]',
    );
    controls.forEach((control: any) => {
      let component = control.__vueParentComponent;
      let props: any = null;
      let depth = 0;
      while (component && depth++ < 12) {
        const candidate = component.props || component.vnode?.props;
        if (
          candidate &&
          (candidate.modelValue !== undefined || candidate.label || candidate.placeholder)
        ) {
          props = candidate;
          break;
        }
        component = component.parent;
      }
      if (!props) return;
      const rawOptions = Array.isArray(props.options) ? props.options : [];
      const options = rawOptions
        .map((option: any) => {
          if (typeof option === 'string') return option;
          const label = text(option?.label) || text(option?.name) || text(option?.value) || '';
          const value = text(option?.value);
          return value && value !== label ? `${value}:${label}` : label;
        })
        .filter(Boolean);
      add(control, {
        role:
          control.getAttribute('role') ||
          (control.closest?.('.el-select') || control.getAttribute('aria-haspopup') === 'listbox'
            ? 'combobox'
            : undefined),
        name:
          text(props.label) || text(props.placeholder) || text(control.getAttribute('aria-label')),
        value: text(props.modelValue ?? control.value),
        required: Boolean(props.required),
        disabled: Boolean(props.disabled),
        options: options.slice(0, 20),
        optionsTotal: options.length || undefined,
        source: 'vue3',
      });
    });
  }

  // React. DOM nodes retain fiber/props keys in production; use only serializable public props.
  document
    .querySelectorAll('input,textarea,select,button,[role],[data-radix-collection-item]')
    .forEach((control: any) => {
      const keys = Object.getOwnPropertyNames(control);
      const propsKey = keys.find((key) => key.startsWith('__reactProps$'));
      const fiberKey = keys.find((key) => key.startsWith('__reactFiber$'));
      if (!propsKey && !fiberKey) return;
      capabilities.add('react');
      const props =
        (propsKey && control[propsKey]) || (fiberKey && control[fiberKey]?.memoizedProps) || {};
      const rawOptions = Array.isArray(props.options) ? props.options : [];
      const options = rawOptions
        .map((option: any) => {
          if (typeof option === 'string') return option;
          const label = text(option?.label) || text(option?.name) || text(option?.value) || '';
          const value = text(option?.value);
          return value && value !== label ? `${value}:${label}` : label;
        })
        .filter(Boolean);
      add(control, {
        role: props.role || control.getAttribute('role') || undefined,
        name: text(props['aria-label']) || text(props.placeholder) || text(props.label),
        value: text(props.value ?? props.defaultValue ?? control.value),
        required: Boolean(props.required || props['aria-required']),
        disabled: Boolean(props.disabled || props['aria-disabled']),
        options: options.slice(0, 20),
        optionsTotal: options.length || undefined,
        source: 'react',
      });
    });

  return { capabilities: [...capabilities], fields };
}

export async function readFrameworkInspection(tabId: number): Promise<FrameworkInspection> {
  const results = (await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: inspectFrameworkAdapters,
  } as any)) as Array<{ result?: FrameworkInspection; error?: string }>;
  const injection = results?.[0];
  if (!injection) {
    throw new Error('Framework adapter injection returned no result');
  }
  if (injection.error) {
    throw new Error(`Framework adapter injection failed: ${injection.error}`);
  }
  const inspection = injection.result;
  if (!inspection || !Array.isArray(inspection.capabilities) || !Array.isArray(inspection.fields)) {
    throw new Error('Framework adapter injection returned an invalid result');
  }
  return inspection;
}

export function mergeFrameworkInspection(
  state: SemanticPageState,
  inspection: FrameworkInspection,
): SemanticPageState {
  if (!inspection.capabilities.length && !inspection.fields.length) return state;
  const nodes = state.nodes.map((node) => {
    if ((node.frameId || 0) !== 0) return node;
    const css = node.locatorHints?.find((hint) => hint.kind === 'css')?.value;
    const match =
      (css && inspection.fields.find((field) => field.selector === css)) ||
      inspection.fields.find(
        (field) => field.name && node.name && field.name.trim() === node.name.trim(),
      );
    if (!match) return node;
    return {
      ...node,
      role: match.role || node.role,
      name: match.name || node.name,
      value: match.value ?? node.value,
      source: match.source,
      states: {
        ...node.states,
        required: match.required ?? node.states?.required,
        disabled: match.disabled ?? node.states?.disabled,
      },
      options: match.options?.length ? match.options : node.options,
      optionsTotal: match.optionsTotal ?? node.optionsTotal,
    } as SemanticNode;
  });
  return {
    ...state,
    nodes,
    capabilities: [...new Set([...state.capabilities, ...inspection.capabilities])],
  };
}
