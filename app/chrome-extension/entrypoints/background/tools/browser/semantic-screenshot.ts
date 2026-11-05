/**
 * Screenshots for chrome-shell through CDP Page.captureScreenshot.
 *
 * The image is returned as data to the CLI, which writes the file itself: no chrome.downloads call,
 * so neither a "download multiple files" permission prompt nor a Save-As dialog can block it.
 * Capture targets the requested tab directly; only when the renderer of a background tab does not
 * produce a frame in time is the tab activated briefly and the previous tab restored.
 */
import { cdpSessionManager } from '@/utils/cdp-session-manager';

export interface SemanticScreenshotRequest {
  tabId: number;
  ref?: string;
  frameId?: number;
  full?: boolean;
  timeoutMs: number;
}

export interface SemanticScreenshot {
  data: string;
  mimeType: 'image/png';
  width: number;
  height: number;
  /** The background tab had to be brought to the front for rendering. */
  activated: boolean;
  /** A full-page capture was cut at MAX_CAPTURE_HEIGHT. */
  clipped: boolean;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MAX_CAPTURE_HEIGHT = 16_384;
const RENDER_WAIT_MS = 5_000;

/** Page side: scroll the ref into view, mark it, and return its viewport rect. */
export function markScreenshotTarget(ref: string, token: string): { ok: boolean; rect?: Rect; error?: string } {
  const el = (window as any).__chromeShellElementMap?.[ref]?.deref?.();
  if (!(el instanceof Element)) return { ok: false, error: `STALE_REF: ${ref} is no longer live; inspect again` };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.setAttribute('data-chrome-shell-shot', token);
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { ok: false, error: `${ref} has no visible box to capture` };
  return { ok: true, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } };
}

/** Page side (parent frame): offset of the same-origin iframe that holds the marked node, which is then marked too. */
export function locateMarkedFrame(token: string): { ok: boolean; offset?: { x: number; y: number }; error?: string } {
  const selector = `[data-chrome-shell-shot="${token}"]`;
  for (const frame of Array.from(document.querySelectorAll('iframe,frame'))) {
    let inner: Document | null = null;
    try {
      inner = (frame as HTMLIFrameElement).contentDocument;
    } catch {
      inner = null;
    }
    if (!inner?.querySelector(selector)) continue;
    const rect = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    frame.setAttribute('data-chrome-shell-shot', token);
    return {
      ok: true,
      offset: {
        x: rect.left + (frame as HTMLElement).clientLeft + parseFloat(style.paddingLeft || '0'),
        y: rect.top + (frame as HTMLElement).clientTop + parseFloat(style.paddingTop || '0'),
      },
    };
  }
  return { ok: false, error: 'the element is inside a cross-origin frame; capture the viewport or open the frame URL' };
}

export function clearScreenshotMarks(token: string): void {
  document.querySelectorAll(`[data-chrome-shell-shot="${token}"]`).forEach((el) => el.removeAttribute('data-chrome-shell-shot'));
}

async function inFrame<T>(tabId: number, frameId: number, func: (...args: any[]) => T, args: unknown[]): Promise<T> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'ISOLATED',
    func: func as any,
    args: args as any,
  });
  if (!result) throw new Error(`frame ${frameId} is not scriptable`);
  return result.result as T;
}

/** Rect of a ref in top-frame viewport coordinates, walking same-origin frame owners upward. */
async function locateRef(tabId: number, ref: string, frameId: number, token: string): Promise<Rect> {
  const marked = await inFrame(tabId, frameId, markScreenshotTarget, [ref, token]);
  if (!marked.ok || !marked.rect) throw new Error(marked.error || `cannot locate ${ref}`);
  const rect = { ...marked.rect };
  if (!frameId) return rect;
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  let current = frameId;
  while (current !== 0) {
    const parent = frames.find((frame) => frame.frameId === current)?.parentFrameId;
    if (parent === undefined || parent < 0) throw new Error(`frame ${current} has no parent frame`);
    const located = await inFrame(tabId, parent, locateMarkedFrame, [token]);
    if (!located.ok || !located.offset) throw new Error(located.error || 'cannot locate the owning frame');
    rect.x += located.offset.x;
    rect.y += located.offset.y;
    current = parent;
  }
  return rect;
}

async function clearMarks(tabId: number, token: string): Promise<void> {
  await chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, world: 'ISOLATED', func: clearScreenshotMarks, args: [token] })
    .catch(() => undefined);
}

function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function captureOnce(
  tabId: number,
  request: SemanticScreenshotRequest,
  elementRect: Rect | undefined,
): Promise<Omit<SemanticScreenshot, 'activated'>> {
  return cdpSessionManager.withSession(tabId, 'semantic-screenshot', async () => {
    const send = <T = any>(method: string, params?: object) => cdpSessionManager.sendCommand<T>(tabId, method, params);
    const metrics: any = await send('Page.getLayoutMetrics');
    const viewport = metrics?.cssLayoutViewport || metrics?.layoutViewport || { pageX: 0, pageY: 0, clientWidth: 0, clientHeight: 0 };
    let clip: (Rect & { scale: number }) | undefined;
    let clipped = false;
    if (elementRect) {
      clip = { x: elementRect.x + viewport.pageX, y: elementRect.y + viewport.pageY, width: elementRect.width, height: elementRect.height, scale: 1 };
    } else if (request.full) {
      const size = metrics?.cssContentSize || metrics?.contentSize;
      if (!size?.width || !size?.height) throw new Error('page reported no content size');
      clipped = size.height > MAX_CAPTURE_HEIGHT;
      clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(Math.ceil(size.height), MAX_CAPTURE_HEIGHT), scale: 1 };
    } else if (viewport.clientWidth && viewport.clientHeight) {
      // An explicit viewport clip with captureBeyondViewport makes Chrome render a fresh frame, so an
      // occluded or not-yet-painted window still yields an image instead of waiting for vsync.
      clip = { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight, scale: 1 };
    }
    const shot: any = await send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      ...(clip ? { clip, captureBeyondViewport: true } : {}),
    });
    if (typeof shot?.data !== 'string' || !shot.data) throw new Error('Page.captureScreenshot returned no image');
    return {
      data: shot.data,
      mimeType: 'image/png',
      width: Math.round(clip?.width ?? viewport.clientWidth),
      height: Math.round(clip?.height ?? viewport.clientHeight),
      clipped,
    };
  });
}

export async function captureSemanticScreenshot(request: SemanticScreenshotRequest): Promise<SemanticScreenshot> {
  const { tabId } = request;
  const token = `shot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const rect = request.ref ? await locateRef(tabId, request.ref, request.frameId ?? 0, token) : undefined;
    const budget = Math.max(1000, Math.min(RENDER_WAIT_MS, request.timeoutMs - 500));
    try {
      return { ...(await withDeadline(captureOnce(tabId, request, rect), budget, 'render timeout')), activated: false };
    } catch (error) {
      const tab = await chrome.tabs.get(tabId);
      const message = error instanceof Error ? error.message : String(error);
      if (tab.active || !/render timeout/.test(message)) throw error;
      // A background renderer may not produce frames; activate it just for the capture.
      const [previous] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      await chrome.tabs.update(tabId, { active: true });
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const retryRect = request.ref ? await locateRef(tabId, request.ref, request.frameId ?? 0, token) : undefined;
        const remaining = Math.max(1000, request.timeoutMs - budget - 500);
        return { ...(await withDeadline(captureOnce(tabId, request, retryRect), remaining, 'render timeout')), activated: true };
      } finally {
        if (previous?.id && previous.id !== tabId) await chrome.tabs.update(previous.id, { active: true }).catch(() => undefined);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/render timeout|readback|Unable to capture/i.test(message)) {
      throw new Error(
        `Chrome did not render tab ${tabId} (the screen may be locked or the window minimized); unlock or restore the window and retry`,
      );
    }
    throw error;
  } finally {
    await clearMarks(tabId, token);
  }
}
