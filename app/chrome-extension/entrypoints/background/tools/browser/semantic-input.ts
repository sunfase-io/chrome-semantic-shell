/**
 * Trusted keyboard input through CDP Input.* for chrome-shell `type` and `key`.
 * Page-dispatched KeyboardEvents are untrusted: they neither insert text nor trigger default actions.
 */
import { cdpSessionManager } from '@/utils/cdp-session-manager';

interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<string, KeyDefinition> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
};

const MODIFIERS: Record<string, { bit: number; key: string; code: string; keyCode: number }> = {
  alt: { bit: 1, key: 'Alt', code: 'AltLeft', keyCode: 18 },
  ctrl: { bit: 2, key: 'Control', code: 'ControlLeft', keyCode: 17 },
  control: { bit: 2, key: 'Control', code: 'ControlLeft', keyCode: 17 },
  meta: { bit: 4, key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  cmd: { bit: 4, key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  shift: { bit: 8, key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
};

export interface KeyChord {
  modifiers: Array<(typeof MODIFIERS)[string]>;
  key: KeyDefinition;
}

function keyFor(name: string, shifted: boolean): KeyDefinition {
  const named = NAMED_KEYS[name.toLowerCase()];
  if (named) return named;
  const fn = /^f([1-9]|1[0-2])$/i.exec(name);
  if (fn) return { key: `F${fn[1]}`, code: `F${fn[1]}`, keyCode: 111 + Number(fn[1]) };
  if ([...name].length !== 1) throw new Error(`unknown key "${name}"`);
  // Letter keys name the physical key ("Ctrl+S"); the produced character follows Shift. Use `type` for text.
  const char = shifted ? name.toUpperCase() : name.toLowerCase();
  const upper = name.toUpperCase();
  const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(name) ? `Digit${name}` : '';
  const keyCode = /[A-Z0-9]/.test(upper) ? upper.charCodeAt(0) : 0;
  return { key: char, code, keyCode, text: char };
}

/** "Ctrl+Shift+K Enter a" → chords; spaces separate presses, "+" joins modifiers. */
export function parseKeySequence(spec: string): KeyChord[] {
  const chords = spec.trim().split(/\s+/).filter(Boolean);
  if (!chords.length) throw new Error('key expects at least one key');
  return chords.map((chord) => {
    const parts = chord === '+' ? ['+'] : chord.split('+').filter(Boolean);
    const keyName = parts.pop()!;
    const modifiers = parts.map((part) => {
      const modifier = MODIFIERS[part.toLowerCase()];
      if (!modifier) throw new Error(`unknown modifier "${part}" in "${chord}"`);
      return modifier;
    });
    return { modifiers, key: keyFor(keyName, modifiers.some((modifier) => modifier.key === 'Shift')) };
  });
}

/**
 * A tab in an unfocused or occluded window drops key events at the renderer; focus emulation makes
 * the page behave as focused for the duration of the input, as headless automation does.
 */
async function withFocusedInput<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  return cdpSessionManager.withSession(tabId, 'semantic-input', async () => {
    await cdpSessionManager.sendCommand(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    try {
      return await fn();
    } finally {
      await cdpSessionManager.sendCommand(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
    }
  });
}

export async function pressKeys(tabId: number, spec: string): Promise<void> {
  const chords = parseKeySequence(spec);
  await withFocusedInput(tabId, async () => {
    const send = (params: object) => cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', params);
    for (const chord of chords) {
      let mask = 0;
      for (const modifier of chord.modifiers) {
        mask |= modifier.bit;
        await send({ type: 'rawKeyDown', key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, modifiers: mask });
      }
      // With Ctrl/Alt/Meta held the key is a shortcut and must not insert its character.
      const insertsText = Boolean(chord.key.text) && !(mask & (1 | 2 | 4));
      const base = { key: chord.key.key, code: chord.key.code, windowsVirtualKeyCode: chord.key.keyCode, modifiers: mask };
      await send({ ...base, type: insertsText ? 'keyDown' : 'rawKeyDown', ...(insertsText ? { text: chord.key.text, unmodifiedText: chord.key.text } : {}) });
      await send({ ...base, type: 'keyUp' });
      for (const modifier of [...chord.modifiers].reverse()) {
        mask &= ~modifier.bit;
        await send({ type: 'keyUp', key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, modifiers: mask });
      }
    }
  });
}

export async function insertText(tabId: number, text: string): Promise<void> {
  await withFocusedInput(tabId, () => cdpSessionManager.sendCommand(tabId, 'Input.insertText', { text }));
}

/** Page side: focus a ref, placing the caret at the end of editable content. */
export function focusRefInPage(ref: string, selectAll: boolean): { ok: boolean; error?: string } {
  const el = (window as any).__chromeShellElementMap?.[ref]?.deref?.();
  if (!(el instanceof HTMLElement)) return { ok: false, error: `STALE_REF: ${ref} is no longer live; inspect again` };
  el.focus();
  if (document.activeElement !== el && !el.contains(document.activeElement)) {
    return { ok: false, error: `${ref} cannot take keyboard focus` };
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (selectAll) el.select();
    else el.setSelectionRange?.(el.value.length, el.value.length);
  } else if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    if (!selectAll) range.collapse(false);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  return { ok: true };
}
