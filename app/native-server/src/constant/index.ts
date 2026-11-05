export const NATIVE_SERVER_PORT = 12306;

export const TIMEOUTS = {
  DEFAULT_REQUEST_TIMEOUT: 15_000,
} as const;

export const SERVER_CONFIG = {
  HOST: '127.0.0.1',
  LOGGER_ENABLED: false,
} as const;

export const HTTP_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
} as const;

export const ERROR_MESSAGES = {
  NATIVE_HOST_NOT_AVAILABLE: 'Native host connection not established.',
} as const;

export const CHROME_SHELL_PORT_ENV = 'CHROME_SHELL_PORT';

export function getChromeShellPort(): number {
  const raw = process.env[CHROME_SHELL_PORT_ENV];
  if (raw === undefined || raw === '') return NATIVE_SERVER_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${CHROME_SHELL_PORT_ENV} must be an integer between 1 and 65535`);
  }
  return port;
}
