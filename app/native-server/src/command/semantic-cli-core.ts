import type { CommandResult } from './types';
import { parseShellProgram, SHELL_COMMAND_OPTIONS } from 'chrome-semantic-shell-shared';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const VARIABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

export interface FormattedCommandResult {
  text: string;
  isError: boolean;
}

function parseValue(raw: string): unknown {
  if (!raw.length) return '';
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function parseVariableAssignments(assignments: string[]): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf('=');
    if (separator < 1) throw new Error(`invalid variable assignment: ${assignment}`);
    const key = assignment.slice(0, separator);
    if (!VARIABLE_NAME.test(key)) throw new Error(`invalid variable name: ${key}`);
    vars[key] = parseValue(assignment.slice(separator + 1));
  }
  return vars;
}

export function parseVariablesJson(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid variables JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('variables JSON must be an object');
  }
  return value as Record<string, unknown>;
}

/**
 * Replace `js file=PATH` with `code=$__js_file_N` and return the file contents as variables, so long
 * page scripts live in real .js files without any DSL quoting.
 */
export function inlineJavascriptFiles(
  script: string,
  readFile: (file: string) => string,
): { script: string; vars: Record<string, string> } {
  const vars: Record<string, string> = {};
  let output = '';
  let cursor = 0;
  for (const statement of parseShellProgram(script).statements) {
    for (const command of statement.pipeline) {
      const file = command.options.file;
      if (command.name !== 'js' || file === undefined) continue;
      if (typeof file !== 'string' || !file) throw new Error('js file= expects a path');
      if (command.options.code !== undefined)
        throw new Error('js accepts code= or file=, not both');
      const name = `__js_file_${Object.keys(vars).length + 1}`;
      vars[name] = readFile(file);
      const at = script.indexOf(command.raw, cursor);
      if (at < 0) throw new Error(`cannot locate js file= command: ${command.raw}`);
      const replaced = command.raw.replace(
        /(^|\s)(?:--)?file=("[^"]*"|'[^']*'|\S+)/,
        (_, lead: string) => `${lead}code=$${name}`,
      );
      output += script.slice(cursor, at) + replaced;
      cursor = at + command.raw.length;
    }
  }
  return { script: output + script.slice(cursor), vars };
}

const COMMAND_HELP: Record<string, string> = {
  inspect:
    'inspect [interactive|forms|tables|dialog|text|full] [query=TEXT] [role=R] [name=EXACT] [name~=PART] [limit=N] [scope=pipe|@ref] [frame=N]',
  query:
    'query ["TEXT"|query=TEXT] [role=R] [name=EXACT] [name~=PART] [css=SEL] [nth=I] [mode=...] — fails on 0 matches',
  diff: 'diff  — changes since the earlier inspect in this program',
  watch: 'watch [timeout=MS]  — waits for a semantic page change and returns actionable nodes',
  click: 'click @ref | <piped node> | role=R name=N | text=T | css=SEL [frame=N]',
  dblclick: 'dblclick @ref | <piped node> | role=R name=N | text=T | css=SEL [frame=N]',
  check: 'check @ref | role=checkbox name=N [value=true|false] [frame=N]',
  drag: 'drag @start @end [frame=N]',
  fill: 'fill @ref VALUE | fill role=textbox name=N value=V [submit=true]',
  type: 'type @ref "text" [submit=true]  — trusted keystrokes via CDP; appends at the caret',
  fillform: 'fillform LABEL=VALUE ...',
  select:
    'select role=combobox name=N value=V [timeout=MS]  — opens the component, clicks the real option',
  key: 'key "Ctrl+S" | key Enter [@ref|css=SEL]  — defaults to the last filled/typed element',
  scroll:
    'scroll up|down|left|right [PX] | scroll top|bottom | scroll @ref | query ... | scroll down 300',
  hover: 'hover @ref | role=R name=N | css=SEL',
  upload: 'upload css=SEL file=PATH | upload @ref file=["a","b"]',
  screenshot:
    'screenshot [@ref|css=SEL|role=R name=N] [full=true]  — CDP capture of the target tab, no downloads',
  js: 'js code="return document.title" | js "location.href" | js file=PATH.js [frame=N] [max=BYTES]  — VARS holds program variables',
  http: 'http [GET|POST|...] URL [headers={...}] [body=JSON|form={...}] [pick=path|[paths]|{alias:path}] [as=$v] [context=page|extension]',
  storage: 'storage get local|session|cookie key=NAME as=$var  — value is never printed',
  extract:
    'extract css=SEL [attr=text|html|value|href|NAME] [all=true] [fields={"k":"sel@attr"}] [as=$v] | extract @ref',
  wait: 'wait MS | wait text=T | wait selector=SEL [state=visible|attached|detached] | wait url~=PART | wait navigation | wait network [timeout=MS]',
  assert: 'assert text=T | assert exists=SEL | assert visible=SEL',
  tab: 'tab list [match=TEXT] | tab new URL [active=false] [timeout=MS] | tab switch ID | tab close [ID]',
  navigate: 'navigate URL  — fails on a network error page',
  back: 'back  — history back in the target tab',
  forward: 'forward  — history forward in the target tab',
  reload: 'reload  — reload the target tab',
  window: 'window  — list windows with their tabs',
  console: 'console [buffer|snapshot] [--errors]  — page console messages',
  learn: 'learn status | learn maintain  — automatic operation memory state; run it on its own',
  tool: 'tool ls | tool call NAME input={...} [timeout=MS] [max=BYTES]',
  call: 'call NAME input={...} [timeout=MS] [max=BYTES]',
  network: 'network start [body=true] [url=PART] ; network stop [url=PART] [limit=N]',
  capture:
    'capture begin [body=true] ; capture end name=N ; capture publish name=N bindings={...} [allowConstants]',
  download: 'download [timeout=MS] [filename=PREFIX]',
  dialog: 'dialog accept|dismiss [text=PROMPT]',
  defer: 'defer { commands }  — cleanup that runs after success, failure or timeout',
  set: 'set $name=VALUE',
  if: 'if success|failure|$var { ... } [else { ... }]',
  for: 'for $item in $list { ... }',
};

/** `chrome-shell help [command]`, answered locally without the bridge. */
export function renderCommandHelp(name?: string): string {
  if (name) {
    const usage = COMMAND_HELP[name];
    const options = SHELL_COMMAND_OPTIONS[name];
    if (!usage && !options) throw new Error(`unknown command "${name}"; run chrome-shell help`);
    return [usage || name, options ? `options: ${options.join(', ') || 'none'}` : '']
      .filter(Boolean)
      .join('\n');
  }
  return [
    'Semantic Shell commands (chrome-shell help <command> for details):',
    ...Object.keys(SHELL_COMMAND_OPTIONS).map((command) => `  ${COMMAND_HELP[command]}`),
    'Composition: ";"/newline continue, "&&" on success, "||" on failure, "|" pipes nodes. Quote values with spaces.',
  ].join('\n');
}

function artifactExtension(mimeType: string): string {
  const extensions: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };
  return extensions[mimeType.toLowerCase()] || '.bin';
}

async function ensureArtifactDirectory(requested?: string): Promise<string> {
  if (requested) {
    const target = path.resolve(requested);
    await fs.mkdir(target, { recursive: true });
    return await fs.mkdtemp(path.join(target, 'chrome-shell-run-'));
  }
  return await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-shell-'));
}

export async function formatCommandResult(
  result: CommandResult,
  options: { resultJson?: boolean; artifactDirectory?: string; output?: string } = {},
): Promise<FormattedCommandResult> {
  if (!result || !Array.isArray(result.content)) throw new Error('invalid command result');
  if (options.resultJson) {
    return { text: JSON.stringify(result), isError: Boolean(result.isError) };
  }

  const texts: string[] = [];
  const artifacts: string[] = [];
  const others: unknown[] = [];
  let artifactDirectory: string | undefined;
  for (const item of result.content) {
    if (item.type === 'text') {
      if (item.text) texts.push(item.text);
      continue;
    }
    if (item.type === 'image') {
      artifactDirectory ||= await ensureArtifactDirectory(options.artifactDirectory);
      const target = path.join(
        artifactDirectory,
        `screenshot-${artifacts.length + 1}${artifactExtension(item.mimeType)}`,
      );
      await fs.writeFile(target, Buffer.from(item.data, 'base64'), { flag: 'wx' });
      artifacts.push(target);
      continue;
    }
    others.push(item);
  }
  const isError = Boolean(result.isError);
  if (options.output === 'json') {
    // One parseable JSON document: artifacts and bridge notes become fields, never trailing lines.
    let document: Record<string, unknown>;
    try {
      const parsed = JSON.parse(texts[0] ?? '');
      document =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed
          : { ok: !isError, text: texts[0] };
    } catch {
      document = { ok: !isError, ...(texts[0] ? { error: texts[0] } : {}) };
    }
    if (artifacts.length) document.artifacts = artifacts;
    if (texts.length > 1) document.notes = texts.slice(1);
    if (others.length) document.content = others;
    return { text: JSON.stringify(document, null, 2), isError };
  }
  const lines = [
    ...texts,
    ...artifacts.map((target) => `artifact: ${target}`),
    ...others.map((item) => `content: ${JSON.stringify(item)}`),
  ];
  if (!lines.length) lines.push(isError ? 'command failed without details' : 'ok');
  return { text: lines.join('\n'), isError };
}

export function resolveCommandEndpoint(raw: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error(`invalid command endpoint: ${raw}`);
  }
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (endpoint.protocol !== 'http:' || !loopback.has(endpoint.hostname)) {
    throw new Error('command endpoint must be an http:// loopback URL');
  }
  return endpoint;
}
