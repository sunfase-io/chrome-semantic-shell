import { NativeMessageType, type CommandResult, type SemanticExecParams } from './types';
import * as path from 'node:path';
import { parseShellProgram } from 'chrome-semantic-shell-shared';
import { operationMemory } from './operation-memory';
import { toolFingerprint } from './operation-compiler';
import { pathToFileURL } from 'node:url';
import {
  discoverWorkspaceToolCatalog,
  publishWorkspaceTool,
  type WorkspacePublishRequest,
} from './workspace-tools';

export const SEMANTIC_EXEC_ROUTE = '/chrome/shell';
// Private Native Messaging executor ID. It is intentionally absent from TOOL_SCHEMAS.
export const SEMANTIC_EXEC_TOOL = 'chrome_shell_exec';

const MAX_SCRIPT_LENGTH = 64 * 1024;
const MAX_TIMEOUT_MS = 280_000;
const OUTPUT_MODES = new Set(['compact', 'json', 'debug']);
const REQUEST_KEYS = new Set([
  'script',
  'vars',
  'tabId',
  'windowId',
  'timeoutMs',
  'output',
  'dryRun',
  'failFast',
  'quiet',
  'workspace',
  'expectedUrl',
]);

export interface SemanticExecRequest extends SemanticExecParams {
  workspace?: string;
}

export interface ExtensionCommandBridge {
  sendRequestToExtensionAndWait(
    payload: unknown,
    messageType: string,
    timeoutMs: number,
  ): Promise<unknown>;
}

export class SemanticExecInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticExecInputError';
  }
}

function invalidInput(message: string): never {
  throw new SemanticExecInputError(message);
}

function optionalInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    invalidInput(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

export function normalizeSemanticExecRequest(value: unknown): SemanticExecRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalidInput('request body must be a JSON object');
  }
  const input = value as Record<string, unknown>;
  const unknownKeys = Object.keys(input).filter((key) => !REQUEST_KEYS.has(key));
  if (unknownKeys.length) invalidInput(`unknown request field: ${unknownKeys.join(', ')}`);

  if (typeof input.script !== 'string' || !input.script.trim()) {
    invalidInput('script must be a non-empty string');
  }
  if (input.script.length > MAX_SCRIPT_LENGTH) {
    invalidInput(`script exceeds ${MAX_SCRIPT_LENGTH} characters`);
  }
  if (
    input.vars !== undefined &&
    (!input.vars || typeof input.vars !== 'object' || Array.isArray(input.vars))
  ) {
    invalidInput('vars must be a JSON object');
  }
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') {
    invalidInput('dryRun must be a boolean');
  }
  if (input.failFast !== undefined && typeof input.failFast !== 'boolean') {
    invalidInput('failFast must be a boolean');
  }
  if (input.output !== undefined && !OUTPUT_MODES.has(String(input.output))) {
    invalidInput('output must be compact, json, or debug');
  }
  if (input.expectedUrl !== undefined && (typeof input.expectedUrl !== 'string' || !/^https?:\/\//.test(input.expectedUrl))) {
    invalidInput('expectedUrl must be an HTTP(S) URL');
  }
  if (input.workspace !== undefined) {
    if (typeof input.workspace !== 'string' || !input.workspace.trim()) {
      invalidInput('workspace must be a non-empty absolute path');
    }
    if (!path.isAbsolute(input.workspace)) {
      invalidInput('workspace must be an absolute path');
    }
  }

  return {
    script: input.script,
    vars: input.vars as Record<string, unknown> | undefined,
    tabId: optionalInteger(input.tabId, 'tabId', 0, Number.MAX_SAFE_INTEGER),
    windowId: optionalInteger(input.windowId, 'windowId', 0, Number.MAX_SAFE_INTEGER),
    timeoutMs: optionalInteger(input.timeoutMs, 'timeoutMs', 1, MAX_TIMEOUT_MS),
    output: input.output as SemanticExecParams['output'],
    dryRun: input.dryRun as boolean | undefined,
    failFast: input.failFast as boolean | undefined,
    quiet: input.quiet === true ? true : undefined,
    expectedUrl: input.expectedUrl as string | undefined,
    workspace: input.workspace ? path.resolve(input.workspace as string) : undefined,
  };
}

function asToolResult(value: unknown): CommandResult {
  if (!value || typeof value !== 'object') throw new Error('extension returned an invalid result');
  const result = value as CommandResult;
  if (!Array.isArray(result.content)) throw new Error('extension result has no content array');
  return result;
}

export async function executeSemanticCommand(
  bridge: ExtensionCommandBridge,
  rawRequest: unknown,
): Promise<CommandResult> {
  const request = normalizeSemanticExecRequest(rawRequest);
  const rootUris = request.workspace ? [pathToFileURL(request.workspace).href] : [];
  if (request.workspace && !request.dryRun) operationMemory.touch(request.workspace);
  if (/^\s*learn\s/.test(request.script)) {
    const commands = parseShellProgram(request.script).statements;
    const command = commands[0]?.pipeline[0];
    if (commands.length !== 1 || commands[0].pipeline.length !== 1 || !request.workspace
        || !['status', 'maintain'].includes(command?.args[0])) throw new SemanticExecInputError('Use learn status|maintain with a workspace');
    const status = request.dryRun ? { ok: true } : await operationMemory.status(request.workspace, command.args[0] === 'maintain');
    return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }], isError: false };
  }
  const { workspace, ...params } = request;
  const catalog = await discoverWorkspaceToolCatalog(rootUris);
  const discovered = catalog.tools;
  const fingerprints = new Map(discovered.map((tool) => [tool.name, toolFingerprint(tool)]));
  const invalid: string[] = [];
  const tools = discovered.filter((tool) => {
    if (tool.kind !== 'semantic-sequence') return true;
    const dependencies = tool.manifest?.dependencies as Record<string, string> | undefined;
    const scope = tool.manifest?.scope as { href?: string } | undefined;
    if (!scope?.href || !dependencies || Object.entries(dependencies).some(([name, hash]) => fingerprints.get(name) !== hash)) {
      invalid.push(tool.name); return false;
    }
    return true;
  });
  if (request.workspace && invalid.length && !request.dryRun) operationMemory.observe({
    workspace: request.workspace, script: '', ok: false, tools: discovered,
    feedback: invalid.map((name) => ({ name, status: 'failed', category: 'dependency_changed' })),
  });
  const args = {
    ...params,
    __workspaceTools: tools,
    __workspaceToolErrors: [
      ...catalog.skipped,
      ...invalid.map((name) => ({ file: name, reason: 'learned tool dependencies changed; retired until relearned' })),
    ],
  };
  const bridgeTimeout = Math.min((request.timeoutMs || 30_000) + 5_000, MAX_TIMEOUT_MS + 5_000);
  const response = (await bridge.sendRequestToExtensionAndWait(
    { name: SEMANTIC_EXEC_TOOL, args },
    NativeMessageType.CALL_TOOL,
    bridgeTimeout,
  )) as { status?: unknown; data?: unknown; error?: unknown };

  if (!response || response.status !== 'success') {
    throw new Error(`extension command failed: ${String(response?.error || 'unknown error')}`);
  }

  const result = asToolResult(response.data);
  if (request.workspace && !request.dryRun) {
    const context = result._meta?.chromeShellContext as { url?: string } | undefined;
    operationMemory.observe({ workspace: request.workspace, script: request.script, vars: request.vars,
      ok: result.isError === false, pageUrl: context?.url, tools,
      feedback: result._meta?.learningResults as any,
    });
  }
  const publish = (
    result as CommandResult & {
      _meta?: { chromeCommandWorkspacePublish?: WorkspacePublishRequest };
    }
  )._meta?.chromeCommandWorkspacePublish;
  if (publish && !result.isError) {
    const target = await publishWorkspaceTool(rootUris, publish);
    result.content.push({ type: 'text', text: `workspace tool published: ${target}` });
  }
  return result;
}
