import type {
  SemanticLocatorHint,
  SemanticNode,
  SemanticPageDelta,
  SemanticPageState,
} from 'chrome-semantic-shell-shared';

export interface SemanticInspectOptions {
  mode?: 'interactive' | 'forms' | 'tables' | 'dialog' | 'text' | 'full';
  query?: string;
  limit?: number;
  scopeRef?: string;
  /** Background-only routing hint. The page extractor ignores it. */
  scopeFrameId?: number;
  includeAdapters?: boolean;
  /** Filters applied in the page before `limit`, so a crowded page cannot hide the target. */
  role?: string;
  name?: string;
  nameContains?: string;
  selector?: string;
}

/** Marker capability carrying a page-side error; executeScript drops thrown exceptions. */
export const SEMANTIC_ERROR_CAPABILITY = 'semantic-error:';

export interface SemanticPageSignal {
  revision: number;
  url: string;
}

export function inspectSemanticSignal(): SemanticPageSignal {
  const w = window as any;
  if (!w.__chromeShellSemanticSignal) {
    const signal = { revision: 0 };
    const bump = () => {
      signal.revision += 1;
    };
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    document.addEventListener('input', bump, true);
    document.addEventListener('change', bump, true);
    w.__chromeShellSemanticSignal = { signal, observer };
  }
  return { revision: w.__chromeShellSemanticSignal.signal.revision, url: location.href };
}

/**
 * Page-side semantic extractor. The body is serialized with Function#toString,
 * so it deliberately contains all helpers and uses no outer runtime values.
 */
export async function inspectSemanticPage(opts: SemanticInspectOptions = {}): Promise<SemanticPageState> {
  const w = window as any;
  // A snapshot taken mid-fade reports what the page settles to: an opening dialog or list counts,
  // a closing one does not. Transition frameworks add their `-enter` class a frame before the fade starts.
  // A hidden page advances no animation, and Chrome may delay its timers by up to a minute.
  if (document.visibilityState === 'visible' && typeof document.getAnimations === 'function') {
    const timeout = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    if (document.querySelector('[class*="-enter"],[class*="-appear"]')) {
      await Promise.race([
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        timeout(100),
      ]);
    }
    const fading = document.getAnimations().filter((animation) => {
      const end = Number(animation.effect?.getComputedTiming().endTime);
      if (animation.playState !== 'running' || !Number.isFinite(end)) return false;
      const property = (animation as CSSTransition).transitionProperty;
      return property !== undefined
        ? property === 'opacity'
        : ((animation.effect as KeyframeEffect | null)?.getKeyframes() || []).some((frame) => 'opacity' in frame);
    });
    if (fading.length) {
      await Promise.race([Promise.all(fading.map((animation) => animation.finished.catch(() => undefined))), timeout(400)]);
    }
  }
  if (!w.__chromeShellSemanticSignal) {
    const signal = { revision: 0 };
    const bump = () => {
      signal.revision += 1;
    };
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    document.addEventListener('input', bump, true);
    document.addEventListener('change', bump, true);
    w.__chromeShellSemanticSignal = { signal, observer };
  }
  const mode = opts.mode || 'interactive';
  const query = String(opts.query || '')
    .trim()
    .toLowerCase();
  const limit = Math.max(1, Math.min(Number(opts.limit) || 200, 1000));

  if (!w.__chromeShellElementMap) w.__chromeShellElementMap = {};
  if (!w.__chromeShellRefCounter) w.__chromeShellRefCounter = 0;
  if (!w.__chromeShellElementRefMap) w.__chromeShellElementRefMap = new WeakMap();
  if (!w.__chromeShellSemanticMeta) {
    w.__chromeShellSemanticMeta = { version: 0, signature: '', url: '' };
  }

  const refMap: Record<string, WeakRef<Element>> = w.__chromeShellElementMap;
  const elementRefs: WeakMap<Element, string> = w.__chromeShellElementRefMap;

  const ensureRef = (el: Element): string => {
    const fast = elementRefs.get(el);
    if (fast) {
      const weak = refMap[fast];
      if (weak && weak.deref && weak.deref() === el) return fast;
    }
    for (const key in refMap) {
      const weak = refMap[key];
      if (weak && weak.deref && weak.deref() === el) {
        elementRefs.set(el, key);
        return key;
      }
    }
    const ref = `ref_${++w.__chromeShellRefCounter}`;
    refMap[ref] = new WeakRef(el);
    elementRefs.set(el, ref);
    return ref;
  };

  const resolveRef = (ref: string): Element | null => {
    const weak = refMap[ref];
    const el = weak && weak.deref ? weak.deref() : null;
    // A replaced element may linger detached until it is collected; it is no longer the page's.
    return el instanceof Element && el.isConnected ? el : null;
  };

  const styles = new Map<Element, CSSStyleDeclaration>();
  const styleOf = (el: Element): CSSStyleDeclaration => {
    let style = styles.get(el);
    if (!style) {
      style = getComputedStyle(el);
      styles.set(el, style);
    }
    return style;
  };
  // Zero-width and bidi controls make visually identical names compare unequal.
  const clean = (value: string): string =>
    value.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
  /** The pointer cursor starts here instead of being inherited from a clickable ancestor. */
  const pointerOrigin = (el: Element): boolean => {
    if (styleOf(el).cursor !== 'pointer') return false;
    const parent = el.parentElement;
    return !parent || styleOf(parent).cursor !== 'pointer';
  };
  const scriptedClick = (el: Element): boolean =>
    el.hasAttribute('onclick') ||
    el.matches(
      '[class*="-tabs-tab"],[class*="-menu-item"],[class*="dropdown-menu-item"],[class*="-btn"]:not(div[class*="-btn-group"])',
    ) ||
    pointerOrigin(el);

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    if (el.matches('.el-select-dropdown__item, .el-cascader-node')) return 'option';
    if (el.matches('.el-dropdown-menu__item, .ant-dropdown-menu-item, .ivu-dropdown-item, .arco-dropdown-option')) {
      return 'menuitem';
    }
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a' && (el.hasAttribute('href') || scriptedClick(el))) return 'link';
    if (tag === 'button' || type === 'button' || type === 'submit' || type === 'reset')
      return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'option') return 'option';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'file') return 'button';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'form') return 'form';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'th') return 'columnheader';
    if (tag === 'td') return 'cell';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'img') return 'img';
    return 'generic';
  };

  const NON_TEXT = 'script,style,noscript,template';
  /** Rendered text only: script/style/template payloads are not part of any accessible name. */
  const textOf = (root: Element, exclude?: Element, max = 120): string => {
    if (!exclude && !root.querySelector(NON_TEXT)) {
      return clean((root.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, max);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest(NON_TEXT) || (exclude && exclude.contains(node))
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const parts: string[] = [];
    let length = 0;
    let node: Node | null;
    while ((node = walker.nextNode()) && length <= max * 2) {
      const text = node.textContent || '';
      parts.push(text);
      length += text.length;
    }
    return clean(parts.join(' ').replace(/\s+/g, ' ').trim()).slice(0, max);
  };

  const labelText = (label: Element, control: Element): string => textOf(label, control, 200);

  const byIdText = (id: string | null, control: Element): string => {
    if (!id) return '';
    return id
      .split(/\s+/)
      .map((part) => { const label = document.getElementById(part); return label ? labelText(label, control) : ''; })
      .join(' ')
      .trim();
  };

  const ROW = 'tr,[role="row"]';
  /** Cells joined by spaces: a row's text without separators runs its columns together. */
  const rowText = (row: Element): string =>
    clean(
      Array.from(row.children, (cell) => textOf(cell))
        .filter(Boolean)
        .join(' '),
    ).slice(0, 120);

  const names = new Map<Element, string>();
  const nameOf = (el: Element): string => {
    let name = names.get(el);
    if (name === undefined) names.set(el, (name = computeName(el)));
    return name;
  };
  const computeName = (el: Element): string => {
    const labelled = byIdText(el.getAttribute('aria-labelledby'), el);
    if (labelled) return labelled;
    for (const attr of ['aria-label']) {
      const value = el.getAttribute(attr);
      if (value && value.trim()) return clean(value.trim());
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length) {
      const text = Array.from(labels, (label) => labelText(label, el)).join(' ').trim();
      if (text) return text.slice(0, 120);
    }
    for (const attr of ['placeholder', 'title', 'alt']) {
      const value = el.getAttribute(attr);
      if (value?.trim()) return clean(value.trim());
    }
    // A native select's text is the concatenation of every option; its value is reported separately.
    if (el instanceof HTMLSelectElement) return '';
    if (el.matches(ROW)) return rowText(el);
    if (el.matches(TABLE)) return tableHeaders(el) || textOf(el);
    return textOf(el);
  };

  // Fixed columns (Element UI 2, vxe-table, Ant Design 3) are separate tables laid over the main one,
  // repeating every row; the main table keeps hidden copies of their cells. A control in an overlay
  // belongs to the main row at the same height.
  const FIXED_OVERLAY =
    '.el-table__fixed,.el-table__fixed-right,.vxe-table--fixed-left-wrapper,.vxe-table--fixed-right-wrapper,.ant-table-fixed-left,.ant-table-fixed-right';
  const TABLE_WIDGET = '.el-table,.vxe-table,.ant-table';
  const TABLE = 'table,[role="table"],[role="grid"],[role="treegrid"]';
  const hasOverlays = !!document.querySelector(FIXED_OVERLAY);
  const inOverlay = (el: Element): boolean => hasOverlays && !!el.closest(FIXED_OVERLAY);
  const mainRowsByTop = new Map<Element, Map<number, Element>>();
  const mainRowOf = (row: Element): Element => {
    if (!inOverlay(row)) return row;
    const widget = row.closest(TABLE_WIDGET);
    if (!widget) return row;
    let byTop = mainRowsByTop.get(widget);
    if (!byTop) {
      byTop = new Map();
      for (const main of Array.from(widget.querySelectorAll('tr'))) {
        if (!inOverlay(main)) byTop.set(Math.round(main.getBoundingClientRect().top), main);
      }
      mainRowsByTop.set(widget, byTop);
    }
    const top = Math.round(row.getBoundingClientRect().top);
    return byTop.get(top) || byTop.get(top - 1) || byTop.get(top + 1) || row;
  };
  /** Column headers name a table better than its first rows; an Element UI body table has its header apart. */
  const tableHeaders = (table: Element): string => {
    const own = (table as HTMLTableElement).caption?.textContent?.trim();
    if (own) return clean(own).slice(0, 120);
    const scope = (table as HTMLTableElement).tHead || table.closest(TABLE_WIDGET) || table;
    return clean(
      Array.from(scope.querySelectorAll('th,[role="columnheader"]'))
        .filter((header) => !inOverlay(header))
        .map((header) => textOf(header))
        .filter(Boolean)
        .join(' '),
    ).slice(0, 120);
  };

  const visible = (el: Element): boolean => {
    if (el === document.body || el === document.documentElement) return true;
    if ((el as HTMLElement).hidden || el.closest('[aria-hidden="true"]')) return false;
    const style = styleOf(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
      return false;
    // checkVisibility also covers transparent or content-visibility-hidden ancestors.
    const check = (el as HTMLElement).checkVisibility;
    if (typeof check === 'function' && !check.call(el, { opacityProperty: true, visibilityProperty: true } as any)) {
      return false;
    }
    return (
      typeof (el as HTMLElement).getClientRects !== 'function' || el.getClientRects().length > 0
    );
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

  /** The innermost container; a control in a table belongs to its row, which tells rows apart. */
  const contextOf = (el: Element): string | undefined => {
    let parent = el.parentElement?.closest(
      `[role="dialog"],[role="alertdialog"],dialog,form,[role="form"],${ROW},${TABLE},[role="region"]`,
    );
    if (!parent) return undefined;
    if (parent.matches(ROW)) parent = mainRowOf(parent);
    const role = roleOf(parent);
    const name = nameOf(parent);
    return name ? `${role}:${name.slice(0, 60)}` : role;
  };

  /** A styled checkbox or radio hides its native input and shows its label; the label stands in for it. */
  const proxiedControl = (el: Element): HTMLInputElement | undefined => {
    if (!(el instanceof HTMLLabelElement)) return undefined;
    const control = el.control;
    return control instanceof HTMLInputElement &&
      (control.type === 'checkbox' || control.type === 'radio') &&
      !visible(control) &&
      !el.querySelector('[role="checkbox"],[role="radio"],[role="switch"]')
      ? control
      : undefined;
  };

  const interactiveRoles = new Set([
    'button',
    'link',
    'textbox',
    'combobox',
    'checkbox',
    'radio',
    'slider',
    'spinbutton',
    'menuitem',
    'option',
    'tab',
    'switch',
    'treeitem',
  ]);

  const root = opts.scopeRef ? resolveRef(opts.scopeRef) : document.body;
  if (!root) {
    return {
      version: w.__chromeShellSemanticMeta.version,
      url: location.href,
      title: document.title,
      nodes: [],
      capabilities: [`semantic-error:scope ref "${opts.scopeRef}" not found or expired`],
    };
  }
  /** The dialog the user sees: one matching `query`, else the one on top at its own center. */
  const pickDialog = (): Element | null => {
    const dialogs = Array.from(
      document.querySelectorAll(
        '[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"],.el-dialog__wrapper,.el-message-box__wrapper,.el-drawer__wrapper,.ant-modal-wrap,.next-dialog,.ivu-modal-wrap',
      ),
    ).filter((el) => visible(el));
    const outermost = dialogs.filter((el) => !dialogs.some((other) => other !== el && other.contains(el)));
    if (!outermost.length) return null;
    if (query) {
      const named = outermost.find((el) => textOf(el, undefined, 400).toLowerCase().includes(query));
      if (named) return named;
    }
    if (typeof document.elementFromPoint !== 'function') return outermost.at(-1) || null;
    const onTop = outermost.filter((el) => {
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return Boolean(hit && el.contains(hit));
    });
    return (onTop.length ? onTop : outermost).at(-1) || null;
  };
  const dialogRoot = mode === 'dialog' ? pickDialog() : null;

  interface PageSnapshot {
    el: Element;
    ref: string;
    role: string;
    name: string;
    isInteractive: boolean;
    value?: string;
    states: SemanticNode['states'];
    options?: string[];
    optionsTotal?: number;
  }

  // Build one canonical page snapshot before applying mode/query/limit. Semantic
  // versions must represent page state, not the shape of the caller's view.
  const snapshots: PageSnapshot[] = [];
  const canonical: unknown[] = [];
  const canonicalRoles = new Set([
    'form',
    'table',
    'row',
    'columnheader',
    'cell',
    'dialog',
    'alertdialog',
    'alert',
    'status',
  ]);
  const candidates = [document.body, ...Array.from(document.body.querySelectorAll('*'))];
  const controls = new Map<Element, HTMLInputElement>();
  for (const el of candidates) {
    if (!visible(el)) continue;
    const control = proxiedControl(el);
    if (control) controls.set(el, control);
    const source: Element = control || el;
    const role = roleOf(source);
    // The overlay's own rows and cells repeat the main table's.
    if (role !== 'generic' && canonicalRoles.has(role) && inOverlay(el)) continue;
    const name = nameOf(el);
    const isInteractive =
      interactiveRoles.has(role) ||
      (el as HTMLElement).tabIndex >= 0 ||
      (role === 'generic' && el !== document.body && !!name && scriptedClick(el));
    if (!name && !isInteractive && !canonicalRoles.has(role)) continue;

    const input = source as HTMLInputElement;
    const toggle = source instanceof HTMLInputElement && (input.type === 'checkbox' || input.type === 'radio');
    const value =
      'value' in input && typeof input.value === 'string'
        ? toggle && input.value === 'on'
          ? undefined
          : input.value.slice(0, 200)
        : source.getAttribute('aria-valuetext') || undefined;
    const ariaChecked = source.getAttribute('aria-checked');
    const states = {
      disabled: (input as any).disabled === true || source.getAttribute('aria-disabled') === 'true',
      checked: toggle ? input.checked : ariaChecked === 'true' ? true : ariaChecked === 'false' ? false : undefined,
      selected:
        typeof (input as any).selected === 'boolean'
          ? Boolean((input as any).selected)
          : source.getAttribute('aria-selected') === 'true'
            ? true
            : undefined,
      expanded: source.hasAttribute('aria-expanded')
        ? source.getAttribute('aria-expanded') === 'true'
        : undefined,
      required: (input as any).required === true || source.getAttribute('aria-required') === 'true',
      invalid:
        source.getAttribute('aria-invalid') === 'true' ||
        (typeof (input as any).checkValidity === 'function' && !(input as any).checkValidity()),
      readonly: (input as any).readOnly === true || source.getAttribute('aria-readonly') === 'true',
    };
    const options =
      el instanceof HTMLSelectElement
        ? Array.from(el.options)
            .slice(0, 20)
            .map((o) => (o.value && o.value !== o.text ? `${o.value}:${o.text}` : o.text))
        : undefined;
    const optionsTotal = el instanceof HTMLSelectElement ? el.options.length : undefined;
    const snapshot: PageSnapshot = {
      el,
      ref: ensureRef(el),
      role,
      name,
      isInteractive,
      value,
      states,
      options,
      optionsTotal,
    };
    snapshots.push(snapshot);
    canonical.push([snapshot.ref, role, name, value, states, options, optionsTotal]);
  }

  const signature = JSON.stringify({ url: location.href, nodes: canonical });
  const meta = w.__chromeShellSemanticMeta;
  if (meta.signature !== signature || meta.url !== location.href) {
    meta.version += 1;
    meta.signature = signature;
    meta.url = location.href;
  }

  if (mode === 'dialog' && !dialogRoot) {
    return {
      version: meta.version,
      url: location.href,
      title: document.title,
      nodes: [],
      capabilities: ['native', 'aria'],
    };
  }

  const scanRoot = (dialogRoot || root) as Element;
  // A query that selected the dialog describes the dialog, not each control inside it.
  const nodeQuery =
    dialogRoot && query && textOf(dialogRoot, undefined, 400).toLowerCase().includes(query) ? '' : query;
  const roleFilter = opts.role ? String(opts.role) : '';
  const exactName = opts.name !== undefined ? clean(String(opts.name)).trim() : undefined;
  const nameContains = opts.nameContains ? clean(String(opts.nameContains)).trim().toLowerCase() : '';
  let selectorMatches: Set<Element> | undefined;
  if (opts.selector) {
    try {
      selectorMatches = new Set(Array.from(document.querySelectorAll(String(opts.selector))));
    } catch (error) {
      return {
        version: meta.version,
        url: location.href,
        title: document.title,
        nodes: [],
        capabilities: [`semantic-error:invalid css selector: ${error instanceof Error ? error.message : error}`],
      };
    }
  }
  /** Text-mode blocks: elements carrying their own text, minus inline fragments of an included parent. */
  const textBlocks = new Set<Element>();
  const hasOwnText = (el: Element): boolean =>
    Array.from(el.childNodes).some((child) => child.nodeType === Node.TEXT_NODE && !!child.textContent?.trim());
  const inScope = (el: Element): boolean => {
    if (el === scanRoot || scanRoot.contains(el)) return true;
    const row = inOverlay(el) ? el.closest(ROW) : null;
    return !!row && scanRoot.contains(mainRowOf(row));
  };
  // What each listed ref stood for, kept after its element is gone so a re-rendered target can be found again.
  if (!w.__chromeShellRefInfo) w.__chromeShellRefInfo = new Map();
  const refInfo: Map<string, [string, string, string]> = w.__chromeShellRefInfo;
  const nodes: SemanticNode[] = [];
  for (const snapshot of snapshots) {
    if (nodes.length >= limit) break;
    const { el, ref, role, name, isInteractive, value, states, options, optionsTotal } = snapshot;
    if (!inScope(el)) continue;
    if (roleFilter && role !== roleFilter) continue;
    if (exactName !== undefined && name.trim() !== exactName) continue;
    if (nameContains && !name.toLowerCase().includes(nameContains)) continue;
    if (selectorMatches && !selectorMatches.has(el) && !selectorMatches.has(controls.get(el)!)) continue;
    let textBlock = false;
    if (mode === 'text' && !roleFilter) {
      textBlock =
        !!name &&
        hasOwnText(el) &&
        !(
          el.parentElement &&
          textBlocks.has(el.parentElement) &&
          (/^(A|ABBR|B|CODE|EM|FONT|I|LABEL|MARK|S|SMALL|SPAN|STRONG|SUB|SUP|TIME|U)$/.test(el.tagName) ||
            styleOf(el).display.startsWith('inline'))
        );
      if (textBlock) textBlocks.add(el);
    }
    // An explicit role or selector filter selects nodes regardless of the view's default kinds.
    const include =
      roleFilter || selectorMatches
        ? true
        : mode === 'full'
          ? !!name || isInteractive
          : mode === 'text'
            ? textBlock || (isInteractive && !!name)
            : mode === 'forms'
              ? isInteractive || role === 'form'
              : mode === 'tables'
                ? ['table', 'row', 'columnheader', 'cell'].includes(role) || isInteractive
                : mode === 'dialog'
                  ? isInteractive || ['dialog', 'alertdialog', 'alert', 'status'].includes(role)
                  : isInteractive;
    if (!include) continue;

    const locatorHints: SemanticLocatorHint[] = [];
    if ((el as HTMLElement).id) locatorHints.push({ kind: 'id', value: (el as HTMLElement).id });
    const testId = el.getAttribute('data-testid');
    if (testId) locatorHints.push({ kind: 'testid', value: testId });
    if (role !== 'generic' && name)
      locatorHints.push({ kind: 'aria', value: `${role}:${name}`, role, name });
    locatorHints.push({ kind: 'css', value: cssPath(el) });

    const node: SemanticNode = {
      ref,
      role,
      kind: el.tagName.toLowerCase(),
      // Reading views get whole text blocks; the canonical (versioned) name stays short.
      name: (textBlock ? textOf(el, undefined, 1000) : name) || undefined,
      value,
      context: contextOf(el),
      states,
      options,
      optionsTotal,
      source: el.hasAttribute('role') ? 'aria' : 'native',
      locatorHints,
    };
    const context = ['row', 'cell', 'columnheader'].includes(node.role) ? '' : node.context || '';
    const haystack = `${node.role} ${node.name || ''} ${node.value || ''} ${context}`.toLowerCase();
    if (nodeQuery && !haystack.includes(nodeQuery)) continue;
    nodes.push(node);
    refInfo.delete(ref);
    refInfo.set(ref, [role, name, node.context || '']);
    if (refInfo.size > 2000) refInfo.delete(refInfo.keys().next().value!);
  }

  for (const key in refMap) {
    if (!refMap[key]?.deref?.()) delete refMap[key];
  }

  return {
    version: meta.version,
    url: location.href,
    title: document.title,
    nodes,
    capabilities: ['native', 'aria'],
  };
}

const comparableNode = (node: SemanticNode): string =>
  JSON.stringify({
    role: node.role,
    kind: node.kind,
    name: node.name,
    value: node.value,
    description: node.description,
    context: node.context,
    states: node.states,
    options: node.options,
    optionsTotal: node.optionsTotal,
    source: node.source,
  });

export function diffSemanticStates(
  before: SemanticPageState,
  after: SemanticPageState,
): SemanticPageDelta {
  if (before.version === after.version && before.url === after.url) {
    return {
      fromVersion: before.version,
      toVersion: after.version,
      added: [],
      updated: [],
      removed: [],
      events: [],
      api: [],
    };
  }
  const keyOf = (node: SemanticNode) => `${node.frameId ?? 0}:${node.ref}`;
  const oldByRef = new Map(before.nodes.map((node) => [keyOf(node), node]));
  const newByRef = new Map(after.nodes.map((node) => [keyOf(node), node]));
  const added: SemanticNode[] = [];
  const updated: SemanticNode[] = [];
  const removed: string[] = [];

  for (const node of after.nodes) {
    const previous = oldByRef.get(keyOf(node));
    if (!previous) added.push(node);
    else if (comparableNode(previous) !== comparableNode(node)) updated.push(node);
  }
  for (const node of before.nodes) {
    if (!newByRef.has(keyOf(node))) {
      removed.push(node.frameId ? `frame_${node.frameId}:${node.ref}` : node.ref);
    }
  }

  return {
    fromVersion: before.version,
    toVersion: after.version,
    added,
    updated,
    removed,
    events: [],
    api: [],
  };
}

/** States whose false value is the unremarkable default; a listing names them only when true. */
const DEFAULT_FALSE = new Set(['disabled', 'selected', 'required', 'invalid']);

/** `full` keeps default values: an updated node must show a state that went back to its default. */
const flags = (node: SemanticNode, full: boolean): string => {
  const parts: string[] = [];
  const state = node.states || {};
  for (const key of ['disabled', 'checked', 'selected', 'expanded', 'required', 'invalid'] as const) {
    if (state[key] === undefined || (!full && state[key] === false && DEFAULT_FALSE.has(key))) continue;
    parts.push(`${key}=${state[key]}`);
  }
  if (node.value !== undefined && (full || node.value !== '')) parts.push(`value=${JSON.stringify(node.value)}`);
  if (node.options?.length) {
    const more =
      (node.optionsTotal || 0) > node.options.length
        ? `,+${(node.optionsTotal || 0) - node.options.length}`
        : '';
    parts.push(`options=[${node.options.join('|')}${more}]`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
};

export function renderSemanticNode(node: SemanticNode, prefix = '-', full = false): string {
  const name = node.name ? ` ${JSON.stringify(node.name)}` : '';
  // Table parts all share the table context; repeating it per cell only adds noise.
  const context =
    node.context && !['row', 'cell', 'columnheader', 'rowheader', 'gridcell'].includes(node.role)
      ? ` in=${JSON.stringify(node.context)}`
      : '';
  const frame = node.frameId ? ` frame=${node.frameId}` : '';
  return `${prefix} ${node.ref}${frame} ${node.role}${name}${flags(node, full)}${context}`;
}

export function renderSemanticState(state: SemanticPageState): string {
  const lines = [`state=v${state.version} page=${JSON.stringify(state.title)} url=${state.url}`];
  for (const node of state.nodes) lines.push(renderSemanticNode(node));
  if (!state.nodes.length) lines.push('nodes: none');
  return lines.join('\n');
}

export function renderSemanticDelta(delta: SemanticPageDelta): string {
  const lines = [`delta v${delta.fromVersion}->v${delta.toVersion}`];
  for (const node of delta.added) lines.push(renderSemanticNode(node, '+'));
  for (const node of delta.updated) lines.push(renderSemanticNode(node, '~', true));
  // Removed refs carry no names; past a handful they are only a count.
  if (delta.removed.length > 8) lines.push(`- ${delta.removed.length} nodes removed`);
  else for (const ref of delta.removed) lines.push(`- ${ref}`);
  for (const event of delta.events) lines.push(`event ${event.kind}: ${event.message}`);
  for (const call of delta.api) {
    const outcome = call.failed || call.status || 'pending';
    lines.push(
      `net ${call.method} ${call.url} ${outcome}${call.durationMs != null ? ` ${call.durationMs}ms` : ''}`,
    );
  }
  if (lines.length === 1) lines.push('no semantic changes');
  return lines.join('\n');
}
