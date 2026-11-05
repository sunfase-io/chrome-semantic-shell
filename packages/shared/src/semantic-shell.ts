export type SemanticSource = 'native' | 'aria' | 'vue2' | 'vue3' | 'react' | 'webmcp' | 'snippet';

export interface SemanticNodeState {
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  required?: boolean;
  invalid?: boolean;
  readonly?: boolean;
  hidden?: boolean;
}

export interface SemanticLocatorHint {
  kind: 'id' | 'testid' | 'aria' | 'css' | 'xpath';
  value: string;
  name?: string;
  role?: string;
}

export interface SemanticNode {
  ref: string;
  frameId?: number;
  role: string;
  kind?: string;
  name?: string;
  value?: string;
  description?: string;
  context?: string;
  states?: SemanticNodeState;
  options?: string[];
  optionsTotal?: number;
  source: SemanticSource;
  locatorHints?: SemanticLocatorHint[];
}

export interface SemanticPageState {
  version: number;
  url: string;
  title: string;
  nodes: SemanticNode[];
  capabilities: string[];
}

export interface SemanticApiEvent {
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  failed?: string;
}

export interface SemanticEvent {
  kind: 'url' | 'dialog' | 'toast' | 'validation' | 'console' | 'text' | 'api';
  message: string;
}

export interface SemanticPageDelta {
  expired?: boolean;
  fromVersion: number;
  toVersion: number;
  added: SemanticNode[];
  updated: SemanticNode[];
  removed: string[];
  events: SemanticEvent[];
  api: SemanticApiEvent[];
  elapsedMs?: number;
}

export interface PageToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown> | string;
  source: 'webmcp' | 'snippet' | 'operation';
  readOnly?: boolean;
}

export type SemanticExecOutputMode = 'compact' | 'json' | 'debug';

export interface SemanticExecParams {
  script: string;
  /** Cheap page-identity precondition checked inside the execution request. */
  expectedUrl?: string;
  vars?: Record<string, unknown>;
  tabId?: number;
  windowId?: number;
  timeoutMs?: number;
  output?: SemanticExecOutputMode;
  dryRun?: boolean;
  /** Stop at the first failed statement even across `;`/newline separators (|| recovery still runs). */
  failFast?: boolean;
  /** Omit the change/delta report from compact output. */
  quiet?: boolean;
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
