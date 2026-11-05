/**
 * JavaScript Tool - CDP Runtime.evaluate with page-context fallbacks
 *
 * Execute JavaScript in the browser tab and return the result.
 * - Primary: CDP Runtime.evaluate (supports awaitPromise + returnByValue, ignores page CSP)
 * - Fallback when the debugger cannot attach or a frame is targeted:
 *   chrome.userScripts.execute in the MAIN world (when "Allow User Scripts" is enabled),
 *   otherwise chrome.scripting.executeScript in the MAIN world (subject to page CSP).
 *
 * A single expression returns its value implicitly; statement code returns via `return`.
 * The expression form is attempted first: a syntax error is raised at compile time before any
 * code runs, so retrying as a statement body never repeats side effects. Runtime errors are caught
 * inside the page wrapper and reported as values.
 */

import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-semantic-shell-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { DEFAULT_MAX_OUTPUT_BYTES, limitOutput } from '@/utils/output-limiter';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT_MS = 15_000;
const CDP_SESSION_KEY = 'javascript';

// ============================================================================
// Types
// ============================================================================

type ExecutionEngine = 'cdp' | 'userScripts' | 'scripting';

type ErrorKind =
  | 'debugger_conflict'
  | 'timeout'
  | 'syntax_error'
  | 'runtime_error'
  | 'cdp_error'
  | 'scripting_error';

interface JavaScriptToolParams {
  code: string;
  tabId?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Extension frame id; non-zero frames run through the scripting engines. */
  frameId?: number;
  /** Exposed to the code as frozen `VARS` when referenced. */
  vars?: Record<string, unknown>;
}

interface ExecutionError {
  kind: ErrorKind;
  message: string;
  details?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

interface ExecutionMetrics {
  elapsedMs: number;
}

interface JavaScriptToolResult {
  success: boolean;
  tabId: number;
  engine: ExecutionEngine;
  result?: string;
  truncated?: boolean;
  /** The code ran as a single expression whose value was returned implicitly. */
  expression?: boolean;
  /** The completion value was `undefined` (statement code without `return`). */
  undefinedResult?: boolean;
  warnings?: string[];
  error?: ExecutionError;
  metrics?: ExecutionMetrics;
}

interface ExecutionOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  frameId?: number;
  vars?: Record<string, unknown>;
}

type ExecutionSuccess = {
  ok: true;
  engine: ExecutionEngine;
  output: string;
  truncated: boolean;
  expression: boolean;
  undefinedResult: boolean;
};

type ExecutionFailure = {
  ok: false;
  engine: ExecutionEngine;
  error: ExecutionError;
};

type ExecutionResult = ExecutionSuccess | ExecutionFailure;

type CodeForm = 'expression' | 'body';

/** Value produced by the in-page wrapper. */
interface PageOutcome {
  __chromeShell: 1;
  ok: boolean;
  value?: unknown;
  isUndefined?: boolean;
  name?: string;
  message?: string;
  stack?: string;
}

// ============================================================================
// Timeout Error
// ============================================================================

class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Execution timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);

    promise
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });
}

function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof Error && error.name === 'TimeoutError';
}

/** CDP cannot serve this tab: another debugger, a non-attachable target, or a foreign extension frame. */
function isDebuggerConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Debugger is already attached|Another debugger is already attached|Cannot attach to this target|Cannot access a chrome-extension:\/\/ URL of different extension/i.test(
    message,
  );
}

/**
 * Build the in-page program. The wrapper always resolves to a PageOutcome, so the only exception
 * an engine can report is a compile-time SyntaxError of the chosen form.
 */
export function buildPageProgram(
  code: string,
  form: CodeForm,
  vars?: Record<string, unknown>,
): string {
  const prelude =
    vars && /\bVARS\b/.test(code) ? `const VARS = Object.freeze(${JSON.stringify(vars)});\n` : '';
  const run =
    form === 'expression'
      ? `async () => (\n${code.replace(/;\s*$/, '')}\n)`
      : `async () => {\n${code}\n}`;
  return `(async () => {
${prelude}const __safe = (v) => typeof Node !== 'undefined' && v instanceof Node ? '<' + v.nodeName.toLowerCase() + '>' : typeof v === 'function' ? '[Function' + (v.name ? ': ' + v.name : '') + ']' : v;
try {
const __value = await (${run})();
return { __chromeShell: 1, ok: true, value: __safe(__value), isUndefined: __value === undefined };
} catch (__error) {
return { __chromeShell: 1, ok: false, name: __error && __error.name, message: String(__error && __error.message !== undefined ? __error.message : __error), stack: __error && __error.stack };
}
})()`;
}

function isPageOutcome(value: unknown): value is PageOutcome {
  return Boolean(value && typeof value === 'object' && (value as PageOutcome).__chromeShell === 1);
}

function outcomeToResult(
  engine: ExecutionEngine,
  outcome: PageOutcome,
  form: CodeForm,
  options: ExecutionOptions,
): ExecutionResult {
  if (!outcome.ok) {
    const message = outcome.message || 'JavaScript execution failed';
    return {
      ok: false,
      engine,
      error: {
        kind: outcome.name === 'SyntaxError' ? 'syntax_error' : 'runtime_error',
        message: outcome.stack && !outcome.stack.includes(message) ? `${message}\n${outcome.stack}` : outcome.stack || message,
      },
    };
  }
  const limited = limitOutput(outcome.value, { maxBytes: options.maxOutputBytes });
  return {
    ok: true,
    engine,
    output: limited.text,
    truncated: limited.truncated,
    expression: form === 'expression',
    undefinedResult: outcome.isUndefined === true,
  };
}

/** Try the expression form, then the statement body, only when the former failed to compile. */
async function runForms(
  engine: ExecutionEngine,
  code: string,
  options: ExecutionOptions,
  evaluate: (program: string) => Promise<{ outcome?: PageOutcome; compileError?: ExecutionError }>,
): Promise<ExecutionResult> {
  let compileError: ExecutionError | undefined;
  for (const form of ['expression', 'body'] as const) {
    const attempt = await evaluate(buildPageProgram(code, form, options.vars));
    if (attempt.outcome) return outcomeToResult(engine, attempt.outcome, form, options);
    compileError = attempt.compileError;
    if (compileError?.kind !== 'syntax_error') break;
  }
  return {
    ok: false,
    engine,
    error: compileError || { kind: 'scripting_error', message: 'JavaScript returned no result' },
  };
}

// ============================================================================
// CDP Execution
// ============================================================================

interface CDPRemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

interface CDPExceptionDetails {
  text?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  exception?: {
    className?: string;
    description?: string;
    value?: string;
  };
}

interface CDPEvaluateResult {
  result?: CDPRemoteObject;
  exceptionDetails?: CDPExceptionDetails;
}

function parseExceptionDetails(details: CDPExceptionDetails): ExecutionError {
  const exceptionClassName = details.exception?.className ?? '';
  const exceptionDescription = details.exception?.description ?? '';
  const exceptionValue = details.exception?.value ?? '';
  const text = details.text ?? '';
  const message = exceptionDescription || exceptionValue || text || 'JavaScript execution failed';
  const isSyntaxError = exceptionClassName === 'SyntaxError' || /SyntaxError/i.test(message);
  return {
    kind: isSyntaxError ? 'syntax_error' : 'runtime_error',
    message,
    details: {
      url: details.url,
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
    },
  };
}

async function executeViaCdp(
  tabId: number,
  code: string,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  try {
    return await withTimeout(
      cdpSessionManager.withSession(tabId, CDP_SESSION_KEY, async () => {
        // Arm the Page domain before evaluating code that may open a modal.
        // Enabling it after a blocking dialog opens can itself wait on that dialog.
        await cdpSessionManager.sendCommand(tabId, 'Page.enable');
        return await runForms('cdp', code, options, async (expression) => {
          const response = (await cdpSessionManager.sendCommand(tabId, 'Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
            timeout: options.timeoutMs,
          })) as CDPEvaluateResult;
          if (response?.exceptionDetails) return { compileError: parseExceptionDetails(response.exceptionDetails) };
          const value = response?.result?.value;
          return isPageOutcome(value)
            ? { outcome: value }
            : { compileError: { kind: 'cdp_error', message: 'Runtime.evaluate returned no wrapper result' } };
        });
      }),
      options.timeoutMs + 1000,
    );
  } catch (error) {
    if (isTimeoutError(error)) {
      return { ok: false, engine: 'cdp', error: { kind: 'timeout', message: error.message } };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      engine: 'cdp',
      error: { kind: isDebuggerConflictError(error) ? 'debugger_conflict' : 'cdp_error', message },
    };
  }
}

// ============================================================================
// Page-context fallbacks
// ============================================================================

interface UserScriptsApi {
  execute(injection: {
    target: { tabId: number; frameIds?: number[] };
    world?: 'MAIN' | 'USER_SCRIPT';
    js: Array<{ code: string }>;
    injectImmediately?: boolean;
  }): Promise<Array<{ result?: unknown; error?: string }>>;
}

/** Available only after the user enables "Allow User Scripts" for the extension. */
function userScriptsApi(): UserScriptsApi | undefined {
  try {
    const api = (chrome as unknown as { userScripts?: Partial<UserScriptsApi> }).userScripts;
    return typeof api?.execute === 'function' ? (api as UserScriptsApi) : undefined;
  } catch {
    return undefined;
  }
}

function compileErrorFrom(message: string): ExecutionError {
  return { kind: /SyntaxError/i.test(message) ? 'syntax_error' : 'scripting_error', message };
}

async function executeViaUserScripts(
  api: UserScriptsApi,
  tabId: number,
  code: string,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  return runForms('userScripts', code, options, async (program) => {
    const [frame] = await api.execute({
      target: { tabId, frameIds: [options.frameId ?? 0] },
      world: 'MAIN',
      js: [{ code: program }],
      injectImmediately: true,
    });
    if (isPageOutcome(frame?.result)) return { outcome: frame.result };
    return { compileError: compileErrorFrom(frame?.error || 'userScripts.execute returned no result') };
  });
}

async function executeViaScripting(
  tabId: number,
  code: string,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  return runForms('scripting', code, options, async (program) => {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [options.frameId ?? 0] },
      world: 'MAIN',
      func: (source: string) => {
        try {
          // Subject to the page CSP; userScripts is the CSP-independent path.
          return (0, eval)(source);
        } catch (error) {
          return { __compileError: String((error as Error)?.name || 'Error') + ': ' + String((error as Error)?.message || error) };
        }
      },
      args: [program],
    });
    const result = frame?.result as unknown;
    if (isPageOutcome(result)) return { outcome: result };
    const message = (result as { __compileError?: string } | undefined)?.__compileError;
    return {
      compileError: compileErrorFrom(
        message
          ? /EvalError|unsafe-eval|Content Security Policy/i.test(message)
            ? `${message}. The page CSP blocks eval; enable "Allow User Scripts" for Chrome Semantic Shell in chrome://extensions to run page JavaScript here.`
            : message
          : 'executeScript returned no result (the frame may be unavailable)',
      ),
    };
  });
}

async function executeInPageContext(
  tabId: number,
  code: string,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  const run = async () => {
    const api = userScriptsApi();
    return api
      ? await executeViaUserScripts(api, tabId, code, options)
      : await executeViaScripting(tabId, code, options);
  };
  try {
    return await withTimeout(run(), options.timeoutMs);
  } catch (error) {
    const engine: ExecutionEngine = userScriptsApi() ? 'userScripts' : 'scripting';
    if (isTimeoutError(error)) return { ok: false, engine, error: { kind: 'timeout', message: error.message } };
    return {
      ok: false,
      engine,
      error: { kind: 'scripting_error', message: error instanceof Error ? error.message : String(error) },
    };
  }
}

// ============================================================================
// Tool Implementation
// ============================================================================

class JavaScriptTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.JAVASCRIPT;

  async execute(args: JavaScriptToolParams): Promise<ToolResult> {
    const startTime = performance.now();

    try {
      const code = typeof args?.code === 'string' ? args.code.trim() : '';
      if (!code) {
        return createErrorResponse('Parameter [code] is required');
      }

      const tab = await this.resolveTargetTab(args.tabId);
      if (!tab) {
        return createErrorResponse(
          typeof args.tabId === 'number' ? `Tab not found: ${args.tabId}` : 'No active tab found',
        );
      }
      if (!tab.id) {
        return createErrorResponse('Tab has no ID');
      }
      const tabId = tab.id;
      if (args.frameId !== undefined && (!Number.isInteger(args.frameId) || args.frameId < 0)) {
        return createErrorResponse('frameId must be a non-negative integer');
      }

      const options: ExecutionOptions = {
        timeoutMs: normalizePositiveInt(args.timeoutMs, DEFAULT_TIMEOUT_MS),
        maxOutputBytes: normalizePositiveInt(args.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
        frameId: args.frameId,
        vars: args.vars,
      };

      if (options.frameId) {
        const framed = await executeInPageContext(tabId, code, options);
        return framed.ok
          ? this.buildSuccessResponse(tabId, framed, startTime)
          : this.buildErrorResponse(tabId, framed, startTime);
      }

      const cdpResult = await executeViaCdp(tabId, code, options);
      if (cdpResult.ok) return this.buildSuccessResponse(tabId, cdpResult, startTime);
      if (cdpResult.error.kind !== 'debugger_conflict') {
        return this.buildErrorResponse(tabId, cdpResult, startTime);
      }

      const warnings = [
        `CDP unavailable (${cdpResult.error.message}); ran through ${userScriptsApi() ? 'chrome.userScripts' : 'chrome.scripting'} in the page MAIN world.`,
      ];
      const fallback = await executeInPageContext(tabId, code, options);
      return fallback.ok
        ? this.buildSuccessResponse(tabId, fallback, startTime, warnings)
        : this.buildErrorResponse(tabId, fallback, startTime, warnings);
    } catch (error) {
      console.error('JavaScriptTool.execute error:', error);
      return createErrorResponse(
        `JavaScript tool error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async resolveTargetTab(tabId?: number): Promise<chrome.tabs.Tab | null> {
    if (typeof tabId === 'number') {
      return this.tryGetTab(tabId);
    }
    try {
      return await this.getActiveTabOrThrow();
    } catch {
      return null;
    }
  }

  private buildSuccessResponse(
    tabId: number,
    result: ExecutionSuccess,
    startTime: number,
    warnings?: string[],
  ): ToolResult {
    const payload: JavaScriptToolResult = {
      success: true,
      tabId,
      engine: result.engine,
      result: result.output,
      truncated: result.truncated || undefined,
      expression: result.expression || undefined,
      undefinedResult: result.undefinedResult || undefined,
      warnings: warnings?.length ? warnings : undefined,
      metrics: { elapsedMs: Math.round(performance.now() - startTime) },
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: false,
    };
  }

  private buildErrorResponse(
    tabId: number,
    result: ExecutionFailure,
    startTime: number,
    warnings?: string[],
  ): ToolResult {
    const payload: JavaScriptToolResult = {
      success: false,
      tabId,
      engine: result.engine,
      error: result.error,
      warnings: warnings?.length ? warnings : undefined,
      metrics: { elapsedMs: Math.round(performance.now() - startTime) },
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: true,
    };
  }
}

export const javascriptTool = new JavaScriptTool();
