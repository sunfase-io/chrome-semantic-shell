export enum NativeMessageType {
  START = 'start',
  STOP = 'stop',
  ERROR = 'error',
  CALL_TOOL = 'call_tool',
  SERVER_STARTED = 'server_started',
  SERVER_STOPPED = 'server_stopped',
  ERROR_FROM_NATIVE_HOST = 'error_from_native_host',
}

export interface SemanticExecParams {
  script: string;
  vars?: Record<string, unknown>;
  tabId?: number;
  windowId?: number;
  timeoutMs?: number;
  output?: 'compact' | 'json' | 'debug';
  dryRun?: boolean;
  failFast?: boolean;
  quiet?: boolean;
  expectedUrl?: string;
}

export interface CommandTextContent {
  type: 'text';
  text: string;
}

export interface CommandImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface CommandResult {
  content: Array<CommandTextContent | CommandImageContent>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}
