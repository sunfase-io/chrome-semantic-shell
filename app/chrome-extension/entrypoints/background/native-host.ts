import { NATIVE_HOST } from '@/common/constants';
import { chromeShellTool } from './tools/browser/semantic-shell';
import { acquireKeepalive } from './keepalive-manager';
import { NativeMessageType } from 'chrome-semantic-shell-shared';

const EXECUTOR_NAME = 'chrome_shell_exec';
const RECONNECT_DELAY_MS = 2_000;

let nativePort: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let keepaliveRelease: (() => void) | undefined;

function respond(
  requestId: string,
  payload: { status: 'success'; data: unknown } | { status: 'error'; error: string },
): void {
  nativePort?.postMessage({ responseToRequestId: requestId, payload });
}

function scheduleReconnect(): void {
  if (nativePort || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectNativeHost();
  }, RECONNECT_DELAY_MS);
}

export function connectNativeHost(port = NATIVE_HOST.DEFAULT_PORT): boolean {
  if (nativePort) return true;
  try {
    const portHandle = chrome.runtime.connectNative(NATIVE_HOST.NAME);
    nativePort = portHandle;

    portHandle.onMessage.addListener(async (message) => {
      if (message.type === NativeMessageType.CALL_TOOL && message.requestId) {
        const name = message.payload?.name;
        if (name !== EXECUTOR_NAME) {
          respond(message.requestId, {
            status: 'error',
            error: `Unsupported command executor: ${String(name || '')}`,
          });
          return;
        }
        try {
          const result = await chromeShellTool.execute(message.payload?.args || {});
          respond(message.requestId, { status: 'success', data: result });
        } catch (error) {
          respond(message.requestId, {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      if (message.type === NativeMessageType.ERROR_FROM_NATIVE_HOST) {
        console.error('[ChromeShell] Native host error:', message.payload?.message);
      }
    });

    portHandle.onDisconnect.addListener(() => {
      nativePort = null;
      scheduleReconnect();
    });

    portHandle.postMessage({ type: NativeMessageType.START, payload: { port } });
    return true;
  } catch (error) {
    console.warn('[ChromeShell] Native host connection failed:', error);
    nativePort = null;
    scheduleReconnect();
    return false;
  }
}

export function initNativeHostListener(): void {
  keepaliveRelease ||= acquireKeepalive('chrome-shell-native-host');
  connectNativeHost();
  chrome.runtime.onStartup.addListener(() => connectNativeHost());
  chrome.runtime.onInstalled.addListener(() => connectNativeHost());
}
