export const SHELL_KEEPALIVE_PORT_NAME = 'chrome_shell_keepalive' as const;

export type KeepaliveMessageType =
  | 'keepalive.ping'
  | 'keepalive.pong'
  | 'keepalive.start'
  | 'keepalive.stop';

export interface KeepaliveMessage {
  type: KeepaliveMessageType;
  timestamp: number;
}

export const DEFAULT_KEEPALIVE_PING_INTERVAL_MS = 20_000;
export const MAX_KEEPALIVE_PING_INTERVAL_MS = 25_000;
