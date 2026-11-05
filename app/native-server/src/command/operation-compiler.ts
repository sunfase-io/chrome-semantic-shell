import { createHash } from 'node:crypto';
import { parseShellProgram, type ShellCommand } from 'chrome-semantic-shell-shared';
import type { WorkspaceTool } from './workspace-tools';

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const VARIABLE = /^\$([a-zA-Z_][a-zA-Z0-9_-]{0,63})$/;
const SECRET = /password|passwd|secret|authorization|cookie|captcha|api[_-]?key|access[_-]?token|密码|口令|验证码|密钥|\bBearer\s|\bsk-[\w-]{16,}|\bapikey_[\w-]{16,}|\beyJ[\w-]+\.[\w-]+\./i;
const ALLOWED = new Set(['inspect', 'query', 'fillform', 'fill', 'select', 'check', 'click', 'wait', 'assert', 'call']);
const ACTIONS = new Set(['fillform', 'fill', 'select', 'check', 'click', 'call']);
const CONTROL_TEXT = /^(保存|确定|确认|查询|搜索|取消|下一步|提交|Save|Confirm|Search|Cancel|Next|Submit)$/i;
const fingerprints = new WeakMap<WorkspaceTool, string>();

export interface LearnedManifest {
  name: string;
  kind: 'semantic-sequence';
  description: string;
  script: string;
  scope: { origin: string; pathname: string; href: string };
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: false;
  };
  dependencies: Record<string, string>;
  learning: { owner: 'chrome-shell'; version: number; key: string };
}

export type Compilation =
  | { eligible: true; manifest: LearnedManifest; sampleHash: string }
  | { eligible: false; reason: string };

export function toolFingerprint(tool: WorkspaceTool): string {
  let hash = fingerprints.get(tool);
  if (!hash) {
    hash = digest(tool.code ?? JSON.stringify(tool.manifest));
    fingerprints.set(tool, hash);
  }
  return hash;
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new Error('unsafe-number');
  }
  if (['string', 'boolean', 'number', 'object'].includes(typeof value)) return typeof value;
  throw new Error('unsupported-input');
}

function literal(raw: string): unknown {
  if (/^-?\d+(\.\d+)?$/.test(raw) || ['true', 'false', 'null'].includes(raw) || /^[{[]/.test(raw)) {
    return JSON.parse(raw);
  }
  return raw;
}

const token = (value: string): string => VARIABLE.test(value) ? value : JSON.stringify(value);

function render(command: ShellCommand): string {
  return [command.name, ...command.args.map(token), ...Object.keys(command.options).map((key) => {
    const value = command.options[key];
    if (value === true) return `--${key}`;
    const text = String(value);
    // Unquoted JSON stays data; quoting it would turn the replayed value into a string literal.
    if (!command.quoted?.includes(key) && /^[[{]/.test(text)) return `${key}=${text}`;
    return `${key}=${token(text)}`;
  })].join(' ');
}

/** Compile observed successful behavior, never generate new behavior with a model. */
export function compileOperation(
  script: string,
  vars: Record<string, unknown>,
  pageUrl: string,
  tools: WorkspaceTool[],
): Compilation {
  const skip = (reason: string): Compilation => ({ eligible: false, reason });
  if (SECRET.test(script)) return skip('sensitive-script');
  if (/@?ref_\d+|\bxpath\s*=|\bscope\s*=\s*["']?@?ref_/i.test(script)) return skip('ephemeral-target');
  try {
    const url = new URL(pageUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return skip('unsupported-origin');
    if (SECRET.test(url.pathname)) return skip('sensitive-scope');
    if ([...url.searchParams.keys()].some((key) => /^(token|session|state|code|ticket|signature|password|secret|api_key|access_token|oauth)$/i.test(key))
        || SECRET.test(url.hash)) return skip('sensitive-scope');
    const program = parseShellProgram(script);
    if (program.statements.length > 20 || program.statements.some((s) => s.connector === 'or')) return skip('complex-control-flow');
    program.statements = program.statements.filter((s) => !(s.pipeline.length === 1 && s.pipeline[0].name === 'inspect'));
    const commands = program.statements.flatMap((s) => s.pipeline);
    if (commands.some((c) => !ALLOWED.has(c.name))) return skip('unsupported-command');
    if (!commands.some((c) => ACTIONS.has(c.name)) || commands.at(-1)?.name !== 'assert') return skip('missing-action-or-final-assert');
    if (commands.some((c) => c.name === 'wait' && c.args.length && /^\d+$/.test(c.args[0]))) return skip('fixed-sleep');

    const properties: LearnedManifest['inputSchema']['properties'] = Object.create(null);
    const values: Record<string, unknown> = Object.create(null);
    const variableNames = new Map<string, string>();
    const dataValues = new Map<string, string>();
    const dependencies: Record<string, string> = Object.create(null);
    let counter = 0;
    const parameter = (raw: string, description: string): string => {
      const variable = raw.match(VARIABLE)?.[1];
      if (variable && !(Object.hasOwn(vars, variable))) throw new Error('missing-variable');
      const value = variable ? vars[variable] : literal(raw);
      if (SECRET.test(description) || (variable && SECRET.test(variable)) || SECRET.test(JSON.stringify(value))) throw new Error('sensitive-input');
      if (variable && variableNames.has(variable)) return `$${variableNames.get(variable)}`;
      const key = `arg${++counter}`;
      properties[key] = { type: valueType(value), description };
      values[key] = value;
      if (variable) variableNames.set(variable, key);
      if (typeof value === 'string' && value.length) dataValues.set(value, key);
      return `$${key}`;
    };

    for (const command of commands) {
      const compiledKeys = new Set<string>();
      if (command.name === 'call') {
        if (command.args.length !== 1 || !command.options.input) return skip('call-needs-explicit-input');
        const matches = tools.filter((tool) => tool.name === command.args[0]);
        if (matches.length !== 1 || matches[0].source === 'learned') return skip('untracked-or-recursive-tool');
        dependencies[matches[0].name] = toolFingerprint(matches[0]);
        command.options.input = parameter(String(command.options.input), `input for ${matches[0].name}`);
        compiledKeys.add('input');
      } else if (command.name === 'fillform') {
        for (const key of Object.keys(command.options)) {
          command.options[key] = parameter(String(command.options[key]), `field ${key}`);
          compiledKeys.add(key);
        }
      } else if (['fill', 'select', 'check'].includes(command.name)) {
        if (!Object.hasOwn(command.options, 'value')) return skip('use-explicit-value');
        command.options.value = parameter(String(command.options.value), `value for ${command.options.name || command.options.css || command.name}`);
        compiledKeys.add('value');
      }
      for (const [key, raw] of Object.entries(command.options)) {
        if (typeof raw !== 'string') continue;
        // Already emitted parameters are local to this compiler, not caller vars.
        if (compiledKeys.has(key)) continue;
        if (VARIABLE.test(raw)) command.options[key] = parameter(raw, `${command.name}.${key}`);
        else if (['text', 'query'].includes(key)) {
          if (dataValues.has(raw)) command.options[key] = `$${dataValues.get(raw)}`;
          else if ([...dataValues.keys()].some((value) => raw.includes(value))) return skip('embedded-input-needs-variable');
          else if (command.name === 'query' && !CONTROL_TEXT.test(raw)) command.options[key] = parameter(raw, `${command.options.role || 'element'} ${key}`);
          else if (/[0-9@]/.test(raw)) command.options[key] = parameter(raw, `${command.name}.${key}`);
        }
      }
      command.args = command.args.map((arg) => {
        if (VARIABLE.test(arg)) return parameter(arg, `${command.name} argument`);
        if (command.name === 'query' && !CONTROL_TEXT.test(arg)) return parameter(arg, 'element query');
        return arg;
      });
    }
    const normalized = program.statements.map((s) => s.pipeline.map(render).join(' | ')).join(' && ');
    parseShellProgram(normalized);
    const scope = { origin: url.origin, pathname: url.pathname, href: url.href };
    const inputSchema: LearnedManifest['inputSchema'] = {
      type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
    };
    const key = digest(JSON.stringify({ scope, normalized, inputSchema })).slice(0, 20);
    const actions = [...new Set(commands.filter((c) => ACTIONS.has(c.name)).map((c) => c.name))];
    const labels = commands.flatMap((c) => [c.options.name, c.name === 'fillform' ? Object.keys(c.options).join('/') : undefined])
      .filter((x): x is string => typeof x === 'string' && !x.startsWith('$')).slice(0, 5);
    const manifest: LearnedManifest = {
      name: `auto_${actions[0]}_${key.slice(0, 12)}`,
      kind: 'semantic-sequence',
      description: `Verified ${actions.join(' → ')} ${labels.join(' / ')} on ${scope.pathname}`.slice(0, 300),
      script: normalized, scope, inputSchema, dependencies,
      learning: { owner: 'chrome-shell', version: 1, key },
    };
    if (Buffer.byteLength(JSON.stringify(manifest, null, 2), 'utf8') > 8192) return skip('template-too-large');
    return { eligible: true, manifest, sampleHash: digest(JSON.stringify(values)) };
  } catch (error) {
    return skip(error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : 'invalid-pattern');
  }
}
