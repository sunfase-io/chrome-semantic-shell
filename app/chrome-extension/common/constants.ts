export const NATIVE_HOST = {
  NAME: 'com.chromesemanticshell.nativehost',
  DEFAULT_PORT: 12306,
} as const;

export const TIMEOUTS = {
  DEFAULT_WAIT: 1_000,
  KEYBOARD_DELAY: 50,
} as const;

export const LIMITS = {
  MAX_NETWORK_REQUESTS: 100,
} as const;

export const ERROR_MESSAGES = {
  TOOL_EXECUTION_FAILED: 'Action execution failed',
  INVALID_PARAMETERS: 'Invalid parameters provided',
  TAB_NOT_FOUND: 'Tab not found',
} as const;

export const NETWORK_FILTERS = {
  EXCLUDED_DOMAINS: [
    'google-analytics.com',
    'googletagmanager.com',
    'sentry.io',
    'doubleclick.net',
    'hm.baidu.com',
  ],
  STATIC_RESOURCE_EXTENSIONS: [
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.svg',
    '.webp',
    '.ico',
    '.css',
    '.js',
    '.map',
    '.woff',
    '.woff2',
    '.ttf',
    '.mp3',
    '.mp4',
  ],
  STATIC_MIME_TYPES_TO_FILTER: [
    'image/',
    'font/',
    'audio/',
    'video/',
    'text/css',
    'text/javascript',
    'application/javascript',
    'application/octet-stream',
  ],
  API_MIME_TYPES: [
    'application/json',
    'application/xml',
    'text/xml',
    'text/plain',
    'text/event-stream',
    'application/x-www-form-urlencoded',
    'application/graphql',
  ],
} as const;

export enum ExecutionWorld {
  ISOLATED = 'ISOLATED',
  MAIN = 'MAIN',
}
