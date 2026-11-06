import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type FillResult = { success?: boolean; error?: string; message?: string };
type Listener = (request: object, sender: object, respond: (result: FillResult) => void) => boolean;

let listener: Listener;

const fill = (element: Element, value: string) =>
  new Promise<FillResult>((resolve) => {
    element.id = 'target';
    listener({ action: 'fillElement', selector: '#target', value }, {}, resolve);
  });

/** Mimics React: the instance `checked` setter feeds a value tracker and onChange only fires
 *  from a click whose DOM state differs from the tracked one. The model stays the source of truth. */
function reactCheckbox(initial = false) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!;
  native.set!.call(input, initial);
  const state = { model: initial, tracked: initial };
  Object.defineProperty(input, 'checked', {
    configurable: true,
    get: () => native.get!.call(input),
    set: (value: boolean) => {
      state.tracked = Boolean(value);
      native.set!.call(input, value);
    },
  });
  input.addEventListener('click', () => {
    const now = native.get!.call(input) as boolean;
    if (now !== state.tracked) state.model = state.tracked = now;
  });
  document.body.append(input);
  return { input, state };
}

describe('fill-helper toggles', () => {
  beforeAll(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      top: 0,
      right: 10,
      bottom: 10,
      left: 0,
      toJSON: () => ({}),
    });
    const add = vi.mocked(chrome.runtime.onMessage.addListener);
    (0, eval)(readFileSync(resolve('inject-scripts/fill-helper.js'), 'utf8'));
    listener = add.mock.calls.at(-1)![0] as Listener;
  });

  beforeEach(() => document.body.replaceChildren());

  it('checks a React-controlled checkbox through its own click so the model follows', async () => {
    const { input, state } = reactCheckbox();
    expect(await fill(input, 'true')).toMatchObject({ success: true });
    expect(state.model).toBe(true);
    expect(input.checked).toBe(true);

    expect(await fill(input, 'false')).toMatchObject({ success: true });
    expect(state.model).toBe(false);
  });

  it('leaves an already matching checkbox alone', async () => {
    const { input } = reactCheckbox(true);
    const clicks = vi.fn();
    input.addEventListener('click', clicks);
    expect(await fill(input, 'on')).toMatchObject({ success: true, message: 'Already checked' });
    expect(clicks).not.toHaveBeenCalled();
  });

  it('fails when the page rejects the change', async () => {
    const { input } = reactCheckbox();
    input.addEventListener('click', (event) => event.preventDefault());
    const result = await fill(input, 'true');
    expect(result.error).toMatch(/rejected the change to true/);
    expect(input.checked).toBe(false);
  });

  it('toggles an ARIA switch by clicking it', async () => {
    const toggle = document.createElement('div');
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', 'false');
    toggle.addEventListener('click', () =>
      queueMicrotask(() =>
        toggle.setAttribute('aria-checked', String(toggle.getAttribute('aria-checked') !== 'true')),
      ),
    );
    document.body.append(toggle);
    expect(await fill(toggle, 'true')).toMatchObject({ success: true });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('rejects a non-boolean value', async () => {
    const { input } = reactCheckbox();
    expect((await fill(input, 'maybe')).error).toMatch(/boolean/);
  });
});
