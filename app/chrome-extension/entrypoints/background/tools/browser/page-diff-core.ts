/**
 * chrome_page_diff core logic — zero imports by design (same pattern as form-model-core).
 *
 * `beginPageDiff` / `collectPageDiff` are serialized via `Function.prototype.toString`
 * and executed in the page ISOLATED world by `chrome.scripting.executeScript`, so each
 * body MUST be fully self-contained. Isolated-world state persists between the two
 * calls on `window.__chromeShellPageDiff` and is wiped by navigation — collect reports
 * `expired: true` then, and the background service still derives the URL change.
 *
 * `formatChanges` runs in the extension background.
 */

export interface PageDiffResult {
  expired?: boolean;
  errorsAdded?: string[];
  errorsRemoved?: string[];
  dialogsOpened?: string[];
  dialogsClosed?: string[];
  toasts?: string[];
  newText?: string[];
  elapsedMs?: number;
}

/** Installs baseline snapshot + MutationObserver in the page (ISOLATED world). */
export function beginPageDiff(): { ok: boolean } {
  const snapErrors = (): string[] => {
    const out: string[] = [];
    document.querySelectorAll('.el-form-item__error, [data-validation-error]').forEach((e) => {
      const t = (e.textContent || '').trim();
      if (!t) return;
      const item = e.closest('.el-form-item');
      const lbl = item && item.querySelector('.el-form-item__label');
      const label = lbl ? (lbl.textContent || '').trim().replace(/[::]\s*$/, '') : '';
      out.push(label ? label + ': ' + t : t);
    });
    document.querySelectorAll('[aria-invalid="true"]').forEach((e: any) => {
      const ids =
        `${e.getAttribute('aria-errormessage') || ''} ${e.getAttribute('aria-describedby') || ''}`
          .trim()
          .split(/\s+/)
          .filter(Boolean);
      const message =
        ids
          .map((id) => document.getElementById(id)?.textContent?.trim() || '')
          .filter(Boolean)
          .join(' ') ||
        e.validationMessage ||
        '';
      if (!message) return;
      const label =
        e.getAttribute('aria-label') ||
        (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.textContent?.trim()) ||
        '';
      out.push(label ? `${label}: ${message}` : message);
    });
    return out;
  };
  const snapDialogs = (): string[] => {
    const out: string[] = [];
    document
      .querySelectorAll(
        '.el-dialog__wrapper, .el-message-box__wrapper, [role="dialog"], [role="alertdialog"], dialog[open]',
      )
      .forEach((w: any) => {
        if (w.style && w.style.display === 'none') return;
        if (w.hidden || w.getAttribute?.('aria-hidden') === 'true') return;
        const t = w.querySelector(
          '.el-dialog__title, .el-message-box__title, [role="heading"], h1, h2, h3',
        );
        const aria = w.getAttribute?.('aria-label') || '';
        out.push((aria || (t && t.textContent) || 'dialog').trim() || 'dialog');
      });
    return out;
  };

  const w = window as any;
  if (w.__chromeShellPageDiff && w.__chromeShellPageDiff.observer)
    w.__chromeShellPageDiff.observer.disconnect();

  const st: any = {
    ts: Date.now(),
    errors: snapErrors(),
    dialogs: snapDialogs(),
    toasts: [] as string[],
    newText: [] as string[],
    textLen: 0,
  };
  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n: any) => {
        if (!n || n.nodeType !== 1) return;
        const toastSelector =
          '.el-message, .el-notification, [role="status"], [data-toast], [aria-live="polite"], [aria-live="assertive"]';
        const toast = n.matches?.(toastSelector) ? n : n.querySelector?.(toastSelector);
        if (toast) {
          const txt = (toast.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
          if (txt && st.toasts.length < 10 && st.toasts.indexOf(txt) === -1) st.toasts.push(txt);
          return;
        }
        if (st.textLen < 500) {
          const txt = (n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
          if (txt && st.newText.indexOf(txt) === -1) {
            st.newText.push(txt);
            st.textLen += txt.length;
          }
        }
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  st.observer = observer;
  w.__chromeShellPageDiff = st;
  return { ok: true };
}

/** Computes the delta against the baseline and tears the observer down. */
export function collectPageDiff(): PageDiffResult {
  const snapErrors = (): string[] => {
    const out: string[] = [];
    document.querySelectorAll('.el-form-item__error, [data-validation-error]').forEach((e) => {
      const t = (e.textContent || '').trim();
      if (!t) return;
      const item = e.closest('.el-form-item');
      const lbl = item && item.querySelector('.el-form-item__label');
      const label = lbl ? (lbl.textContent || '').trim().replace(/[::]\s*$/, '') : '';
      out.push(label ? label + ': ' + t : t);
    });
    document.querySelectorAll('[aria-invalid="true"]').forEach((e: any) => {
      const ids =
        `${e.getAttribute('aria-errormessage') || ''} ${e.getAttribute('aria-describedby') || ''}`
          .trim()
          .split(/\s+/)
          .filter(Boolean);
      const message =
        ids
          .map((id) => document.getElementById(id)?.textContent?.trim() || '')
          .filter(Boolean)
          .join(' ') ||
        e.validationMessage ||
        '';
      if (!message) return;
      const label =
        e.getAttribute('aria-label') ||
        (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.textContent?.trim()) ||
        '';
      out.push(label ? `${label}: ${message}` : message);
    });
    return out;
  };
  const snapDialogs = (): string[] => {
    const out: string[] = [];
    document
      .querySelectorAll(
        '.el-dialog__wrapper, .el-message-box__wrapper, [role="dialog"], [role="alertdialog"], dialog[open]',
      )
      .forEach((w: any) => {
        if (w.style && w.style.display === 'none') return;
        if (w.hidden || w.getAttribute?.('aria-hidden') === 'true') return;
        const t = w.querySelector(
          '.el-dialog__title, .el-message-box__title, [role="heading"], h1, h2, h3',
        );
        const aria = w.getAttribute?.('aria-label') || '';
        out.push((aria || (t && t.textContent) || 'dialog').trim() || 'dialog');
      });
    return out;
  };
  const diff = (before: string[], after: string[]): string[] =>
    after.filter((x) => before.indexOf(x) === -1);

  const w = window as any;
  const st = w.__chromeShellPageDiff;
  if (!st) return { expired: true };
  if (st.observer) st.observer.disconnect();
  delete w.__chromeShellPageDiff;

  const errorsNow = snapErrors();
  const dialogsNow = snapDialogs();
  // Toast/dialog texts already captured elsewhere are noise in the generic text delta.
  const newText = (st.newText as string[]).filter(
    (t) =>
      st.toasts.indexOf(t) === -1 &&
      errorsNow.indexOf(t) === -1 &&
      diff(st.dialogs, dialogsNow).every((d) => t.indexOf(d) !== 0),
  );
  return {
    errorsAdded: diff(st.errors, errorsNow),
    errorsRemoved: diff(errorsNow, st.errors),
    dialogsOpened: diff(st.dialogs, dialogsNow),
    dialogsClosed: diff(dialogsNow, st.dialogs),
    toasts: st.toasts,
    newText: newText.slice(0, 5),
    elapsedMs: Date.now() - st.ts,
  };
}

export interface ChangesContext {
  urlBefore?: string;
  urlAfter?: string;
  consoleErrors?: string[];
  /** Pre-rendered API activity segment (method/url/status), empty when none. */
  apiCalls?: string;
  settleMs?: number;
}

/** Collapse exact repeats: [a, a, a, b] → ["a ×3", "b"]. */
const collapse = (list: string[]): string[] => {
  const counts = new Map<string, number>();
  for (const t of list) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()].map(([t, c]) => (c > 1 ? `${t} ×${c}` : t));
};

/** Background-side: delta + context → one compact line block for the LLM. */
export function formatChanges(d: PageDiffResult, ctx: ChangesContext = {}): string {
  const parts: string[] = [];
  const urlChanged = ctx.urlBefore && ctx.urlAfter && ctx.urlBefore !== ctx.urlAfter;
  if (urlChanged) parts.push(`url: ${ctx.urlBefore} -> ${ctx.urlAfter}`);
  if (d.expired) {
    parts.push('page navigated/reloaded (observation context reset)');
    // API calls survive the page teardown — they often explain the navigation.
    if (ctx.apiCalls) parts.push(ctx.apiCalls);
    return 'changes: ' + parts.join(' | ');
  }
  if (d.errorsAdded?.length) parts.push('errors added: ' + collapse(d.errorsAdded).join('; '));
  if (d.errorsRemoved?.length)
    parts.push('errors cleared: ' + collapse(d.errorsRemoved).join('; '));
  if (d.dialogsOpened?.length) parts.push('dialogs opened: ' + d.dialogsOpened.join('; '));
  if (d.dialogsClosed?.length) parts.push('dialogs closed: ' + d.dialogsClosed.join('; '));
  if (d.toasts?.length) parts.push('toasts: ' + collapse(d.toasts).join('; '));
  if (ctx.apiCalls) parts.push(ctx.apiCalls);
  if (ctx.consoleErrors?.length) parts.push('console errors: ' + ctx.consoleErrors.join('; '));
  if (d.newText?.length) parts.push('new text: ' + d.newText.join(' / '));
  if (!parts.length) return `changes: none detected (settled ${ctx.settleMs ?? 300}ms)`;
  return 'changes: ' + parts.join(' | ');
}
