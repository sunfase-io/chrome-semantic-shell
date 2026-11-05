import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import {
  TOOL_NAMES,
  type SemanticExecParams,
  type SemanticNode,
  type SemanticPageState,
} from 'chrome-semantic-shell-shared';
import { beginObservation, collectObservation } from './page-diff';
import { waitForApiIdle } from './page-diff-api-log';
import {
  parseShellProgram,
  validateShellProgram,
  type ShellCommand,
  type ShellProgram,
} from './semantic-shell-dsl';
import { readSemanticPageSignal, readSemanticPageState } from './semantic-state';
import {
  diffSemanticStates,
  renderSemanticDelta,
  renderSemanticState,
  type SemanticInspectOptions,
} from './semantic-state-core';
import { callWebMcpTool, listWebMcpTools } from './webmcp-adapter';
import type {
  ActionExecutionContext,
  ElementTarget,
  ExecutableAction,
  SelectorCandidate,
  VariableStore,
} from '@/entrypoints/background/semantic-actions';

interface StepRecord {
  command: string;
  status: 'success' | 'failed' | 'skipped';
  detail?: string;
  /** Decoded result of js/tool/http steps; `detail` keeps the raw text for existing consumers. */
  value?: unknown;
  durationMs: number;
}

interface RecordExtra {
  /** Compact-output line when it differs from the stored detail. */
  line?: string;
  value?: unknown;
  warnings?: string[];
}

interface RuntimeState {
  tabId: number;
  startedAt: number;
  vars: VariableStore;
  pipelineNodes: SemanticNode[];
  lastPage?: SemanticPageState;
  lastView?: SemanticViewSpec;
  records: StepRecord[];
  lines: string[];
  artifacts: any[];
  logs: string[];
  actionCounter: number;
  lastSuccess: boolean;
  workspaceTools: WorkspaceTool[];
  workspaceToolErrors: Array<{ file: string; reason: string }>;
  captureDraft?: OperationDraft;
  publishRequest?: { name: string; manifest: Record<string, unknown> };
  deferredPrograms: ShellProgram[];
  observationTabId?: number;
  observationDeltas: string[];
  toolDepth: number;
  learningResults: Array<{ name: string; status: 'success' | 'failed'; category?: string }>;
  failFast: boolean;
  /** Tab URL when the program started; navigation baseline without an inspect. */
  startUrl?: string;
  /** Last filled/typed element: the default target of a following `key`. */
  lastInput?: { ref: string; frameId?: number };
}

/** Per deferred cleanup block; cleanups run even after the program deadline. */
const DEFER_BUDGET_MS = 10_000;

const TARGET_OPTION_KEYS = ['ref', 'css', 'xpath', 'role', 'name', 'name~', 'text'];

/** Whole-program deadline cap shared with the native bridge and CLI; stays below the MV3 5-minute event limit. */
const MAX_PROGRAM_TIMEOUT_MS = 280_000;

interface SemanticViewSpec {
  options: SemanticInspectOptions;
  roleFilter?: string;
  nameFilter?: string;
}

export interface OperationDraft {
  name: string;
  description?: string;
  requests: Array<Record<string, unknown>>;
  scalarPaths: string[];
}

export function createOperationDraft(
  name: string,
  description: string | undefined,
  requests: Array<Record<string, unknown>>,
  scalarPaths: string[],
): OperationDraft {
  return {
    name,
    ...(description ? { description } : {}),
    requests,
    scalarPaths,
  };
}

interface WorkspaceTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown> | string;
  readOnly?: boolean;
  source: 'snippet' | 'operation' | 'learned';
  kind: 'javascript' | 'http-sequence' | 'semantic-sequence';
  code?: string;
  manifest?: Record<string, unknown>;
}

const MUTATING_COMMANDS = new Set([
  'click',
  'dblclick',
  'fill',
  'type',
  'fillform',
  'select',
  'check',
  'key',
  'scroll',
  'drag',
  'hover',
  'navigate',
  'back',
  'forward',
  'reload',
  'js',
  'http',
  'call',
  'dialog',
  'upload',
]);

const INSPECT_MODES = new Set(['interactive', 'forms', 'tables', 'dialog', 'text', 'full']);
const TABLE_SEMANTIC_ROLES = new Set(['table', 'row', 'columnheader', 'cell']);

export function validateSemanticToolInput(schema: any, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tool input must be an object');
  const value = input as Record<string, unknown>;
  if (!schema || schema.type !== 'object' || !schema.properties) throw new Error('Semantic tool needs an object inputSchema');
  for (const key of schema.required || []) {
    if (!Object.hasOwn(value, key)) throw new Error(`Missing tool input: ${key}`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(schema.properties, key)) throw new Error(`Unknown tool input: ${key}`);
    const actual = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
    if (schema.properties[key].type !== actual || (actual === 'number' && !Number.isFinite(item))) {
      throw new Error(`Invalid tool input type: ${key}`);
    }
  }
  return value;
}

export function learnedFailureCategory(command: string, message: string): 'structural' | 'execution' {
  const verb = command.trim().split(/\s+/, 1)[0];
  const locatorAction = ['query', 'fill', 'fillform', 'select', 'check', 'click', 'dblclick', 'hover', 'drag', 'upload', 'type'].includes(verb);
  return locatorAction && /STALE_REF|could not locate target|matched \d+ (exact semantic )?nodes|expected exactly one|target element is not fillable|piped nodes but needs one/i.test(message)
    ? 'structural' : 'execution';
}

export function defaultInspectModeForRole(role: string | undefined): 'interactive' | 'tables' {
  return role && TABLE_SEMANTIC_ROLES.has(role) ? 'tables' : 'interactive';
}

function asJsonValue(value: unknown): any {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  if (Array.isArray(value)) return value.map(asJsonValue);
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = asJsonValue(entry);
    }
    return out;
  }
  throw new Error(`Variable value is not JSON-serializable: ${typeof value}`);
}

function lookupVariable(raw: string, vars: VariableStore): unknown {
  const name = raw.slice(1);
  if (!(name in vars)) throw new Error(`Variable $${name} is not defined`);
  return vars[name];
}

/**
 * Decode a DSL value. Quoted literals stay strings (a quoted `{...}` or `[...]` is still accepted as JSON
 * when it parses); unquoted literals decode numbers, booleans, null and strict JSON.
 */
function decodeValue(raw: string | boolean | undefined, vars: VariableStore, quoted = false): any {
  if (raw === undefined || raw === true) return raw;
  if (typeof raw !== 'string') return raw;
  if (raw.startsWith('$')) return lookupVariable(raw, vars);
  if (quoted) {
    if (!/^[[{]/.test(raw)) return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Invalid JSON value ${raw}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  return raw;
}

/** Option decoded as JSON-aware data (input=, body=, bindings=, set/for values). */
function optionData(command: ShellCommand, key: string, vars: VariableStore): any {
  return decodeValue(command.options[key], vars, command.quoted?.includes(key));
}

/** String-valued options (selectors, text, URLs) never go through JSON decoding. */
function stringValue(raw: string | boolean | undefined, vars: VariableStore): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'boolean') return String(raw);
  const value = raw.startsWith('$') ? lookupVariable(raw, vars) : raw;
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function stripRef(value: string): string {
  return value.startsWith('@') ? value.slice(1) : value;
}

export function resolveSemanticScope(
  scope: string | undefined,
  pipelineNodes: SemanticNode[],
  lastPage?: SemanticPageState,
): Pick<SemanticInspectOptions, 'scopeRef' | 'scopeFrameId'> {
  if (!scope) return {};
  if (scope !== 'pipe' && !/^@?ref_\d+$/.test(scope)) {
    throw new Error(
      `scope must be "pipe" or a ref such as @ref_12, got "${scope}"; for the open dialog use "inspect dialog"`,
    );
  }
  if (scope === 'pipe') {
    if (pipelineNodes.length !== 1) {
      throw new Error(
        `scope=pipe expects exactly one piped semantic node; received ${pipelineNodes.length}`,
      );
    }
    return {
      scopeRef: pipelineNodes[0].ref,
      scopeFrameId: pipelineNodes[0].frameId,
    };
  }
  const scopeRef = stripRef(scope);
  const node =
    pipelineNodes.find((candidate) => candidate.ref === scopeRef) ||
    lastPage?.nodes.find((candidate) => candidate.ref === scopeRef);
  return { scopeRef, scopeFrameId: node?.frameId };
}

const normalizeOptionValue = (value: string | undefined): string | undefined => {
  const normalized = value?.trim().toLocaleLowerCase();
  return normalized || undefined;
};

export function matchExactSelectOptions(nodes: SemanticNode[], value: string): SemanticNode[] {
  const expected = normalizeOptionValue(value);
  if (!expected) return [];
  const matches = nodes.filter((node) => {
    if (!['option', 'menuitem', 'radio'].includes(node.role)) return false;
    const name = normalizeOptionValue(node.name);
    const rawValue = normalizeOptionValue(node.value);
    const combined = rawValue && name && rawValue !== name ? `${rawValue}:${name}` : undefined;
    return expected === name || expected === rawValue || expected === combined;
  });
  // A popup's options beat same-named navigation menu items elsewhere on the page.
  const options = matches.filter((node) => node.role === 'option');
  return options.length ? options : matches;
}

export function unwrapJavascriptToolPayload(text: string): {
  value: unknown;
  truncated: boolean;
  warnings: string[];
  engine?: string;
  elapsedMs?: number;
} {
  const decode = (raw: unknown): unknown => {
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    return { value: decode(text), truncated: false, warnings: [] };
  }
  if (!payload || typeof payload !== 'object' || typeof payload.success !== 'boolean') {
    return { value: payload, truncated: false, warnings: [] };
  }
  if (!payload.success) {
    throw new Error(payload.error?.message || 'JavaScript page tool failed');
  }
  return {
    value: decode(payload.result),
    truncated: payload.truncated === true,
    warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : [],
    engine: typeof payload.engine === 'string' ? payload.engine : undefined,
    elapsedMs: Number.isFinite(payload.metrics?.elapsedMs) ? payload.metrics.elapsedMs : undefined,
  };
}

/** Default byte budget of one js/tool/http result in the program output. */
const DEFAULT_RESULT_BYTES = 50 * 1024;

export function renderResultValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? 'undefined';
}

/** One readable error line instead of the raw JavaScript tool envelope. */
export function describeJavascriptFailure(text: string): string {
  try {
    const payload = JSON.parse(text);
    if (payload && typeof payload === 'object' && payload.error) {
      const kind = payload.error.kind ? `${payload.error.kind}: ` : '';
      const warnings = Array.isArray(payload.warnings) && payload.warnings.length
        ? ` (${payload.warnings.join('; ')})`
        : '';
      return `${kind}${payload.error.message || 'JavaScript failed'}${warnings}`;
    }
  } catch {
    // Not an envelope: already a plain message.
  }
  return text;
}

export function javascriptStepOutcome(text: string): {
  value: unknown;
  line: string;
  warnings: string[];
} {
  const payload = unwrapJavascriptToolPayload(text);
  const raw = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  })();
  const warnings = [...payload.warnings];
  if (payload.truncated) {
    warnings.push('result truncated; return less data, raise max=<bytes>, or page through it');
  }
  if (raw.undefinedResult && !raw.expression) {
    warnings.push('code returned undefined; statement code needs an explicit return');
  }
  return { value: payload.value, line: renderResultValue(payload.value), warnings };
}

interface TabListing {
  windowCount: number;
  tabCount: number;
  windows: Array<{ windowId: number; tabs: Array<{ tabId: number; url: string; title: string; active: boolean }> }>;
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export interface PageHttpRequest {
  method: string;
  url: string;
  context: 'page' | 'extension';
  headers: Record<string, string>;
  body?: unknown;
  form?: Record<string, unknown>;
  pick?: unknown;
  as?: string;
}

/** `http [METHOD] URL [headers={..}] [body=..|form={..}] [pick=..] [as=$v] [context=page|extension]` */
export function parseHttpCommand(command: ShellCommand, vars: VariableStore): PageHttpRequest {
  const [first, second] = command.args;
  const firstIsMethod = typeof first === 'string' && HTTP_METHODS.has(first.toUpperCase());
  const method = String(stringValue(command.options.method, vars) || (firstIsMethod ? first : 'GET')).toUpperCase();
  if (!HTTP_METHODS.has(method)) throw new Error(`http method must be one of ${[...HTTP_METHODS].join(', ')}`);
  const url = stringValue(command.options.url ?? (firstIsMethod ? second : first), vars);
  if (!url) throw new Error('http expects a URL: http GET /api/items or http POST https://host/api body={...}');
  const context = stringValue(command.options.context, vars) || 'page';
  if (context !== 'page' && context !== 'extension') throw new Error('http context must be page or extension');
  const rawHeaders = command.options.headers !== undefined ? optionData(command, 'headers', vars) : {};
  if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) throw new Error('http headers= expects a JSON object');
  // "$token" inside the headers object refers to a variable (e.g. one read by `storage get`).
  const headers = Object.fromEntries(
    Object.entries(rawHeaders as Record<string, unknown>).map(([key, value]) => [
      key,
      String(typeof value === 'string' && value.startsWith('$') ? lookupVariable(value, vars) : value),
    ]),
  );
  const body = command.options.body !== undefined ? optionData(command, 'body', vars) : undefined;
  const form = command.options.form !== undefined ? optionData(command, 'form', vars) : undefined;
  if (body !== undefined && form !== undefined) throw new Error('http takes body= or form=, not both');
  if (form !== undefined && (!form || typeof form !== 'object' || Array.isArray(form))) throw new Error('http form= expects a JSON object');
  return {
    method,
    url,
    context,
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(form !== undefined ? { form } : {}),
    ...(command.options.pick !== undefined ? { pick: optionData(command, 'pick', vars) } : {}),
    ...(command.options.as !== undefined ? { as: String(command.options.as).replace(/^\$/, '') } : {}),
  };
}

/**
 * Page-context request: same origin, cookies, CORS and certificates exactly as the page sees them.
 * `pick` reduces the response in the page: a dot path, an array of paths, or {alias: path}.
 */
export function buildPageHttpCode(request: PageHttpRequest): string {
  return `const spec = ${JSON.stringify(request)};
const get = (value, path) => String(path).split('.').filter(Boolean).reduce((v, key) => v == null ? v : v[key], value);
const pick = (data, sel) => sel == null ? data : typeof sel === 'string' ? get(data, sel)
  : Array.isArray(sel) ? Object.fromEntries(sel.map((path) => [path, get(data, path)]))
  : Object.fromEntries(Object.entries(sel).map(([alias, path]) => [alias, get(data, path)]));
const headers = { ...spec.headers };
let body;
if (spec.form) { body = new URLSearchParams(Object.entries(spec.form).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])); }
else if (spec.body !== undefined) {
  body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
  if (typeof spec.body !== 'string' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
}
let response;
try {
  response = await fetch(new URL(spec.url, location.href).href, { method: spec.method, headers, body, credentials: 'include' });
} catch (error) {
  return { error: String(error && error.message || error) + ' (network, CORS, certificate, or mixed-content failure; check console buffer --errors)' };
}
const raw = await response.text();
let data;
try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
return { status: response.status, ok: response.ok, url: response.url, data: response.ok ? pick(data, spec.pick) : data };`;
}

/** MAIN-world storage read; JSON-quoted strings are unwrapped. */
export function readStorageInPage(area: string, key: string): { ok: boolean; value?: unknown; error?: string } {
  try {
    let raw: string | null = null;
    if (area === 'cookie') {
      const entry = document.cookie.split('; ').find((part) => part.split('=')[0] === key);
      raw = entry ? decodeURIComponent(entry.slice(key.length + 1)) : null;
    } else {
      raw = (area === 'session' ? sessionStorage : localStorage).getItem(key);
    }
    if (raw === null) return { ok: false, error: `${area} storage has no "${key}" (wrong tab, or logged out?)` };
    try {
      const parsed = JSON.parse(raw);
      return { ok: true, value: typeof parsed === 'string' ? parsed : raw };
    } catch {
      return { ok: true, value: raw };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Compact `network stop`: one line per request, headers dropped (they carry cookies and tokens),
 * bodies previewed. The raw capture stays in the JSON step detail.
 */
export function summarizeNetworkCapture(
  text: string,
  urlFilter: string | undefined,
  limit: number,
): { line: string; requests: unknown[] } {
  let capture: any;
  try {
    capture = JSON.parse(text);
  } catch {
    return { line: text, requests: [] };
  }
  const all: any[] = Array.isArray(capture?.requests) ? capture.requests : [];
  const requests = all
    .filter((request) => !urlFilter || String(request.url || '').includes(urlFilter))
    .map((request) => ({
      method: request.method,
      url: request.url,
      status: request.status ?? request.statusCode,
      type: request.type,
      mimeType: request.mimeType,
      ...(request.requestBody !== undefined ? { requestBody: request.requestBody } : {}),
      ...(request.responseBody !== undefined ? { responseBody: request.responseBody } : {}),
    }));
  const preview = (value: unknown) => {
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    return body.length > 300 ? `${body.slice(0, 300)}…(${body.length} chars)` : body;
  };
  const lines = [`network: ${requests.length} request(s)${urlFilter ? ` matching ${JSON.stringify(urlFilter)}` : ''}${requests.length > limit ? `, first ${limit} shown` : ''}`];
  for (const request of requests.slice(0, limit)) {
    lines.push(`${request.method || 'GET'} ${request.status ?? '-'} ${request.url} ${request.mimeType || request.type || ''}`.trim());
    if (request.responseBody !== undefined) lines.push(`  body: ${preview(request.responseBody)}`);
  }
  return { line: lines.join('\n'), requests };
}

/** Registers the single element matching `css` under a transient ref so ref-based actions can use it. */
async function pinCssTarget(tabId: number, frameId: number, css: string): Promise<string> {
  const ref = `ref_css_${Date.now().toString(36)}`;
  const [frame] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'ISOLATED',
    func: (selector: string, key: string) => {
      let found: Element[];
      try {
        found = Array.from(document.querySelectorAll(selector));
      } catch (error) {
        return { error: `invalid selector: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (found.length !== 1) return { error: `css=${JSON.stringify(selector)} matched ${found.length} elements; expected exactly one` };
      const map = ((window as any).__chromeShellElementMap ||= {});
      map[key] = new WeakRef(found[0]);
      return { ok: true };
    },
    args: [css, ref],
  });
  const outcome = frame?.result as { ok?: boolean; error?: string } | undefined;
  if (!outcome?.ok) throw new Error(outcome?.error || `cannot resolve css=${css}`);
  return ref;
}

/** Frame owning a live ref; refs are numbered per frame, so a ref found in several frames is ambiguous. */
async function locateRefFrame(tabId: number, ref: string): Promise<number | undefined> {
  const results = await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      func: (value: string) => Boolean((window as any).__chromeShellElementMap?.[value]?.deref?.()),
      args: [ref],
    })
    .catch(() => []);
  const owners = results.filter((result) => result.result === true).map((result) => result.frameId || 0);
  if (owners.length > 1) {
    throw new Error(`${ref} exists in frames ${owners.join(', ')}; add frame=<id> from the inspect output`);
  }
  return owners[0];
}

/** Main-frame network errors (net::ERR_*) while a navigation runs; the tab itself still reports success. */
function watchNavigationErrors(tabId: number): { failed(): boolean; result(): Promise<string | undefined>; stop(): void } {
  let error: string | undefined;
  const listener = (details: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => {
    if (details.tabId === tabId && details.frameId === 0 && !/ERR_ABORTED/.test(details.error)) error = details.error;
  };
  chrome.webNavigation?.onErrorOccurred?.addListener(listener);
  return {
    failed: () => error !== undefined,
    async result() {
      if (error) return error;
      // Chrome refuses scripting on its own error page; that is the reliable signal even when the
      // webNavigation error event raced the listener.
      try {
        await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => true });
        return undefined;
      } catch (probe) {
        const message = probe instanceof Error ? probe.message : String(probe);
        return /showing error page/i.test(message) ? error || 'Chrome error page' : undefined;
      }
    },
    stop() {
      chrome.webNavigation?.onErrorOccurred?.removeListener(listener);
    },
  };
}

/** One tab per line; `match` filters by case-insensitive URL/title substring. */
export function renderTabList(listing: TabListing, match?: string): string {
  const needle = match?.toLowerCase();
  const lines: string[] = [];
  for (const window of listing.windows) {
    for (const tab of window.tabs) {
      if (needle && !`${tab.url} ${tab.title}`.toLowerCase().includes(needle)) continue;
      const title = tab.title.length > 60 ? `${tab.title.slice(0, 60)}…` : tab.title;
      lines.push(`${tab.active ? '*' : ' '} ${tab.tabId} w${window.windowId} ${JSON.stringify(title)} ${tab.url}`);
    }
  }
  const header = `tabs: ${lines.length}${needle ? ` matching ${JSON.stringify(match)}` : ''} of ${listing.tabCount} (* = active in window)`;
  return [header, ...lines].join('\n');
}

/** ` input={id:string, all?:boolean}` so callers need not open the tool source to learn its inputs. */
export function describeInputSchema(schema: unknown): string {
  const parsed = typeof schema === 'string' ? (() => {
    try {
      return JSON.parse(schema);
    } catch {
      return undefined;
    }
  })() : schema;
  const properties = (parsed as any)?.properties;
  if (!properties || typeof properties !== 'object') return '';
  const required = new Set<string>(Array.isArray((parsed as any).required) ? (parsed as any).required : []);
  const fields = Object.entries(properties as Record<string, any>).map(([key, value]) => {
    const type = Array.isArray(value?.type) ? value.type.join('|') : value?.type || 'any';
    return `${key}${required.has(key) ? '' : '?'}:${type}`;
  });
  return fields.length ? ` input={${fields.join(', ')}}` : '';
}

/** A tool call may shorten, never extend, the program deadline. */
function toolDeadline(command: ShellCommand, deadline: number): number {
  const timeout = optionNumber(command, 'timeout', 0);
  return timeout > 0 ? Math.min(deadline, Date.now() + timeout) : deadline;
}

function frameOption(command: ShellCommand): number | undefined {
  const raw = command.options.frame;
  if (raw === undefined) return undefined;
  const frame = Number(raw);
  if (raw === true || !Number.isInteger(frame) || frame < 0) {
    throw new Error('frame must be a non-negative integer');
  }
  return frame;
}

function escapeCssIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function targetFrom(
  command: ShellCommand,
  pipelineNodes: SemanticNode[],
  vars: VariableStore,
): ElementTarget {
  const candidates: SelectorCandidate[] = [];
  const explicitRef = stringValue(command.options.ref, vars);
  const firstArg = command.args[0];
  const argRef = firstArg && /^@?ref_\d+$/.test(firstArg) ? stripRef(firstArg) : undefined;
  const pipedNode =
    !explicitRef && !argRef && pipelineNodes.length === 1 ? pipelineNodes[0] : undefined;
  const pipedRef = pipedNode?.ref;
  const ref = explicitRef ? stripRef(explicitRef) : argRef || pipedRef;
  const referencedNode = ref ? pipelineNodes.find((node) => node.ref === ref) : pipedNode;
  const frameRaw = command.options.frame;
  const frameId =
    frameRaw !== undefined && frameRaw !== true ? Number(frameRaw) : referencedNode?.frameId;
  if (frameId !== undefined && (!Number.isInteger(frameId) || frameId < 0)) {
    throw new Error('frame must be a non-negative integer');
  }

  const css = stringValue(command.options.css, vars);
  const xpath = stringValue(command.options.xpath, vars);
  const role = stringValue(command.options.role, vars);
  const name = stringValue(command.options.name, vars);
  const text = stringValue(command.options.text, vars);
  if (css) candidates.push({ type: 'css', selector: css });
  if (xpath) candidates.push({ type: 'xpath', xpath });
  if (role || name) candidates.push({ type: 'aria', role, name: name || text || '' });
  if (text) candidates.push({ type: 'text', text, match: 'exact' });
  if (!css && !xpath && !role && !name && !text && pipedNode?.locatorHints) {
    for (const hint of pipedNode.locatorHints) {
      if (hint.kind === 'id') {
        candidates.push({ type: 'css', selector: `#${escapeCssIdentifier(hint.value)}` });
      } else if (hint.kind === 'testid') {
        candidates.push({
          type: 'attr',
          selector: `[data-testid="${hint.value.replace(/"/g, '\\"')}"]`,
        });
      } else if (hint.kind === 'aria' && hint.name) {
        candidates.push({ type: 'aria', role: hint.role, name: hint.name });
      }
    }
  }
  if (!ref && !candidates.length && firstArg) {
    candidates.push({ type: 'text', text: firstArg, match: 'exact' });
  }
  if (ref) {
    return {
      ref,
      ...(candidates.length ? { candidates: candidates as any } : {}),
      ...(frameId !== undefined ? ({ frameId } as any) : {}),
    } as ElementTarget;
  }
  if (candidates.length) {
    return {
      candidates: candidates as any,
      ...(frameId !== undefined ? ({ frameId } as any) : {}),
    } as ElementTarget;
  }
  if (pipelineNodes.length > 1) {
    const shown = pipelineNodes
      .slice(0, 5)
      .map((node) => `${node.ref} ${node.role}${node.name ? ` ${JSON.stringify(node.name.slice(0, 40))}` : ''}`)
      .join('; ');
    throw new Error(
      `${command.name} received ${pipelineNodes.length} piped nodes but needs one; narrow the query (exact name=, scope=pipe, nth=) — ${shown}`,
    );
  }
  throw new Error(`${command.name} needs a target: @ref, a single piped node, or css=/role=/name=/text=`);
}

/** Locator options of a command, for failure messages. */
function describeLocator(command: ShellCommand): string {
  const parts = Object.entries(command.options)
    .filter(([key]) => ['role', 'name', 'name~', 'text', 'query', 'css', 'mode', 'scope', 'frame'].includes(key))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  const positional = command.args.filter((arg) => !INSPECT_MODES.has(arg));
  if (positional.length) parts.push(JSON.stringify(positional.join(' ')));
  return parts.join(' ') || 'no filters';
}

export function matchExactSemanticTarget(
  nodes: SemanticNode[],
  role: string | undefined,
  name: string,
): SemanticNode[] {
  return nodes.filter((node) => (!role || node.role === role) && node.name?.trim() === name.trim());
}

const SCROLL_DIRECTIONS = new Set(['up', 'down', 'left', 'right', 'top', 'bottom']);

/**
 * Page-side scroll: bring a ref into view, or scroll the scroll container under the viewport center
 * (falling back to the document). Self-contained for executeScript serialization.
 */
export function scrollInPage(spec: { ref?: string; containerRef?: string; direction?: string; amount: number }): {
  ok: boolean;
  detail?: string;
  error?: string;
} {
  if (spec.ref) {
    const el = (window as any).__chromeShellElementMap?.[spec.ref]?.deref?.();
    if (!(el instanceof Element)) return { ok: false, error: `STALE_REF: ${spec.ref} is no longer live; inspect again` };
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    return { ok: true, detail: `${spec.ref} into view` };
  }
  const vertical = spec.direction !== 'left' && spec.direction !== 'right';
  const scrollable = (el: Element): boolean => {
    const style = getComputedStyle(el);
    const overflow = vertical ? style.overflowY : style.overflowX;
    return /(auto|scroll|overlay)/.test(overflow) &&
      (vertical ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1);
  };
  let container: Element | null =
    typeof document.elementFromPoint === 'function' ? document.elementFromPoint(innerWidth / 2, innerHeight / 2) : null;
  while (container && container !== document.body && container !== document.documentElement && !scrollable(container)) {
    container = container.parentElement;
  }
  const page = document.scrollingElement || document.documentElement;
  const piped = spec.containerRef ? (window as any).__chromeShellElementMap?.[spec.containerRef]?.deref?.() : undefined;
  if (spec.containerRef && !(piped instanceof Element)) {
    return { ok: false, error: `STALE_REF: ${spec.containerRef} is no longer live` };
  }
  const target: Element =
    piped || (container && container !== document.body && container !== document.documentElement ? container : page);
  const before = vertical ? target.scrollTop : target.scrollLeft;
  const max = vertical ? target.scrollHeight - target.clientHeight : target.scrollWidth - target.clientWidth;
  const delta = { up: -spec.amount, down: spec.amount, left: -spec.amount, right: spec.amount } as Record<string, number>;
  const next =
    spec.direction === 'top' ? 0 : spec.direction === 'bottom' ? max : Math.max(0, Math.min(max, before + (delta[spec.direction || 'down'] ?? 0)));
  if (vertical) target.scrollTop = next;
  else target.scrollLeft = next;
  const after = vertical ? target.scrollTop : target.scrollLeft;
  const name = target === page ? 'page' : `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ''}${typeof target.className === 'string' && target.className ? `.${target.className.trim().split(/\s+/)[0]}` : ''}`;
  return {
    ok: true,
    detail: `${spec.direction} ${name} ${Math.round(before)}->${Math.round(after)} of ${Math.round(max)}${after === before ? ' (already at edge)' : ''}`,
  };
}

export interface ExtractSpec {
  ref?: string;
  selector?: string;
  attr: string;
  all: boolean;
  fields?: Record<string, string>;
  limit: number;
}

/**
 * Page-side reader for `extract`. Field specs: "sel" (text of the first match), "sel@attr",
 * "@attr" (attribute of the row itself) and "" (row text). Serialized with toString: self-contained.
 */
export function extractInPage(spec: ExtractSpec): { ok: boolean; value?: unknown; error?: string } {
  const read = (el: Element, attr: string): string | null => {
    if (attr === 'text') return ((el as HTMLElement).innerText ?? el.textContent ?? '').trim();
    if (attr === 'html') return el.outerHTML;
    if (attr === 'value') return (el as HTMLInputElement).value ?? null;
    if (attr === 'href' || attr === 'src') return (el as any)[attr] || el.getAttribute(attr);
    return el.getAttribute(attr);
  };
  const field = (row: Element, raw: string): string | null => {
    const at = raw.lastIndexOf('@');
    const selector = (at >= 0 ? raw.slice(0, at) : raw).trim();
    const attr = at >= 0 ? raw.slice(at + 1).trim() : 'text';
    const el = selector ? row.querySelector(selector) : row;
    return el ? read(el, attr) : null;
  };
  try {
    let elements: Element[];
    if (spec.ref) {
      const el = (window as any).__chromeShellElementMap?.[spec.ref]?.deref?.();
      if (!(el instanceof Element)) return { ok: false, error: `STALE_REF: ${spec.ref} is no longer live; inspect again` };
      elements = [el];
    } else {
      elements = Array.from(document.querySelectorAll(spec.selector || ''));
    }
    if (!elements.length) return { ok: false, error: `extract matched no element for ${spec.ref || spec.selector}` };
    const pick = (el: Element) =>
      spec.fields
        ? Object.fromEntries(Object.entries(spec.fields).map(([key, raw]) => [key, field(el, raw)]))
        : read(el, spec.attr);
    return {
      ok: true,
      value: spec.all || spec.fields ? elements.slice(0, spec.limit).map(pick) : pick(elements[0]),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** ISOLATED-world fallback for a logically open custom option in a throttled background tab. */
export function clickZeroRectOptionInPage(ref: string): boolean {
  const weak = (window as any).__chromeShellElementMap?.[ref];
  const element = weak?.deref?.();
  if (!(element instanceof HTMLElement)) return false;
  if (
    !element.matches(
      '.el-select-dropdown__item,.el-cascader-node,[role="option"],[role="menuitem"],[role="radio"]',
    )
  ) {
    return false;
  }
  const popup = element.closest(
    '.el-select-dropdown,.el-cascader__dropdown,[role="listbox"],[role="menu"]',
  );
  if (!(popup instanceof HTMLElement)) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (current === popup) break;
  }
  const rect = element.getBoundingClientRect();
  if (element.getClientRects().length === 0 || rect.width <= 0 || rect.height !== 0) return false;
  element.click();
  return true;
}

async function clickZeroRectOption(tabId: number, option: SemanticNode): Promise<boolean> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [option.frameId || 0] },
    world: 'ISOLATED',
    func: clickZeroRectOptionInPage,
    args: [option.ref],
  });
  return injection?.result === true;
}

function optionNumber(command: ShellCommand, key: string, fallback: number): number {
  const raw = command.options[key];
  if (raw === undefined || raw === true) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}

function optionBoolean(command: ShellCommand, key: string, fallback = false): boolean {
  const raw = command.options[key];
  if (raw === undefined) return fallback;
  if (raw === true || raw === 'true' || raw === '1') return true;
  if (raw === false || raw === 'false' || raw === '0') return false;
  throw new Error(`${key} must be a boolean`);
}

function sanitizeHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (/authorization|cookie|token|secret|password|proxy-authorization/i.test(key)) continue;
    if (typeof value === 'string') headers[key] = value;
  }
  return headers;
}

export function normalizeCapturedRequest(request: any): Record<string, unknown> {
  const status = Number(request.statusCode);
  return {
    method: String(request.method || 'GET').toUpperCase(),
    url: String(request.url || ''),
    headers: sanitizeHeaders(request.specificRequestHeaders),
    ...(request.requestBody !== undefined ? { body: parseCapturedBody(request.requestBody) } : {}),
    ...(Number.isInteger(status) && status > 0 ? { expectStatus: status } : {}),
  };
}

export function capturePublishAllowsConstants(command: ShellCommand): boolean {
  return (
    optionBoolean(command, 'allowConstants') || command.args.slice(1).includes('allowConstants')
  );
}

function parseCapturedBody(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw.slice(0, 10000);
  }
}

function collectScalarPaths(value: unknown, path: string, out: string[]): void {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    out.push(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectScalarPaths(entry, `${path}.${index}`, out));
    return;
  }
  if (value && typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([key, entry]) =>
      collectScalarPaths(entry, path ? `${path}.${key}` : key, out),
    );
  }
}

function setPath(root: unknown, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean);
  let current: any = root;
  for (let index = 0; index < parts.length - 1; index++) {
    const part = /^\d+$/.test(parts[index]) ? Number(parts[index]) : parts[index];
    if (current == null || !(part in current)) throw new Error(`Binding path not found: ${path}`);
    current = current[part];
  }
  const last = /^\d+$/.test(parts.at(-1) || '') ? Number(parts.at(-1)) : parts.at(-1)!;
  if (current == null || !(last in current)) throw new Error(`Binding path not found: ${path}`);
  current[last] = value;
}

function getPath(root: unknown, path: string): unknown {
  return path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((current, part) => {
      if (current == null || typeof current !== 'object') {
        throw new Error(`Binding path not found: ${path}`);
      }
      const key = /^\d+$/.test(part) ? Number(part) : part;
      if (!(key in current)) throw new Error(`Binding path not found: ${path}`);
      return (current as any)[key];
    }, root);
}

function schemaTypeOf(value: unknown): string | string[] {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return typeof value;
  }
  throw new Error(`Operation binding expects a scalar, received ${typeof value}`);
}

export function createCapturedOperationManifest(
  draft: OperationDraft,
  bindings: Record<string, unknown>,
  allowConstants: boolean,
  nameOverride?: string,
): Record<string, unknown> {
  const requests = JSON.parse(JSON.stringify(draft.requests));
  const bound = new Set<string>();
  const propertyTypes = new Map<string, Set<string>>();
  for (const [path, inputNameRaw] of Object.entries(bindings)) {
    const inputName = String(inputNameRaw || '').trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(inputName)) {
      throw new Error(`Invalid operation input name "${inputName}"`);
    }
    const original = getPath({ requests }, path);
    const rawTypes = schemaTypeOf(original);
    const types = Array.isArray(rawTypes) ? rawTypes : [rawTypes];
    const seenTypes = propertyTypes.get(inputName) || new Set<string>();
    types.forEach((type) => seenTypes.add(type));
    propertyTypes.set(inputName, seenTypes);
    setPath(
      { requests },
      path,
      typeof original === 'string' ? `{{${inputName}}}` : { $chromeShellInput: inputName },
    );
    bound.add(path);
  }
  const unbound = draft.scalarPaths.filter((path) => !bound.has(path));
  if (unbound.length && !allowConstants) {
    throw new Error(`Unbound operation values remain: ${unbound.join(', ')}`);
  }
  const name = nameOverride || draft.name;
  const properties = Object.fromEntries(
    [...propertyTypes].map(([inputName, types]) => [
      inputName,
      { type: types.size === 1 ? [...types][0] : [...types] },
    ]),
  );
  return {
    name,
    description: draft.description || `Captured operation ${name}`,
    kind: 'http-sequence',
    inputSchema: {
      type: 'object',
      properties,
      required: Object.keys(properties),
    },
    requests,
    capturedAt: new Date().toISOString(),
  };
}

export function buildHttpSequenceOperationCode(requests: unknown[], input: unknown): string {
  return `
const ARGS = Object.freeze(${JSON.stringify(input ?? {})});
const fill = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.$chromeShellInput === 'string') {
    const out = value.$chromeShellInput.split('.').reduce((v, part) => v == null ? v : v[part], ARGS);
    if (out === undefined) throw new Error('Missing operation input: ' + value.$chromeShellInput);
    return out;
  }
  if (typeof value === 'string') return value.replace(/\\{\\{([a-zA-Z0-9_.-]+)\\}\\}/g, (_, key) => {
    const out = key.split('.').reduce((v, part) => v == null ? v : v[part], ARGS);
    if (out === undefined) throw new Error('Missing operation input: ' + key);
    return String(out);
  });
  if (Array.isArray(value)) return value.map(fill);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, fill(v)]));
  return value;
};
const requests = ${JSON.stringify(requests)};
const results = [];
for (const request of requests) {
  const method = String(request.method || 'GET').toUpperCase();
  const url = fill(request.url);
  const headers = fill(request.headers || {});
  for (const key of Object.keys(headers)) {
    if (/^(authorization|cookie|proxy-authorization)$/i.test(key)) delete headers[key];
  }
  const body = request.body === undefined ? undefined : fill(request.body);
  const response = await fetch(url, {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = raw.slice(0, 1000); }
  if (!response.ok) throw new Error(method + ' ' + url + ' failed: ' + response.status + ' ' + raw.slice(0, 300));
  results.push({ method, url, status: response.status, data });
}
return results;
`;
}

async function readToolText(result: ToolResult): Promise<string> {
  return result.content
    .filter((item: any) => item.type === 'text')
    .map((item: any) => item.text || '')
    .join('\n');
}

export function extractScreenshotArtifacts(result: ToolResult): any[] {
  const artifacts = result.content.filter((item: any) => item.type === 'image');
  for (const item of result.content) {
    if (item.type !== 'text' || !item.text) continue;
    try {
      const parsed = JSON.parse(item.text);
      if (typeof parsed.base64Data === 'string' && parsed.base64Data) {
        artifacts.push({
          type: 'image',
          data: parsed.base64Data,
          mimeType: parsed.mimeType || 'image/png',
        } as any);
      }
    } catch {
      // Ordinary screenshot tool status text is not an encoded artifact.
    }
  }
  return artifacts;
}

export function applySemanticViewFilters(
  state: SemanticPageState,
  view: SemanticViewSpec,
): SemanticPageState {
  if (!view.roleFilter && !view.nameFilter) return state;
  return {
    ...state,
    nodes: state.nodes.filter(
      (node) =>
        (!view.roleFilter || node.role === view.roleFilter) &&
        (!view.nameFilter || node.name?.trim() === view.nameFilter.trim()),
    ),
  };
}

export function syncActionTabContext(
  newTabId: number | undefined,
  runtime: {
    tabId: number;
    lastPage?: SemanticPageState;
    lastView?: unknown;
    pipelineNodes: SemanticNode[];
  },
  context: { tabId: number },
): void {
  if (newTabId == null) return;
  runtime.tabId = newTabId;
  context.tabId = newTabId;
  runtime.lastPage = undefined;
  runtime.lastView = undefined;
  runtime.pipelineNodes = [];
}

export async function pollUntil(
  timeoutMs: number,
  probe: () => Promise<boolean>,
  intervalMs = 50,
): Promise<{ matched: boolean; lastError?: string }> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastError: string | undefined;
  do {
    try {
      if (await probe()) return { matched: true };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  } while (Date.now() <= deadline);
  return { matched: false, lastError };
}

function semanticSignalKey(signals: Awaited<ReturnType<typeof readSemanticPageSignal>>): string {
  return signals
    .map(
      (signal) => `${signal.frameId}:${signal.documentId || ''}:${signal.revision}:${signal.url}`,
    )
    .join('|');
}

export async function ensureSemanticActionBridge(tabId: number, frameId?: number): Promise<void> {
  try {
    const message = { action: 'chrome_read_page_ping' };
    const response =
      typeof frameId === 'number'
        ? await chrome.tabs.sendMessage(tabId, message, { frameId })
        : await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    if (response?.status === 'pong') return;
  } catch {
    // The lightweight action bridge is not installed in this frame yet.
  }
  await chrome.scripting.executeScript({
    target:
      { tabId, frameIds: [frameId ?? 0] },
    world: 'ISOLATED',
    files: ['inject-scripts/accessibility-tree-helper.js'],
  } as any);
}

class ChromeShellTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.EXEC;

  async execute(args: SemanticExecParams): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const program = parseShellProgram(args?.script || '');
      validateShellProgram(program);
      const timeoutMs = Math.max(1, Math.min(Number(args?.timeoutMs) || 30000, MAX_PROGRAM_TIMEOUT_MS));
      if (args?.dryRun) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, program }, null, 2) }],
          isError: false,
        };
      }

      const explicit = await this.tryGetTab(args?.tabId);
      if (args?.tabId !== undefined && !explicit) {
        throw new Error(
          `Explicit target tab ${args.tabId} is unavailable (closed, or a tab chrome-shell cannot access); run "tab list" for current tab IDs`,
        );
      }
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args?.windowId));
      if (!tab.id) return createErrorResponse('Active tab has no ID');
      if (args.expectedUrl !== undefined && args.expectedUrl !== tab.url) throw new Error('STALE_PAGE: target URL changed before execution');
      const vars = asJsonValue(args?.vars || {}) as VariableStore;
      const runtime: RuntimeState = {
        tabId: tab.id,
        startedAt: Date.now(),
        vars,
        pipelineNodes: [],
        records: [],
        lines: [],
        artifacts: [],
        logs: [],
        actionCounter: 0,
        lastSuccess: true,
        workspaceTools: Array.isArray((args as any).__workspaceTools)
          ? ((args as any).__workspaceTools as WorkspaceTool[])
          : [],
        workspaceToolErrors: Array.isArray((args as any).__workspaceToolErrors)
          ? (args as any).__workspaceToolErrors
          : [],
        deferredPrograms: [],
        observationDeltas: [],
        toolDepth: 0,
        learningResults: [],
        failFast: args?.failFast === true,
        startUrl: tab.url,
      };

      let fatalError: string | undefined;
      // Tabs opened by the page (target=_blank, window.open) are otherwise invisible in the delta.
      const openedTabs: number[] = [];
      const onTabCreated = (created: chrome.tabs.Tab) => {
        if (created.id !== undefined && created.openerTabId !== undefined && created.openerTabId === runtime.tabId) {
          openedTabs.push(created.id);
        }
      };
      chrome.tabs.onCreated?.addListener(onTabCreated);
      try {
        await this.executeProgram(program, runtime, timeoutMs);
      } catch (error) {
        fatalError = error instanceof Error ? error.message : String(error);
      } finally {
        chrome.tabs.onCreated?.removeListener(onTabCreated);
        while (runtime.deferredPrograms.length) {
          const cleanup = runtime.deferredPrograms.pop()!;
          try {
            await this.executeProgram(cleanup, runtime, DEFER_BUDGET_MS);
          } catch (error) {
            runtime.logs.push(
              `deferred cleanup failed: ${error instanceof Error ? error.message : error}`,
            );
          }
        }
      }

      await this.finishRuntimeObservation(runtime, Math.min(timeoutMs, 2000));
      for (const tabId of openedTabs) {
        const opened = await chrome.tabs.get(tabId).catch(() => undefined);
        if (opened) runtime.observationDeltas.push(`+tab ${tabId} ${opened.pendingUrl || opened.url || ''} (opened by the page)`);
      }
      const delta = runtime.observationDeltas.join('\n');

      const success =
        fatalError === undefined && runtime.records.every((record) => record.status !== 'failed');
      const mode = args?.output || 'compact';
      let text: string;
      if (mode === 'json') {
        text = JSON.stringify(
          {
            ok: success,
            tabId: runtime.tabId,
            durationMs: Date.now() - startedAt,
            steps: runtime.records,
            state: runtime.lastPage,
            delta,
            error: fatalError,
          },
          null,
          2,
        );
      } else {
        const lines = [
          `${success ? 'ok' : 'failed'} tab=${runtime.tabId} steps=${runtime.records.length} duration=${Date.now() - startedAt}ms`,
          ...runtime.lines,
        ];
        if (delta && !args?.quiet) lines.push(delta);
        if (mode === 'debug' && runtime.logs.length) {
          lines.push('debug:');
          lines.push(...runtime.logs.map((line) => `  ${line}`));
          lines.push(`ast: ${JSON.stringify(program)}`);
        }
        if (fatalError) lines.push(`fatal: ${fatalError}`);
        text = lines.join('\n');
      }

      return {
        content: [{ type: 'text', text }, ...runtime.artifacts],
        isError: !success,
        _meta: {
          chromeShellProtocol: 3,
          chromeShellContext: { url: tab.url, tabId: tab.id },
          ...(runtime.learningResults.length ? { learningResults: runtime.learningResults } : {}),
          ...(runtime.publishRequest ? { chromeCommandWorkspacePublish: runtime.publishRequest } : {}),
        },
      };
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }

  private async startRuntimeObservation(runtime: RuntimeState, tabId: number): Promise<void> {
    if (runtime.observationTabId === tabId) return;
    if (runtime.observationTabId !== undefined) {
      await this.finishRuntimeObservation(runtime, 0);
    }
    try {
      await beginObservation(tabId);
      runtime.observationTabId = tabId;
    } catch (error) {
      runtime.logs.push(
        `observation unavailable on tab ${tabId}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async finishRuntimeObservation(runtime: RuntimeState, settleMs: number): Promise<void> {
    const tabId = runtime.observationTabId;
    if (tabId === undefined) return;
    runtime.observationTabId = undefined;
    try {
      runtime.observationDeltas.push(await collectObservation(tabId, settleMs));
    } catch (error) {
      runtime.logs.push(
        `observation collection failed on tab ${tabId}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async executeProgram(
    program: ShellProgram,
    runtime: RuntimeState,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (const statement of program.statements) {
      if (Date.now() >= deadline) {
        const message = `semantic command timed out after ${timeoutMs}ms`;
        runtime.records.push({
          command: statement.raw,
          status: 'failed',
          detail: message,
          durationMs: 0,
        });
        runtime.lines.push(`error timeout: ${message}`);
        runtime.lastSuccess = false;
        throw new Error(message);
      }
      if (statement.connector === 'and' && !runtime.lastSuccess) continue;
      if (statement.connector === 'or' && runtime.lastSuccess) continue;
      if (statement.connector === 'always' && runtime.failFast && !runtime.lastSuccess) {
        runtime.lines.push(`fail-fast: stopped before line ${statement.line}`);
        return;
      }
      runtime.pipelineNodes = [];
      for (const command of statement.pipeline) {
        const remaining = Math.max(1, deadline - Date.now());
        const controller = new AbortController();
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let result: boolean;
        try {
          result = await Promise.race([
            this.executeCommand(command, runtime, deadline, controller.signal),
            new Promise<boolean>((_, reject) => {
              timeoutId = setTimeout(
                () => reject(new Error(`command "${command.name}" timed out after ${remaining}ms`)),
                remaining,
              );
            }),
          ]);
        } catch (error) {
          controller.abort();
          const message = error instanceof Error ? error.message : String(error);
          runtime.records.push({
            command: command.raw,
            status: 'failed',
            detail: message,
            durationMs: remaining,
          });
          runtime.lines.push(`error ${command.name}: ${message}`);
          runtime.lastSuccess = false;
          throw error;
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
        }
        runtime.lastSuccess = result;
        if (!result) break;
      }
    }
  }

  private async commandNeedsObservation(
    command: ShellCommand,
    runtime: RuntimeState,
  ): Promise<boolean> {
    const isToolCall =
      command.name === 'call' || (command.name === 'tool' && (command.args[0] || 'ls') === 'call');
    if (isToolCall) {
      const name =
        command.name === 'call'
          ? command.args[0] || stringValue(command.options.name, runtime.vars)
          : command.args[1] || stringValue(command.options.name, runtime.vars);
      if (!name) return false;
      const workspace = runtime.workspaceTools.filter((tool) => tool.name === name);
      if (workspace.length === 1) return workspace[0].readOnly !== true;
      if (workspace.length > 1) return true;
      try {
        const pageTools = await listWebMcpTools(runtime.tabId);
        const pageTool = pageTools.find((tool) => tool.name === name);
        return pageTool?.readOnly !== true;
      } catch {
        return true;
      }
    }
    // Tab transitions own their observation lifecycle because the active tab changes.
    if (command.name === 'tab' || command.name === 'window' || command.name === 'dialog') return false;
    return MUTATING_COMMANDS.has(command.name);
  }

  private async executeCommand(
    command: ShellCommand,
    runtime: RuntimeState,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const startedAt = Date.now();
    const remaining = () => Math.max(1, deadline - Date.now());
    const record = (status: StepRecord['status'], detail?: string, extra: RecordExtra = {}): boolean => {
      if (signal?.aborted) return false;
      runtime.records.push({
        command: command.raw,
        status,
        detail,
        ...(extra.value !== undefined ? { value: extra.value } : {}),
        durationMs: Date.now() - startedAt,
      });
      const line = extra.line ?? detail;
      if (status === 'success' && line) runtime.lines.push(line);
      if (status === 'failed') runtime.lines.push(`error ${command.name}: ${line || 'failed'}`);
      for (const warning of extra.warnings || []) runtime.lines.push(`warning ${command.name}: ${warning}`);
      return status === 'success';
    };

    try {
      if (await this.commandNeedsObservation(command, runtime)) {
        await this.startRuntimeObservation(runtime, runtime.tabId);
      }
      if (command.name === 'defer') {
        const block = command.args[0];
        if (!block?.startsWith('{') || !block.endsWith('}')) {
          throw new Error('defer syntax: defer { commands }');
        }
        runtime.deferredPrograms.push(parseShellProgram(block.slice(1, -1)));
        return record('success', 'defer: registered');
      }
      if (command.name === 'inspect' || command.name === 'query') {
        const first = command.args[0];
        const roleFilter = stringValue(command.options.role, runtime.vars);
        const mode = INSPECT_MODES.has(first || '')
          ? (first as any)
          : typeof command.options.mode === 'string' && INSPECT_MODES.has(command.options.mode)
            ? (command.options.mode as any)
            : defaultInspectModeForRole(roleFilter);
        const positional = INSPECT_MODES.has(first || '') ? command.args.slice(1) : command.args;
        const query =
          stringValue(
            command.options.query ?? command.options.text ?? command.options.name,
            runtime.vars,
          ) || (command.name === 'query' ? positional.join(' ') : undefined);
        const scope = resolveSemanticScope(
          stringValue(command.options.scope, runtime.vars),
          runtime.pipelineNodes,
          runtime.lastPage,
        );
        const nameFilter = stringValue(command.options.name, runtime.vars);
        const frame = frameOption(command);
        const view: SemanticViewSpec = {
          options: {
            mode,
            query,
            limit: optionNumber(command, 'limit', 200),
            ...scope,
            ...(frame !== undefined ? { scopeFrameId: frame } : {}),
            ...(roleFilter ? { role: roleFilter } : {}),
            ...(nameFilter !== undefined ? { name: nameFilter } : {}),
            ...(command.options['name~'] !== undefined
              ? { nameContains: stringValue(command.options['name~'], runtime.vars) }
              : {}),
            ...(command.options.css !== undefined
              ? { selector: stringValue(command.options.css, runtime.vars) }
              : {}),
          },
          roleFilter,
          nameFilter,
        };
        let state = applySemanticViewFilters(
          await readSemanticPageState(runtime.tabId, view.options),
          view,
        );
        if (command.options.nth !== undefined) {
          const nth = optionNumber(command, 'nth', 0);
          const node = Number.isInteger(nth) ? state.nodes.at(nth) : undefined;
          if (!node) {
            throw new Error(`nth=${command.options.nth} is outside the ${state.nodes.length} matched node(s)`);
          }
          state = { ...state, nodes: [node] };
        }
        runtime.lastPage = state;
        runtime.lastView = view;
        runtime.pipelineNodes = state.nodes;
        // query asserts presence; inspect only observes.
        if (command.name === 'query' && !state.nodes.length) {
          return record(
            'failed',
            `query matched 0 nodes (${describeLocator(command)}); widen it (name~=, mode=full) or inspect first`,
          );
        }
        return record('success', renderSemanticState(state));
      }

      if (command.name === 'diff') {
        const before = runtime.lastPage;
        if (!before) throw new Error('diff requires an earlier inspect/query in the same program');
        const view: SemanticViewSpec = runtime.lastView || {
          options: { mode: 'interactive', limit: 300 },
        };
        const after = applySemanticViewFilters(
          await readSemanticPageState(runtime.tabId, view.options),
          view,
        );
        const delta = diffSemanticStates(before, after);
        runtime.lastPage = after;
        runtime.pipelineNodes = [...delta.added, ...delta.updated];
        return record('success', renderSemanticDelta(delta));
      }

      if (command.name === 'watch') {
        const timeout = Math.min(
          optionNumber(command, 'timeout', 5000),
          Math.max(1, deadline - Date.now()),
        );
        const view: SemanticViewSpec = runtime.lastView || {
          options: { mode: 'interactive', limit: 300 },
        };
        const baseline =
          runtime.lastPage ||
          applySemanticViewFilters(await readSemanticPageState(runtime.tabId, view.options), view);
        const started = Date.now();
        let lastFullSample = started;
        let signalKey: string | undefined;
        try {
          signalKey = semanticSignalKey(await readSemanticPageSignal(runtime.tabId));
        } catch {
          signalKey = undefined;
        }
        let after = baseline;
        while (Date.now() - started < timeout) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          let changed = signalKey === undefined;
          if (signalKey !== undefined) {
            try {
              changed =
                semanticSignalKey(await readSemanticPageSignal(runtime.tabId)) !== signalKey;
            } catch {
              changed = true;
            }
          }
          // Framework-only changes may not emit a DOM event; sample the full
          // state at a much lower cadence as a correctness fallback.
          if (!changed && Date.now() - lastFullSample < 500) continue;
          after = applySemanticViewFilters(
            await readSemanticPageState(runtime.tabId, view.options),
            view,
          );
          lastFullSample = Date.now();
          if (after.version !== baseline.version) break;
          signalKey = semanticSignalKey(await readSemanticPageSignal(runtime.tabId));
        }
        if (after.version === baseline.version)
          throw new Error(`watch timed out after ${timeout}ms`);
        const delta = diffSemanticStates(baseline, after);
        runtime.lastPage = after;
        runtime.pipelineNodes = [...delta.added, ...delta.updated];
        return record('success', renderSemanticDelta(delta));
      }

      if (command.name === 'set') {
        const assignment = command.args[0];
        const eq = assignment?.indexOf('=') ?? -1;
        if (eq <= 0) throw new Error('set expects $name=value');
        const name = assignment.slice(0, eq).replace(/^\$/, '');
        runtime.vars[name] = asJsonValue(decodeValue(assignment.slice(eq + 1), runtime.vars));
        return record('success', `set $${name}`);
      }

      if (command.name === 'if') {
        const conditionToken = command.args[0];
        const trueBlock = command.args[1];
        const elseIndex = command.args.indexOf('else');
        const falseBlock = elseIndex >= 0 ? command.args[elseIndex + 1] : undefined;
        if (!conditionToken || !trueBlock?.startsWith('{') || !trueBlock.endsWith('}')) {
          throw new Error('if syntax: if $condition { commands } [else { commands }]');
        }
        let passed: boolean;
        if (conditionToken === 'success') passed = runtime.lastSuccess;
        else if (conditionToken === 'failure') passed = !runtime.lastSuccess;
        else passed = Boolean(decodeValue(conditionToken, runtime.vars));
        const block = passed ? trueBlock : falseBlock;
        let blockSucceeded = true;
        if (block) {
          if (!block.startsWith('{') || !block.endsWith('}'))
            throw new Error('if block is malformed');
          await this.executeProgram(
            parseShellProgram(block.slice(1, -1)),
            runtime,
            Math.max(1, deadline - Date.now()),
          );
          blockSucceeded = runtime.lastSuccess;
        }
        return record(blockSucceeded ? 'success' : 'failed', `if: ${passed}`);
      }

      if (command.name === 'for') {
        const variable = String(command.args[0] || '').replace(/^\$/, '');
        if (command.args[1] !== 'in')
          throw new Error('for syntax: for $item in $list { commands }');
        const list = decodeValue(command.args[2], runtime.vars);
        const block = command.args[3];
        if (!variable || !Array.isArray(list) || !block?.startsWith('{') || !block.endsWith('}')) {
          throw new Error('for expects a variable, an array, and a command block');
        }
        if (list.length > 100) throw new Error('for loop exceeds 100 iterations');
        const hadPrevious = variable in runtime.vars;
        const previous = runtime.vars[variable];
        for (const value of list) {
          runtime.vars[variable] = asJsonValue(value);
          await this.executeProgram(
            parseShellProgram(block.slice(1, -1)),
            runtime,
            Math.max(1, deadline - Date.now()),
          );
          if (!runtime.lastSuccess) break;
        }
        if (hadPrevious) runtime.vars[variable] = previous;
        else delete runtime.vars[variable];
        return record(runtime.lastSuccess ? 'success' : 'failed', `for: ${list.length} item(s)`);
      }

      if (command.name === 'tool') {
        const action = command.args[0] || 'ls';
        if (action === 'ls') {
          let pageError: string | undefined;
          const tools = await listWebMcpTools(runtime.tabId).catch((error) => {
            pageError = error instanceof Error ? error.message : String(error);
            return [];
          });
          const all = [
            ...tools,
            ...runtime.workspaceTools.map((tool) => ({
              name: tool.name,
              source: tool.source,
              description: tool.description,
              readOnly: tool.readOnly === true,
            })),
          ];
          const lines = all.map(
            (tool) =>
              `tool ${tool.name} source=${tool.source}${tool.readOnly ? ' readonly' : ''}${describeInputSchema((tool as any).inputSchema)} — ${tool.description || ''}`,
          );
          if (!lines.length) lines.push('tools: none registered');
          if (pageError) lines.push(`page tools unavailable: ${pageError}`);
          for (const skipped of runtime.workspaceToolErrors) {
            lines.push(`skipped ${skipped.file}: ${skipped.reason}`);
          }
          return record('success', lines.join('\n'));
        }
        if (action === 'call') {
          const name = command.args[1] || stringValue(command.options.name, runtime.vars);
          if (!name) throw new Error('tool call expects a tool name');
          const input = command.options.input !== undefined
            ? optionData(command, 'input', runtime.vars)
            : decodeValue(command.args[2] || '{}', runtime.vars);
          const result = await this.callPageTool(runtime, name, input, toolDeadline(command, deadline), optionNumber(command, 'max', DEFAULT_RESULT_BYTES));
          return record('success', `tool ${name}: ${JSON.stringify(result)}`, { value: result });
        }
        throw new Error(`unsupported tool action "${action}"`);
      }

      if (command.name === 'call') {
        const name = command.args[0] || stringValue(command.options.name, runtime.vars);
        if (!name) throw new Error('call expects a WebMCP tool name');
        const input = command.options.input !== undefined
          ? optionData(command, 'input', runtime.vars)
          : decodeValue(command.args[1] || '{}', runtime.vars);
        const result = await this.callPageTool(runtime, name, input, toolDeadline(command, deadline), optionNumber(command, 'max', DEFAULT_RESULT_BYTES));
        return record('success', `tool ${name}: ${JSON.stringify(result)}`, { value: result });
      }

      const { createSemanticActionRegistry } =
        await import('@/entrypoints/background/semantic-actions');
      const registry = createSemanticActionRegistry();
      const ctx: ActionExecutionContext = {
        vars: runtime.vars,
        tabId: runtime.tabId,
        log: (message, level = 'info') => runtime.logs.push(`${level}: ${message}`),
        pushLog: (entry) => runtime.logs.push(JSON.stringify(entry)),
        execution: { skipNavWait: true },
        signal,
      };
      const executeAction = async (action: ExecutableAction) => {
        const params = action.params as any;
        for (const target of [params?.target, params?.start, params?.end]) {
          // A ref carried over from an earlier invocation has no frame; find the frame that owns it.
          if (target?.ref && target.frameId === undefined) {
            const frameId = await locateRefFrame(runtime.tabId, target.ref);
            if (frameId) target.frameId = frameId;
          }
        }
        const frameIds = [params?.target, params?.start, params?.end]
          .map((target) => Number(target?.frameId))
          .filter((frameId) => Number.isInteger(frameId));
        const distinctFrameIds = [...new Set(frameIds)];
        if (distinctFrameIds.length > 1) {
          return {
            status: 'failed' as const,
            error: {
              code: 'VALIDATION_ERROR' as const,
              message: 'One action cannot target elements from different frames',
            },
          };
        }
        const actionContext = distinctFrameIds.length
          ? { ...ctx, frameId: distinctFrameIds[0] }
          : ctx;
        if ([params?.target, params?.start, params?.end].some(Boolean)) {
          await ensureSemanticActionBridge(runtime.tabId, actionContext.frameId);
        }
        return await registry.execute(actionContext, action as any);
      };
      const run = async (action: ExecutableAction): Promise<boolean> => {
        const result = await executeAction(action);
        syncActionTabContext(result.newTabId, runtime, ctx);
        if (result.status === 'failed')
          return record('failed', result.error?.message || 'action failed');
        return record(result.status === 'skipped' ? 'skipped' : 'success', `${command.name}: ok`);
      };
      const id = () => `shell_${++runtime.actionCounter}`;
      const pickCustomOption = async (
        target: ElementTarget,
        value: string,
      ): Promise<string | undefined> => {
        const opened = await executeAction({
          id: id(),
          type: 'click',
          params: { target },
        } as any);
        if (opened.status === 'failed') return opened.error?.message || 'failed to open select';

        let optionState: SemanticPageState | undefined;
        let options: SemanticNode[] = [];
        await pollUntil(
          // Remote option lists load after opening; wait for them within the program deadline.
          Math.min(optionNumber(command, 'timeout', 5000), remaining()),
          async () => {
            optionState = await readSemanticPageState(runtime.tabId, {
              mode: 'interactive',
              query: value,
              limit: 50,
              includeAdapters: false,
            });
            options = matchExactSelectOptions(optionState.nodes, value);
            return options.length > 0;
          },
          50,
        );
        if (options.length !== 1) {
          if (!optionState || options.length === 0) {
            optionState = await readSemanticPageState(runtime.tabId, {
              mode: 'interactive',
              limit: 50,
              includeAdapters: false,
            });
          }
          const candidates = optionState.nodes
            .filter((node) => ['option', 'menuitem', 'radio'].includes(node.role))
            .slice(0, 5)
            .map((node) => node.value || node.name)
            .filter(Boolean)
            .join(', ');
          return `option "${value}" matched ${options.length} exact semantic nodes; expected exactly one${candidates ? `; candidates: ${candidates}` : ''}`;
        }
        const picked = await executeAction({
          id: id(),
          type: 'click',
          params: {
            target: targetFrom(
              { name: 'click', args: [], options: {}, raw: `click option ${value}` },
              options,
              runtime.vars,
            ),
          },
        } as any);
        if (picked.status !== 'failed') return undefined;
        const message = picked.error?.message || 'failed to pick option';
        if (
          message === 'Target element is not visible' &&
          (await clickZeroRectOption(runtime.tabId, options[0]))
        ) {
          return undefined;
        }
        return message;
      };

      const resolveNamedTarget = async (): Promise<ElementTarget> => {
        const name = stringValue(command.options.name, runtime.vars);
        const hasExplicitLocator = command.options.ref || command.options.css || command.options.xpath
          || (command.args[0] && /^@?ref_\d+$/.test(command.args[0]));
        if (!name || hasExplicitLocator || runtime.pipelineNodes.length) {
          return targetFrom(command, runtime.pipelineNodes, runtime.vars);
        }
        const role = stringValue(command.options.role, runtime.vars);
        runtime.lastView = { options: { mode: 'interactive', query: name, limit: 100 }, roleFilter: role, nameFilter: name };
        runtime.lastPage = await readSemanticPageState(runtime.tabId, runtime.lastView.options);
        let matches = matchExactSemanticTarget(runtime.lastPage.nodes, role, name);
        if (command.options.frame !== undefined) {
          const frame = Number(command.options.frame);
          if (!Number.isInteger(frame) || frame < 0) throw new Error('frame must be a non-negative integer');
          matches = matches.filter((node) => (node.frameId || 0) === frame);
        }
        if (matches.length !== 1) throw new Error(`${command.name} target ${role || '*'} "${name}" matched ${matches.length} exact semantic nodes; expected exactly one`);
        return targetFrom(command, matches, runtime.vars);
      };

      if (command.name === 'click' || command.name === 'dblclick') {
        return await run({
          id: id(),
          type: command.name,
          params: { target: await resolveNamedTarget() },
          policy: { timeout: { ms: Math.min(remaining(), 30000) } },
        } as ExecutableAction);
      }
      if (command.name === 'select') {
        const refArg = command.args[0] && /^@?ref_\d+$/.test(command.args[0]);
        const explicitRef = refArg
          ? stripRef(command.args[0])
          : stringValue(command.options.ref, runtime.vars);
        const rawValue =
          command.options.value ??
          (refArg ? command.args[1] : command.args.length > 1 ? command.args[1] : command.args[0]);
        const value = stringValue(rawValue, runtime.vars);
        if (value === undefined) throw new Error('select expects a value');
        let targetNodes = runtime.pipelineNodes;
        const explicitName = stringValue(command.options.name, runtime.vars);
        if (!explicitRef && targetNodes.length !== 1 && explicitName) {
          const explicitRole = stringValue(command.options.role, runtime.vars);
          runtime.lastView = {
            options: { mode: 'forms', query: explicitName, limit: 100 },
            roleFilter: explicitRole,
            nameFilter: explicitName,
          };
          runtime.lastPage = await readSemanticPageState(runtime.tabId, runtime.lastView.options);
          targetNodes = matchExactSemanticTarget(
            runtime.lastPage.nodes,
            explicitRole,
            explicitName,
          );
          if (targetNodes.length !== 1) {
            return record(
              'failed',
              `select target ${explicitRole || '*'} "${explicitName}" matched ${targetNodes.length} exact semantic nodes; expected exactly one`,
            );
          }
        }
        const target = targetFrom(command, targetNodes, runtime.vars);
        let selectedNode =
          targetNodes.length === 1
            ? targetNodes[0]
            : runtime.lastPage?.nodes.find((node) =>
                explicitRef
                  ? node.ref === stripRef(explicitRef)
                  : node.name &&
                    typeof command.options.name === 'string' &&
                    node.name.trim() === command.options.name.trim(),
              );
        if (!selectedNode && explicitRef) {
          // A ref from an earlier invocation: read just that node to learn whether it is a native select.
          const scoped = await readSemanticPageState(runtime.tabId, {
            mode: 'forms',
            scopeRef: stripRef(explicitRef),
            limit: 1,
            includeAdapters: false,
            ...((target as { frameId?: number }).frameId !== undefined ? { scopeFrameId: (target as { frameId?: number }).frameId } : {}),
          }).catch(() => undefined);
          selectedNode = scoped?.nodes.find((node) => node.ref === stripRef(explicitRef));
        }
        if (selectedNode?.kind === 'select') {
          return await run({
            id: id(),
            type: 'fill',
            params: { target, value },
          } as ExecutableAction);
        }
        const selectError = await pickCustomOption(target, value);
        if (selectError) return record('failed', `select ${selectError}`);
        return record('success', `select: ${value}`);
      }
      if (command.name === 'fill' || command.name === 'check') {
        const target = await resolveNamedTarget();
        const refArg = command.args[0] && /^@?ref_\d+$/.test(command.args[0]);
        const rawValue =
          command.options.value ??
          (refArg ? command.args[1] : command.args.length > 1 ? command.args[1] : command.args[0]);
        const value =
          command.name === 'check'
            ? stringValue(rawValue ?? 'true', runtime.vars) || 'true'
            : stringValue(rawValue, runtime.vars);
        if (value === undefined) throw new Error(`${command.name} expects a value`);
        if (!(await run({ id: id(), type: 'fill', params: { target, value } } as ExecutableAction))) return false;
        const ref = (target as { ref?: string }).ref;
        if (ref) runtime.lastInput = { ref, frameId: (target as { frameId?: number }).frameId };
        if (command.name === 'fill' && optionBoolean(command, 'submit')) {
          if (!ref) throw new Error('fill submit=true needs a ref or piped target to press Enter in');
          await this.focusRef(runtime.tabId, ref, (target as { frameId?: number }).frameId, false);
          const { pressKeys } = await import('./semantic-input');
          await pressKeys(runtime.tabId, 'Enter');
          runtime.lines.push('fill: submitted with Enter');
        }
        return true;
      }
      if (command.name === 'fillform') {
        const entries = Object.entries(command.options);
        if (!entries.length) throw new Error('fillform expects name=value pairs');
        if (!runtime.lastPage) {
          runtime.lastView = { options: { mode: 'forms', limit: 300 } };
          runtime.lastPage = await readSemanticPageState(runtime.tabId, runtime.lastView.options);
        }
        for (const [name, raw] of entries) {
          let target: ElementTarget;
          let matchedNode: SemanticNode | undefined;
          if (/^@?ref_\d+$/.test(name)) target = { ref: stripRef(name) };
          else {
            const matches = runtime.lastPage.nodes.filter(
              (node) => node.name?.trim() === name.trim(),
            );
            matchedNode = matches.length === 1 ? matches[0] : undefined;
            target =
              matches.length === 1
                ? targetFrom(
                    { name: 'fill', args: [], options: {}, raw: `fill ${name}` },
                    matches,
                    runtime.vars,
                  )
                : {
                    candidates: [
                      { type: 'aria', name },
                      { type: 'text', text: name, match: 'exact' },
                    ],
                  };
          }
          const value = stringValue(raw, runtime.vars);
          if (value === undefined) throw new Error(`fillform value for ${name} is missing`);
          if (matchedNode?.role === 'combobox' && matchedNode.kind !== 'select') {
            const selectError = await pickCustomOption(target, value);
            if (selectError) return record('failed', `${name}: ${selectError}`);
            continue;
          }
          const result = await executeAction({
            id: id(),
            type: 'fill',
            params: { target, value },
          } as any);
          if (result.status === 'failed')
            return record('failed', `${name}: ${result.error?.message}`);
        }
        return record('success', `fillform: ${entries.length} fields`);
      }
      if (command.name === 'key') {
        const keys = stringValue(command.options.keys || command.args[0], runtime.vars);
        if (!keys) throw new Error('key expects keys');
        const located = command.args[1] || TARGET_OPTION_KEYS.some((key) => command.options[key] !== undefined) || runtime.pipelineNodes.length === 1
          ? await this.resolveTargetNode({ ...command, args: command.args.slice(1) }, runtime)
          : runtime.lastInput;
        try {
          if (located?.ref) await this.focusRef(runtime.tabId, located.ref, located.frameId, false);
          const { pressKeys } = await import('./semantic-input');
          await pressKeys(runtime.tabId, keys);
          return record('success', `key ${keys}${located?.ref ? ` -> ${located.ref}` : ''}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/STALE_REF|cannot take keyboard focus|unknown (key|modifier)/.test(message)) throw error;
          // CDP unavailable: synthetic events still drive page key handlers (but cannot type text).
          runtime.logs.push(`key: CDP input failed (${message}); using synthetic events`);
          const target = located?.ref ? ({ ref: located.ref, ...(located.frameId !== undefined ? { frameId: located.frameId } : {}) } as ElementTarget) : undefined;
          return await run({ id: id(), type: 'key', params: { keys, target } } as ExecutableAction);
        }
      }
      if (command.name === 'type') {
        const refArg = command.args[0] && /^@?ref_\d+$/.test(command.args[0]);
        const text = stringValue(command.options.value ?? (refArg ? command.args[1] : command.args[0]), runtime.vars);
        if (text === undefined) throw new Error('type expects text: type @ref "text" or type value="text"');
        const hasTarget = refArg || TARGET_OPTION_KEYS.some((key) => command.options[key] !== undefined) || runtime.pipelineNodes.length === 1;
        const located = hasTarget
          ? await this.resolveTargetNode(refArg ? command : { ...command, args: [] }, runtime)
          : runtime.lastInput;
        if (located?.ref) await this.focusRef(runtime.tabId, located.ref, located.frameId, false);
        const { insertText, pressKeys } = await import('./semantic-input');
        await insertText(runtime.tabId, text);
        if (located?.ref) runtime.lastInput = { ref: located.ref, frameId: located.frameId };
        if (optionBoolean(command, 'submit')) await pressKeys(runtime.tabId, 'Enter');
        return record('success', `type: ${text.length} char(s)${located?.ref ? ` -> ${located.ref}` : ' -> focused element'}`);
      }
      if (command.name === 'navigate') {
        const url = stringValue(command.options.url || command.args[0], runtime.vars);
        if (!url) throw new Error('navigate expects a URL');
        const errors = watchNavigationErrors(runtime.tabId);
        try {
          if (!(await run({ id: id(), type: 'navigate', params: { url } } as ExecutableAction))) return false;
          // The navigate action returns once the load starts; wait for its outcome so a DNS or
          // connection failure is reported here instead of surfacing as a missing element later.
          const settleMs = Math.min(optionNumber(command, 'timeout', 10000), remaining());
          const settled = await pollUntil(settleMs, async () => {
            if (errors.failed()) return true;
            const tab = await chrome.tabs.get(runtime.tabId);
            return tab.status === 'complete';
          }, 100);
          const failure = await errors.result();
          if (failure) {
            runtime.lines.pop();
            runtime.records.pop();
            return record('failed', `navigation to ${url} failed: ${failure} (Chrome shows its error page)`);
          }
          if (!settled.matched) runtime.lines.push(`warning navigate: ${url} still loading after ${settleMs}ms`);
          return true;
        } finally {
          errors.stop();
        }
      }
      if (command.name === 'back' || command.name === 'forward' || command.name === 'reload') {
        const { navigateTool } = await import('./common');
        const result = await navigateTool.execute({
          url: command.name === 'reload' ? undefined : command.name,
          refresh: command.name === 'reload',
          tabId: runtime.tabId,
        });
        if (result.isError) return record('failed', await readToolText(result));
        return record('success', `${command.name}: ok`);
      }
      if (command.name === 'tab' || command.name === 'window') {
        const action = command.args[0] || 'list';
        if (action === 'list' || command.name === 'window') {
          const { windowTool } = await import('./window');
          const result = await windowTool.execute();
          const text = await readToolText(result);
          if (result.isError) return record('failed', text);
          const listing = JSON.parse(text) as TabListing;
          const match = stringValue(command.options.match, runtime.vars);
          return record('success', text, { line: renderTabList(listing, match), value: listing });
        }
        if (action === 'new') {
          await this.finishRuntimeObservation(runtime, 0);
          const url = stringValue(command.args[1] || command.options.url, runtime.vars);
          const loadTimeoutMs = Math.min(optionNumber(command, 'timeout', 30000), remaining());
          const result = await executeAction({
            id: id(),
            type: 'openTab',
            params: { url, active: optionBoolean(command, 'active', true), loadTimeoutMs },
            policy: { timeout: { ms: Math.min(remaining(), loadTimeoutMs + 1000), scope: 'action' } },
          } as ExecutableAction);
          syncActionTabContext(result.newTabId, runtime, ctx);
          if (result.status === 'failed') return record('failed', result.error?.message || 'tab new failed');
          const warning = (result.output as { warning?: string } | undefined)?.warning;
          return record('success', `tab new: ${runtime.tabId}${url ? ` ${url}` : ''}`, {
            value: { tabId: runtime.tabId },
            warnings: warning ? [warning] : [],
          });
        }
        if (action === 'switch') {
          const targetId = Number(command.args[1] || command.options.id);
          if (!Number.isInteger(targetId)) throw new Error('tab switch expects a numeric tab ID');
          await this.finishRuntimeObservation(runtime, 0);
          const success = await run({
            id: id(),
            type: 'switchTab',
            params: { tabId: targetId },
          } as ExecutableAction);
          return success;
        }
        if (action === 'close') {
          const targetId = Number(command.args[1] || command.options.id || runtime.tabId);
          if (!Number.isInteger(targetId)) throw new Error('tab close expects a numeric tab ID');
          if (targetId === runtime.tabId) {
            await this.finishRuntimeObservation(runtime, 0);
          }
          return await run({
            id: id(),
            type: 'closeTab',
            params: { tabIds: [targetId] },
          } as ExecutableAction);
        }
        throw new Error(`unsupported tab action "${action}"`);
      }
      if (command.name === 'wait') {
        if (command.options.text) {
          const expected = stringValue(command.options.text, runtime.vars);
          if (!expected) throw new Error('wait text expects a non-empty value');
          const timeout = Math.min(optionNumber(command, 'timeout', 10000), remaining());
          const outcome = await pollUntil(timeout, async () => {
            const results = (await chrome.scripting.executeScript({
              target: { tabId: runtime.tabId },
              world: 'ISOLATED',
              func: (text: string) => (document.body?.innerText || '').includes(text) || document.title.includes(text),
              args: [expected],
            } as any)) as Array<{ result?: boolean }>;
            return results?.[0]?.result === true;
          });
          if (!outcome.matched) {
            const transient = outcome.lastError
              ? `; last transient error: ${outcome.lastError}`
              : '';
            return record(
              'failed',
              `Text "${expected}" did not appear within ${timeout}ms${transient}`,
            );
          }
          return record('success', `wait text: ${JSON.stringify(expected)}`);
        }
        let condition: any;
        if (command.options.url !== undefined || command.options['url~'] !== undefined) {
          const exact = stringValue(command.options.url, runtime.vars);
          const part = stringValue(command.options['url~'], runtime.vars);
          const timeout = Math.min(optionNumber(command, 'timeout', 10000), remaining());
          let current = '';
          const outcome = await pollUntil(timeout, async () => {
            const tab = await chrome.tabs.get(runtime.tabId);
            current = tab.pendingUrl || tab.url || '';
            return exact !== undefined ? current === exact : current.includes(part || '');
          }, 100);
          if (!outcome.matched) {
            return record('failed', `URL did not ${exact !== undefined ? `become ${exact}` : `contain ${JSON.stringify(part)}`} within ${timeout}ms; now ${current}`);
          }
          return record('success', `wait url: ${current}`);
        }
        if (command.options.selector) {
          const selector = stringValue(command.options.selector, runtime.vars);
          if (!selector) throw new Error('wait selector expects a non-empty value');
          const timeout = Math.min(optionNumber(command, 'timeout', 10000), remaining());
          const frameId = optionNumber(command, 'frame', 0);
          if (!Number.isInteger(frameId) || frameId < 0) throw new Error('frame must be a non-negative integer');
          const state = stringValue(command.options.state, runtime.vars) || 'visible';
          if (!['visible', 'attached', 'detached'].includes(state)) throw new Error('wait state must be visible, attached, or detached');
          let invalidSelector: string | undefined;
          const outcome = await pollUntil(timeout, async () => {
            const results = await chrome.scripting.executeScript({
              target: { tabId: runtime.tabId, frameIds: [frameId] },
              world: 'ISOLATED',
              func: (value: string, wanted: string) => {
                try {
                  const elements = Array.from(document.querySelectorAll(value));
                  if (wanted === 'attached') return { matched: elements.length > 0 };
                  if (wanted === 'detached') return { matched: elements.length === 0 };
                  // Any match counts: a hidden first match must not mask a visible later one.
                  return {
                    matched: elements.some((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'),
                  };
                } catch (error) {
                  return { matched: false, error: error instanceof Error ? error.message : String(error) };
                }
              },
              args: [selector, state],
            });
            invalidSelector = results[0]?.result?.error;
            return Boolean(invalidSelector || results[0]?.result?.matched);
          }, 50);
          if (invalidSelector) throw new Error(`Invalid wait selector: ${invalidSelector}`);
          if (!outcome.matched) {
            const hint = state === 'visible' ? ' (use state=attached for inputs hidden by rich editors)' : '';
            return record('failed', `Selector did not become ${state} within ${timeout}ms${hint}${outcome.lastError ? `; ${outcome.lastError}` : ''}`);
          }
          return record('success', `wait selector: ${selector}`);
        } else if (command.args[0] === 'navigation') {
          const timeout = Math.min(optionNumber(command, 'timeout', 15000), remaining());
          // Without an inspected baseline, compare with the URL the program started on and accept a
          // completed reload observed during the wait; never succeed on an unchanged settled page.
          const beforeUrl = runtime.lastPage?.url ?? runtime.startUrl;
          const beforeVersion = runtime.lastPage?.version;
          let sawLoading = false;
          const outcome = await pollUntil(timeout, async () => {
            const tab = await chrome.tabs.get(runtime.tabId);
            if (tab.status !== 'complete') {
              sawLoading = true;
              return false;
            }
            if (sawLoading) return true;
            if (beforeUrl && tab.url && tab.url !== beforeUrl) return true;
            const state = await readSemanticPageState(runtime.tabId, {
              mode: 'interactive',
              limit: 1,
              includeAdapters: false,
            });
            return beforeVersion !== undefined && state.version !== beforeVersion;
          });
          if (!outcome.matched) {
            return record(
              'failed',
              `navigation did not complete on tab ${runtime.tabId} within ${timeout}ms`,
            );
          }
          return record('success', `wait navigation: tab ${runtime.tabId}`);
        } else if (command.args[0] === 'network') {
          const timeout = Math.min(optionNumber(command, 'timeout', 10000), remaining());
          await this.startRuntimeObservation(runtime, runtime.tabId);
          try {
            await waitForApiIdle(runtime.tabId, timeout);
            return record('success', `wait network: tab ${runtime.tabId}`);
          } catch (error) {
            return record('failed', error instanceof Error ? error.message : String(error));
          }
        } else condition = { kind: 'sleep', sleep: Number(command.args[0] || 0) };
        return await run({ id: id(), type: 'wait', params: { condition } } as ExecutableAction);
      }
      if (command.name === 'assert') {
        let assertion: any;
        if (command.options.text) {
          assertion = { kind: 'textPresent', text: stringValue(command.options.text, runtime.vars) };
        } else if (command.options.visible) {
          assertion = { kind: 'visible', selector: stringValue(command.options.visible, runtime.vars) };
        } else if (command.options.exists) {
          assertion = { kind: 'exists', selector: stringValue(command.options.exists, runtime.vars) };
        } else throw new Error('assert expects text=, visible=, or exists=');
        return await run({
          id: id(),
          type: 'assert',
          params: { assert: assertion },
        } as ExecutableAction);
      }
      if (command.name === 'scroll') {
        const first = command.args[0];
        const direction = first && SCROLL_DIRECTIONS.has(first) ? first : undefined;
        const hasTarget =
          ['ref', 'css', 'xpath', 'role', 'name', 'name~', 'text'].some((key) => command.options[key] !== undefined) ||
          (!!first && !direction) ||
          (!direction && runtime.pipelineNodes.length === 1);
        if (!direction && !hasTarget) {
          throw new Error('scroll expects up|down|left|right [pixels], top|bottom, or a target to bring into view');
        }
        const amount = Number(command.args[1] || command.options.amount || 500);
        if (direction && ['up', 'down', 'left', 'right'].includes(direction) && (!Number.isFinite(amount) || amount <= 0)) {
          throw new Error('scroll distance must be a positive pixel amount');
        }
        const target = hasTarget ? await this.resolveTargetNode(command, runtime) : undefined;
        const container = direction && runtime.pipelineNodes.length === 1 ? runtime.pipelineNodes[0] : undefined;
        // In-page scrolling works in background tabs, where CDP wheel input never completes.
        const [frame] = await chrome.scripting.executeScript({
          target: { tabId: runtime.tabId, frameIds: [target?.frameId ?? container?.frameId ?? 0] },
          world: 'ISOLATED',
          func: scrollInPage,
          args: [{ ref: target?.ref, containerRef: container?.ref, direction, amount }],
        });
        const outcome = frame?.result as ReturnType<typeof scrollInPage> | undefined;
        if (!outcome) throw new Error('scroll: the frame returned no result');
        if (!outcome.ok) return record('failed', outcome.error);
        return record('success', `scroll: ${outcome.detail}`);
      }
      if (command.name === 'hover') {
        const { ref, frameId } = await this.resolveTargetNode(command, runtime);
        await ensureSemanticActionBridge(runtime.tabId, frameId);
        const { computerTool } = await import('./computer');
        const result = await computerTool.execute({
          action: 'hover',
          ref,
          frameId,
          tabId: runtime.tabId,
        } as any);
        if (result.isError) return record('failed', await readToolText(result));
        return record('success', `hover ${ref}`);
      }
      if (command.name === 'drag') {
        const startRef = stripRef(command.args[0] || String(command.options.start || ''));
        const endRef = stripRef(command.args[1] || String(command.options.end || ''));
        if (!startRef || !endRef) throw new Error('drag expects start and end refs');
        const targetForRef = (ref: string): ElementTarget => {
          const node = runtime.lastPage?.nodes.find((candidate) => candidate.ref === ref);
          return targetFrom(
            {
              name: 'drag',
              args: [`@${ref}`],
              options: command.options.frame ? { frame: command.options.frame } : {},
              raw: command.raw,
            },
            node ? [node] : [],
            runtime.vars,
          );
        };
        return await run({
          id: id(),
          type: 'drag',
          params: { start: targetForRef(startRef), end: targetForRef(endRef) },
        } as ExecutableAction);
      }
      if (command.name === 'upload') {
        const rawFiles = command.options.file !== undefined
          ? optionData(command, 'file', runtime.vars)
          : decodeValue(command.args[1], runtime.vars);
        const filePaths = (Array.isArray(rawFiles) ? rawFiles : [rawFiles]).filter(
          (file): file is string => typeof file === 'string' && file.length > 0,
        );
        if (!filePaths.length) throw new Error('upload expects file=PATH or file=["a","b"]');
        const css = stringValue(command.options.css, runtime.vars);
        const target = css
          ? { selector: css, frameId: frameOption(command) }
          : await this.resolveTargetNode(command, runtime);
        let selector = 'selector' in target ? target.selector : undefined;
        const token = `upload_${Date.now().toString(36)}`;
        if (!selector && target.ref) {
          const [marked] = await chrome.scripting.executeScript({
            target: { tabId: runtime.tabId, frameIds: [target.frameId ?? 0] },
            world: 'ISOLATED',
            func: (ref: string, mark: string) => {
              const el = (window as any).__chromeShellElementMap?.[ref]?.deref?.();
              if (!(el instanceof Element)) return false;
              el.setAttribute('data-chrome-shell-upload', mark);
              return true;
            },
            args: [target.ref, token],
          });
          if (marked?.result !== true) throw new Error(`STALE_REF: ${target.ref} is no longer live; inspect again`);
          selector = `[data-chrome-shell-upload="${token}"]`;
        }
        const { fileUploadTool } = await import('./file-upload');
        const result = await fileUploadTool.execute({
          selector: selector!,
          filePaths,
          frameId: target.frameId,
          tabId: runtime.tabId,
        });
        if (result.isError) return record('failed', await readToolText(result));
        return record('success', `upload: ${filePaths.length} file(s) -> ${target.ref || selector}`);
      }
      if (command.name === 'screenshot') {
        const hasTarget =
          ['ref', 'css', 'xpath', 'role', 'name', 'name~', 'text'].some((key) => command.options[key] !== undefined) ||
          Boolean(command.args[0]) ||
          runtime.pipelineNodes.length === 1;
        const full = optionBoolean(command, 'full');
        if (full && hasTarget) throw new Error('screenshot takes either a target or full=true, not both');
        const target = hasTarget ? await this.resolveTargetNode(command, runtime) : undefined;
        const { captureSemanticScreenshot } = await import('./semantic-screenshot');
        const shot = await captureSemanticScreenshot({
          tabId: runtime.tabId,
          ref: target?.ref,
          frameId: target?.frameId,
          full,
          timeoutMs: remaining(),
        });
        runtime.artifacts.push({ type: 'image', data: shot.data, mimeType: shot.mimeType });
        const notes = [
          `${shot.width}x${shot.height}`,
          target?.ref ? `element ${target.ref}` : full ? 'full page' : 'viewport',
          ...(shot.activated ? ['tab briefly activated to render'] : []),
        ];
        return record('success', `screenshot: ${notes.join(', ')}`, {
          warnings: shot.clipped ? ['full page taller than 16384px; captured the top part'] : [],
        });
      }
      if (command.name === 'console') {
        const { consoleTool } = await import('./console');
        const result = await consoleTool.execute({
          mode: command.args[0] || 'buffer',
          onlyErrors: optionBoolean(command, 'errors'),
          tabId: runtime.tabId,
        } as any);
        if (result.isError) return record('failed', await readToolText(result));
        return record('success', await readToolText(result));
      }
      if (command.name === 'network') {
        const { networkCaptureTool } = await import('./network-capture');
        const action = command.args[0] || 'stop';
        const urlFilter = stringValue(command.options.url, runtime.vars);
        const result = await networkCaptureTool.execute({
          action,
          url: urlFilter,
          needResponseBody: optionBoolean(command, 'body'),
          tabId: runtime.tabId,
        } as any);
        const text = await readToolText(result);
        if (result.isError) return record('failed', text);
        if (action !== 'stop') return record('success', `network ${action}: ok`);
        const summary = summarizeNetworkCapture(text, urlFilter, optionNumber(command, 'limit', 50));
        return record('success', text, { line: summary.line, value: summary.requests });
      }
      if (command.name === 'capture') {
        const action = command.args[0] || 'begin';
        const { networkCaptureTool } = await import('./network-capture');
        if (action === 'begin') {
          const tab = await chrome.tabs.get(runtime.tabId);
          const result = await networkCaptureTool.execute({
            action: 'start',
            tabId: runtime.tabId,
            needResponseBody: optionBoolean(command, 'body'),
            url: tab.url,
            includeStatic: false,
            maxCaptureTime: Math.min(remaining(), 120000),
          });
          if (result.isError) return record('failed', await readToolText(result));
          return record('success', 'capture: started');
        }
        if (action === 'end') {
          const result = await networkCaptureTool.execute({
            action: 'stop',
            tabId: runtime.tabId,
            commonHeaders: 'omit',
          });
          if (result.isError) return record('failed', await readToolText(result));
          const raw = await readToolText(result);
          const capture = JSON.parse(raw) as any;
          const capturedRequests = Array.isArray(capture.requests) ? capture.requests : [];
          if (capturedRequests.some((request: any) => request.requestBodyUnavailable)) throw new Error('Capture contains a non-text/oversized request body; cannot publish a replay');
          const requests = capturedRequests
            .filter((request: any) =>
              ['xhr', 'fetch', 'xmlhttprequest'].includes(String(request.type || '').toLowerCase()),
            )
            .map(normalizeCapturedRequest)
            .filter((request: any) => request.url);
          if (!requests.length) throw new Error('capture produced no XHR/fetch requests');
          const scalarPaths: string[] = [];
          requests.forEach((request: Record<string, unknown>, index: number) => {
            collectScalarPaths(request.url, `requests.${index}.url`, scalarPaths);
            if ('body' in request)
              collectScalarPaths(request.body, `requests.${index}.body`, scalarPaths);
          });
          const description =
            typeof command.options.description === 'string'
              ? command.options.description
              : undefined;
          runtime.captureDraft = createOperationDraft(
            String(command.options.name || 'captured_operation'),
            description,
            requests,
            scalarPaths,
          );
          runtime.vars.capture = asJsonValue(runtime.captureDraft);
          return record(
            'success',
            `capture: ${requests.length} request(s); bind before publish: ${scalarPaths.join(', ')}`,
          );
        }
        if (action === 'publish') {
          const draft = runtime.captureDraft;
          if (!draft)
            throw new Error('capture publish requires capture end in the same semantic program');
          const bindingsRaw = command.options.bindings !== undefined
            ? optionData(command, 'bindings', runtime.vars)
            : {};
          if (!bindingsRaw || typeof bindingsRaw !== 'object' || Array.isArray(bindingsRaw)) {
            throw new Error('capture publish bindings must be a JSON object of path -> inputName');
          }
          const name = String(command.options.name || draft.name);
          const manifest = createCapturedOperationManifest(
            draft,
            bindingsRaw as Record<string, unknown>,
            capturePublishAllowsConstants(command),
            name,
          );
          runtime.publishRequest = { name, manifest };
          return record('success', `capture: publish ${name}`);
        }
        throw new Error(`unsupported capture action "${action}"`);
      }
      if (command.name === 'dialog') {
        const { handleDialogTool } = await import('./dialog');
        const result = await handleDialogTool.execute({
          action: command.args[0] || 'accept',
          promptText: command.options.text,
          tabId: runtime.tabId,
        } as any);
        if (result.isError) return record('failed', await readToolText(result));
        return record('success', `dialog ${command.args[0] || 'accept'}`);
      }
      if (command.name === 'download') {
        const { handleDownloadTool } = await import('./download');
        const requested = optionNumber(command, 'timeout', Math.min(remaining(), 30000));
        if (requested > remaining()) {
          throw new Error(`download timeout=${requested} exceeds the ${remaining()}ms left in the program; raise --timeout`);
        }
        const result = await handleDownloadTool.execute({
          timeoutMs: requested,
          startedAfter: new Date(runtime.records.some((step) => step.status === 'success' && MUTATING_COMMANDS.has(step.command.split(/\s+/, 1)[0]))
            ? runtime.startedAt : Date.now() - 60000).toISOString(),
          pageUrl: (await chrome.tabs.get(runtime.tabId)).url,
          filenameContains: stringValue(command.options.filename, runtime.vars),
        } as any);
        if (result.isError) return record('failed', await readToolText(result));
        return record('success', await readToolText(result));
      }
      if (command.name === 'js') {
        if (command.options.file !== undefined) {
          throw new Error('js file= is inlined by the chrome-shell CLI; HTTP callers must send code=');
        }
        if (command.options.code === undefined && command.args.length > 1) {
          throw new Error(
            `js takes one code argument but got ${command.args.length}; quote the code (js "...") or use code="..." (a .chrome file or --vars-file avoids shell quoting)`,
          );
        }
        const code = stringValue(command.options.code ?? command.args[0], runtime.vars);
        if (!code) throw new Error('js expects code, e.g. js code="return document.title"');
        const { javascriptTool } = await import('./javascript');
        const result = await javascriptTool.execute({
          code,
          tabId: runtime.tabId,
          timeoutMs: remaining(),
          frameId: frameOption(command),
          maxOutputBytes: optionNumber(command, 'max', DEFAULT_RESULT_BYTES),
          vars: runtime.vars,
        });
        const text = await readToolText(result);
        if (result.isError) return record('failed', describeJavascriptFailure(text));
        const outcome = javascriptStepOutcome(text);
        return record('success', text, {
          line: `js: ${outcome.line}`,
          value: outcome.value,
          warnings: outcome.warnings,
        });
      }
      if (command.name === 'http') {
        const request = parseHttpCommand(command, runtime.vars);
        if (request.context === 'extension') {
          // Extension-origin request: host permissions, no page headers or page-relative auth.
          return await run({
            id: id(),
            type: 'http',
            params: {
              method: request.method as any,
              url: new URL(request.url, (await chrome.tabs.get(runtime.tabId)).url).href,
              ...(Object.keys(request.headers).length ? { headers: request.headers } : {}),
              body:
                request.body === undefined
                  ? { kind: 'none' }
                  : typeof request.body === 'string'
                    ? { kind: 'text', text: request.body }
                    : { kind: 'json', json: asJsonValue(request.body) },
            },
          } as ExecutableAction);
        }
        const { javascriptTool } = await import('./javascript');
        const result = await javascriptTool.execute({
          code: buildPageHttpCode(request),
          tabId: runtime.tabId,
          timeoutMs: remaining(),
          maxOutputBytes: optionNumber(command, 'max', DEFAULT_RESULT_BYTES),
        });
        const text = await readToolText(result);
        if (result.isError) return record('failed', `http ${request.method} ${request.url}: ${describeJavascriptFailure(text)}`);
        const outcome = javascriptStepOutcome(text);
        const response = outcome.value as { status: number; ok: boolean; url: string; data: unknown; error?: string };
        if (!response || typeof response !== 'object') throw new Error('http: page returned no response');
        if (response.error) return record('failed', `http ${request.method} ${request.url}: ${response.error}`);
        if (!response.ok) {
          return record('failed', `HTTP ${response.status} ${request.method} ${response.url}: ${renderResultValue(response.data).slice(0, 300)}`);
        }
        if (request.as) runtime.vars[request.as] = asJsonValue(response.data ?? null);
        const rendered = renderResultValue(response.data);
        return record('success', text, {
          value: response.data,
          line: `http ${request.method} ${response.status} ${response.url}${request.as ? ` -> $${request.as}` : ''}: ${request.as ? `${rendered.slice(0, 200)}${rendered.length > 200 ? '…' : ''}` : rendered}`,
          warnings: outcome.warnings,
        });
      }
      if (command.name === 'storage') {
        const area = command.args[1] || stringValue(command.options.area, runtime.vars) || 'local';
        if (command.args[0] !== 'get') throw new Error('storage syntax: storage get local|session|cookie key=NAME as=$var');
        if (!['local', 'session', 'cookie'].includes(area)) throw new Error('storage area must be local, session, or cookie');
        const key = stringValue(command.options.key, runtime.vars);
        const saveAs = String(command.options.as || '').replace(/^\$/, '');
        if (!key || !saveAs) throw new Error('storage get needs key=NAME and as=$var');
        const [frame] = await chrome.scripting.executeScript({
          target: { tabId: runtime.tabId, frameIds: [frameOption(command) ?? 0] },
          world: 'MAIN',
          func: readStorageInPage,
          args: [area, key],
        });
        const found = frame?.result as ReturnType<typeof readStorageInPage> | undefined;
        if (!found?.ok) return record('failed', found?.error || `storage ${area} ${key} is not set`);
        runtime.vars[saveAs] = asJsonValue(found.value);
        // Values are usually credentials: never echo them into the transcript.
        return record('success', `storage ${area} ${key} -> $${saveAs} (${String(found.value).length} chars, hidden)`);
      }
      if (command.name === 'extract') {
        const node = await this.resolveTargetNode(command, runtime, { allowMany: true });
        const legacyAs = command.args[0] && !/^@?ref_\d+$/.test(command.args[0]) ? command.args[1] : undefined;
        const saveAs = String(command.options.as || legacyAs || '').replace(/^\$/, '');
        const fields = command.options.fields !== undefined ? optionData(command, 'fields', runtime.vars) : undefined;
        if (fields !== undefined && (!fields || typeof fields !== 'object' || Array.isArray(fields))) {
          throw new Error('extract fields= expects a JSON object of name -> "selector[@attr]"');
        }
        const spec: ExtractSpec = {
          ...(node.ref ? { ref: node.ref } : { selector: node.selector }),
          attr: stringValue(command.options.attr, runtime.vars) || 'text',
          all: optionBoolean(command, 'all'),
          ...(fields ? { fields } : {}),
          limit: optionNumber(command, 'limit', 500),
        };
        const [frame] = await chrome.scripting.executeScript({
          target: { tabId: runtime.tabId, frameIds: [node.frameId ?? 0] },
          world: 'ISOLATED',
          func: extractInPage,
          args: [spec],
        });
        const outcome = frame?.result as ReturnType<typeof extractInPage> | undefined;
        if (!outcome) throw new Error('extract: the frame returned no result');
        if (!outcome.ok) return record('failed', outcome.error);
        if (saveAs) runtime.vars[saveAs] = asJsonValue(outcome.value);
        const rendered = renderResultValue(outcome.value);
        return record('success', saveAs ? `extract -> $${saveAs}` : `extract: ${rendered}`, {
          value: outcome.value,
          line: saveAs ? `extract -> $${saveAs}: ${rendered.slice(0, 200)}${rendered.length > 200 ? '…' : ''}` : `extract: ${rendered}`,
        });
      }
      throw new Error(`unsupported command "${command.name}"`);
    } catch (error) {
      return record('failed', error instanceof Error ? error.message : String(error));
    }
  }

  private async focusRef(tabId: number, ref: string, frameId: number | undefined, selectAll: boolean): Promise<void> {
    const { focusRefInPage } = await import('./semantic-input');
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId ?? 0] },
      world: 'ISOLATED',
      func: focusRefInPage,
      args: [ref, selectAll],
    });
    const outcome = frame?.result as ReturnType<typeof focusRefInPage> | undefined;
    if (!outcome?.ok) throw new Error(outcome?.error || `cannot focus ${ref}`);
  }

  /**
   * One element for commands that act on a node directly (hover, extract, scroll, screenshot):
   * an @ref, the single piped node, or a locator that must resolve to exactly one semantic node.
   */
  private async resolveTargetNode(
    command: ShellCommand,
    runtime: RuntimeState,
    { allowMany = false }: { allowMany?: boolean } = {},
  ): Promise<{ ref?: string; frameId?: number; selector?: string }> {
    const vars = runtime.vars;
    const explicitFrame = frameOption(command);
    const firstArg = command.args[0];
    const refText = stringValue(command.options.ref, vars) || (firstArg && /^@?ref_\d+$/.test(firstArg) ? firstArg : undefined);
    const known = (ref: string) =>
      runtime.pipelineNodes.find((node) => node.ref === ref) || runtime.lastPage?.nodes.find((node) => node.ref === ref);
    if (refText) {
      const ref = stripRef(refText);
      return { ref, frameId: explicitFrame ?? known(ref)?.frameId };
    }
    const css = stringValue(command.options.css, vars) || (allowMany && firstArg ? firstArg : undefined);
    const role = stringValue(command.options.role, vars);
    const name = stringValue(command.options.name, vars);
    const nameContains = stringValue(command.options['name~'], vars);
    const text = stringValue(command.options.text, vars) || (!allowMany && firstArg && !/^(up|down|left|right|top|bottom)$/.test(firstArg) ? firstArg : undefined);
    if (!css && !role && name === undefined && !nameContains && !text) {
      if (runtime.pipelineNodes.length === 1) {
        const [node] = runtime.pipelineNodes;
        return { ref: node.ref, frameId: explicitFrame ?? node.frameId };
      }
      targetFrom(command, runtime.pipelineNodes, vars);
      throw new Error(`${command.name} needs a target`);
    }
    if (allowMany && css && !role && name === undefined && !nameContains && !text) {
      return { selector: css, frameId: explicitFrame };
    }
    const state = await readSemanticPageState(runtime.tabId, {
      mode: 'full',
      limit: 20,
      includeAdapters: false,
      ...(explicitFrame !== undefined ? { scopeFrameId: explicitFrame } : {}),
      ...(role ? { role } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(nameContains ? { nameContains } : {}),
      ...(css ? { selector: css } : {}),
      ...(text ? { query: text } : {}),
    });
    let matches = state.nodes;
    if (text && matches.length > 1) {
      const exact = matches.filter((node) => node.name?.trim() === text.trim());
      if (exact.length) matches = exact;
    }
    if (!matches.length && css && !role && name === undefined && !nameContains && !text) {
      // A css target need not be a semantic node (canvas, plain container): pin the element itself.
      return { ref: await pinCssTarget(runtime.tabId, explicitFrame ?? 0, css), frameId: explicitFrame };
    }
    if (matches.length !== 1) {
      const shown = matches.slice(0, 5).map((node) => `${node.ref} ${node.role} ${JSON.stringify(node.name || '')}`).join('; ');
      throw new Error(
        `${command.name} target (${describeLocator(command)}) matched ${matches.length} nodes; expected exactly one${shown ? ` — ${shown}` : ''}`,
      );
    }
    return { ref: matches[0].ref, frameId: matches[0].frameId };
  }

  private async callPageTool(
    runtime: RuntimeState,
    name: string,
    input: unknown,
    deadline: number,
    maxOutputBytes = DEFAULT_RESULT_BYTES,
  ): Promise<unknown> {
    const workspace = runtime.workspaceTools.filter((tool) => tool.name === name);
    if (workspace.length > 1) throw new Error(`Workspace tool "${name}" is ambiguous`);
    if (workspace.length === 1) {
      const tool = workspace[0];
      if (tool.kind === 'semantic-sequence') {
        if (runtime.toolDepth >= 4) throw new Error('Semantic tool nesting exceeds 4');
        const previousVars = runtime.vars;
        const previousPipeline = runtime.pipelineNodes;
        try {
          const values = validateSemanticToolInput(tool.inputSchema, input);
          const current = await chrome.tabs.get(runtime.tabId);
          const url = new URL(current.url || '');
          const scope = tool.manifest?.scope as { href?: string } | undefined;
          if (!scope?.href || url.href !== scope.href) throw new Error('Tool scope mismatch');
          const script = tool.manifest?.script;
          if (typeof script !== 'string' || !script.trim()) throw new Error('Semantic tool has no script');
          runtime.vars = asJsonValue(values);
          runtime.toolDepth++;
          try {
            await this.executeProgram(parseShellProgram(script), runtime, Math.max(1, deadline - Date.now()));
          } finally { runtime.toolDepth--; }
          if (!runtime.lastSuccess) throw new Error(runtime.records.at(-1)?.detail || 'Semantic tool assertion failed');
          runtime.learningResults.push({ name, status: 'success' });
          return { ok: true, operation: name };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const category = learnedFailureCategory(runtime.records.at(-1)?.command || '', message);
          runtime.learningResults.push({ name, status: 'failed', category });
          throw error;
        } finally {
          runtime.vars = previousVars;
          runtime.pipelineNodes = previousPipeline;
        }
      }
      const { javascriptTool } = await import('./javascript');
      let code: string;
      if (tool.kind === 'javascript') {
        if (!tool.code) throw new Error(`Workspace tool "${name}" has no JavaScript entry`);
        code = `const ARGS = Object.freeze(${JSON.stringify(input ?? {})});\n${tool.code}`;
      } else {
        const requests = Array.isArray(tool.manifest?.requests) ? tool.manifest!.requests : [];
        if (!requests.length) throw new Error(`Operation "${name}" has no requests`);
        code = buildHttpSequenceOperationCode(requests, input);
      }
      const result = await javascriptTool.execute({
        code,
        tabId: runtime.tabId,
        timeoutMs: Math.max(1, deadline - Date.now()),
        maxOutputBytes,
      });
      const text = await readToolText(result);
      if (result.isError) throw new Error(describeJavascriptFailure(text));
      const payload = unwrapJavascriptToolPayload(text);
      if (payload.engine || payload.elapsedMs !== undefined) {
        runtime.logs.push(
          `tool ${name}: engine=${payload.engine || 'unknown'} elapsed=${payload.elapsedMs ?? '?'}ms`,
        );
      }
      payload.warnings.forEach((warning) => runtime.logs.push(`tool ${name}: ${warning}`));
      return payload.truncated ? { result: payload.value, truncated: true } : payload.value;
    }
    const skipped = runtime.workspaceToolErrors.find((entry) => {
      const base = entry.file.split(/[\\/]/).pop() || entry.file;
      return entry.file === name || base.replace(/\.(tool\.json|js)$/, '') === name;
    });
    if (skipped) throw new Error(`Workspace tool "${name}" was not loaded: ${skipped.reason}`);
    try {
      return await callWebMcpTool(runtime.tabId, name, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const known = runtime.workspaceTools.map((tool) => tool.name).slice(0, 20);
      throw new Error(
        `${message}${known.length ? `; workspace tools: ${known.join(', ')}` : '; no workspace tools were discovered (check -C <workspace>)'}`,
      );
    }
  }
}

export const chromeShellTool = new ChromeShellTool();
