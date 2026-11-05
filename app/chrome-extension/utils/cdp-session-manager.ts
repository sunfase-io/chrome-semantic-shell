import { TOOL_NAMES } from 'chrome-semantic-shell-shared';

type OwnerTag = string;

interface TabSessionState {
  refCount: number;
  owners: Map<OwnerTag, number>;
  attachedByUs: boolean;
}

const DEBUGGER_PROTOCOL_VERSION = '1.3';

export class CDPSessionManager {
  private sessions = new Map<number, TabSessionState>();
  private transitions = new Map<number, Promise<void>>();

  private async transition<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.transitions.get(tabId) || Promise.resolve();
    const work = previous.then(operation);
    const tail = work.then(() => undefined, () => undefined);
    this.transitions.set(tabId, tail);
    try { return await work; }
    finally { if (this.transitions.get(tabId) === tail) this.transitions.delete(tabId); }
  }

  private getState(tabId: number): TabSessionState | undefined {
    return this.sessions.get(tabId);
  }

  private setState(tabId: number, state: TabSessionState) {
    this.sessions.set(tabId, state);
  }

  async attach(tabId: number, owner: OwnerTag = 'unknown'): Promise<void> {
    return this.transition(tabId, () => this.attachUnlocked(tabId, owner));
  }

  private async attachUnlocked(tabId: number, owner: OwnerTag): Promise<void> {
    const state = this.getState(tabId);
    if (state && state.attachedByUs) {
      state.refCount += 1;
      state.owners.set(owner, (state.owners.get(owner) || 0) + 1);
      return;
    }

    // Chrome allows several debugger clients, so an open DevTools window does not block attaching.
    // A refused attach is either another extension's session or our own session left over from a
    // service-worker restart; only the latter can be detached by this extension.
    try {
      await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already attached/i.test(message)) throw error;
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        throw new Error(
          `Debugger is already attached to tab ${tabId} by another client (e.g., another extension)`,
        );
      }
      await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
    }
    this.setState(tabId, { refCount: 1, owners: new Map([[owner, 1]]), attachedByUs: true });
  }

  async detach(tabId: number, owner: OwnerTag = 'unknown'): Promise<void> {
    return this.transition(tabId, () => this.detachUnlocked(tabId, owner));
  }

  private async detachUnlocked(tabId: number, owner: OwnerTag): Promise<void> {
    const state = this.getState(tabId);
    if (!state) return; // Nothing to do

    // Update ownership/refcount
    const owned = state.owners.get(owner) || 0;
    if (!owned) return;
    if (owned === 1) state.owners.delete(owner);
    else state.owners.set(owner, owned - 1);
    state.refCount = Math.max(0, state.refCount - 1);

    if (state.refCount > 0) {
      // Still in use by other owners
      return;
    }

    // We are the last owner
    try {
      if (state.attachedByUs) {
        await chrome.debugger.detach({ tabId });
      }
    } catch (e) {
      // Best-effort detach; ignore
    } finally {
      this.sessions.delete(tabId);
    }
  }

  /**
   * Convenience wrapper: ensures attach before fn, and balanced detach after.
   */
  async withSession<T>(tabId: number, owner: OwnerTag, fn: () => Promise<T>): Promise<T> {
    await this.attach(tabId, owner);
    try {
      return await fn();
    } finally {
      await this.detach(tabId, owner);
    }
  }

  /**
   * Send a CDP command. Requires that this manager has attached to the tab.
   * If not attached by us, will attempt a one-shot attach around the call.
   */
  async sendCommand<T = any>(tabId: number, method: string, params?: object): Promise<T> {
    const state = this.getState(tabId);
    if (state && state.attachedByUs) {
      return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
    }
    // Fallback: temporary session
    return await this.withSession<T>(tabId, `send:${method}`, async () => {
      return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
    });
  }
}

export const cdpSessionManager = new CDPSessionManager();
