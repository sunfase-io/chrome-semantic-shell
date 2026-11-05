/** Shared parser: execution and automatic learning must agree on the exact DSL. */
export type ShellConnector = 'always' | 'and' | 'or';

export interface ShellCommand {
  name: string;
  args: string[];
  options: Record<string, string | boolean>;
  /** Option keys whose value was written as a quoted string literal. */
  quoted?: string[];
  raw: string;
}

export interface ShellStatement {
  connector: ShellConnector;
  pipeline: ShellCommand[];
  line: number;
  raw: string;
}

export interface ShellProgram {
  statements: ShellStatement[];
}

export class ShellSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`DSL syntax error at ${line}:${column}: ${message}`);
    this.name = 'ShellSyntaxError';
  }
}

interface RawSegment {
  raw: string;
  connector: ShellConnector;
  line: number;
  column: number;
}

interface RawPart {
  raw: string;
  column: number;
}

/** Leading whitespace width, so trimmed segments still report source columns. */
const leading = (value: string): number => value.length - value.trimStart().length;

function splitTopLevelProgram(source: string): RawSegment[] {
  const out: RawSegment[] = [];
  let current = '';
  let connector: ShellConnector = 'always';
  let quote = '';
  let escaped = false;
  let depth = 0;
  let line = 1;
  let lineStart = 0;
  let segmentLine = 1;
  let segmentColumn = 1;

  const push = () => {
    const raw = current.trim();
    if (raw) {
      const offset = leading(current);
      const skippedLines = current.slice(0, offset).split('\n').length - 1;
      const column = skippedLines
        ? offset - current.slice(0, offset).lastIndexOf('\n')
        : segmentColumn + offset;
      out.push({ raw, connector, line: segmentLine + skippedLines, column });
    }
    current = '';
  };
  const startSegment = (index: number) => {
    segmentLine = line;
    segmentColumn = index - lineStart + 1;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote) {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      if (ch === '\n') {
        line++;
        lineStart = i + 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth < 0) throw new ShellSyntaxError(`unexpected "${ch}"`, line, i - lineStart + 1);
    }
    if (depth === 0 && ch === '&' && next === '&') {
      push();
      connector = 'and';
      i++;
      startSegment(i + 1);
      continue;
    }
    if (depth === 0 && ch === '|' && next === '|') {
      push();
      connector = 'or';
      i++;
      startSegment(i + 1);
      continue;
    }
    if (depth === 0 && (ch === ';' || ch === '\n')) {
      push();
      connector = 'always';
      if (ch === '\n') {
        line++;
        lineStart = i + 1;
      }
      startSegment(i + 1);
      continue;
    }
    if (ch === '\n') {
      line++;
      lineStart = i + 1;
    }
    current += ch;
  }
  if (quote)
    throw new ShellSyntaxError('unterminated quoted string', line, source.length - lineStart + 1);
  if (depth !== 0)
    throw new ShellSyntaxError(
      'unclosed JSON/block delimiter',
      line,
      source.length - lineStart + 1,
    );
  push();
  return out;
}

function splitPipeline(segment: RawSegment): RawPart[] {
  const { raw, line, column } = segment;
  const parts: RawPart[] = [];
  let current = '';
  let start = 0;
  let quote = '';
  let escaped = false;
  let depth = 0;
  const push = (end: number) => {
    if (!current.trim()) throw new ShellSyntaxError('empty pipeline command', line, column + end);
    parts.push({ raw: current.trim(), column: column + start + leading(current) });
    current = '';
  };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote) {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (depth === 0 && ch === '|') {
      push(i);
      start = i + 1;
      continue;
    }
    current += ch;
  }
  push(raw.length);
  return parts;
}

interface Token {
  text: string;
  /** Index in text where the first top-level quoted section begins, or -1. */
  quotedAt: number;
  column: number;
}

function tokenize(raw: string, line: number, column: number): Token[] {
  const tokens: Token[] = [];
  let current = '';
  let quotedAt = -1;
  let start = -1;
  let quote = '';
  let escaped = false;
  let depth = 0;
  const push = () => {
    if (start >= 0) tokens.push({ text: current, quotedAt, column: column + start });
    current = '';
    quotedAt = -1;
    start = -1;
  };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (start < 0 && !(/\s/.test(ch) && depth === 0 && !quote)) start = i;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote) {
      const next = raw[i + 1];
      if (next === quote || next === '\\') {
        escaped = true;
      } else {
        current += ch;
      }
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = '';
        if (depth > 0) current += ch;
        else if (i + 1 < raw.length && !/\s/.test(raw[i + 1])) {
          throw new ShellSyntaxError(
            `unexpected text after closing ${ch === '"' ? 'double' : 'single'} quote; escape inner quotes (\\${ch}) or use the other quote style`,
            line,
            column + i + 1,
          );
        }
      } else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      if (depth > 0) current += ch;
      else if (quotedAt < 0) quotedAt = current.length;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      push();
      continue;
    }
    current += ch;
  }
  if (quote) throw new ShellSyntaxError('unterminated quoted string', line, column + raw.length);
  push();
  return tokens;
}

const OPTION_KEY = /^[\p{L}\p{N}_][-\p{L}\p{N}_.~]*$/u;

function parseCommand(part: RawPart, line: number): ShellCommand {
  const { raw, column } = part;
  const tokens = tokenize(raw, line, column);
  if (!tokens.length) throw new ShellSyntaxError('missing command', line, column);
  const head = tokens.shift()!;
  const name = head.text.toLowerCase();
  if (head.quotedAt >= 0 || !/^[a-z][a-z0-9_-]*$/.test(name)) {
    throw new ShellSyntaxError(`invalid command name "${head.text}"`, line, head.column);
  }
  const args: string[] = [];
  const options: Record<string, string | boolean> = {};
  const quoted: string[] = [];
  for (const token of tokens) {
    const { text, quotedAt } = token;
    const dashed = text.startsWith('--') && quotedAt !== 0;
    const normalized = dashed ? text.slice(2) : text;
    const shift = dashed ? 2 : 0;
    const eq = normalized.indexOf('=');
    // A quote opened before "=" means the "=" belongs to a string literal, never an option.
    const quoteBeforeEq = quotedAt >= 0 && quotedAt - shift <= eq;
    const optionKey = eq > 0 && !quoteBeforeEq ? normalized.slice(0, eq) : '';
    if (optionKey && (dashed || OPTION_KEY.test(optionKey))) {
      options[optionKey] = normalized.slice(eq + 1);
      if (quotedAt - shift === eq + 1) quoted.push(optionKey);
    } else if (dashed) {
      options[normalized] = true;
    } else {
      args.push(text);
    }
  }
  return { name, args, options, ...(quoted.length ? { quoted } : {}), raw };
}

const TARGET_OPTIONS = ['ref', 'css', 'xpath', 'role', 'name', 'name~', 'text', 'frame'];
const ANY_OPTION = '*';

/** Options each command reads. Unknown options fail before any page effect instead of being ignored. */
export const SHELL_COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  inspect: ['mode', 'query', 'limit', 'scope', 'role', 'name', 'name~', 'text', 'frame'],
  query: ['mode', 'query', 'limit', 'scope', 'role', 'name', 'name~', 'text', 'frame', 'css', 'nth'],
  diff: [],
  watch: ['timeout'],
  set: [],
  if: [],
  for: [],
  defer: [],
  tool: ['name', 'input', 'timeout', 'max'],
  call: ['name', 'input', 'timeout', 'max'],
  click: [...TARGET_OPTIONS],
  dblclick: [...TARGET_OPTIONS],
  select: [...TARGET_OPTIONS, 'value', 'timeout'],
  fill: [...TARGET_OPTIONS, 'value', 'submit'],
  type: [...TARGET_OPTIONS, 'value', 'submit'],
  check: [...TARGET_OPTIONS, 'value'],
  fillform: [ANY_OPTION],
  key: [...TARGET_OPTIONS, 'keys'],
  navigate: ['url', 'timeout'],
  back: [],
  forward: [],
  reload: [],
  tab: ['url', 'id', 'active', 'timeout', 'match'],
  window: [],
  wait: ['text', 'selector', 'url', 'url~', 'timeout', 'frame', 'state'],
  assert: ['text', 'visible', 'exists'],
  scroll: [...TARGET_OPTIONS, 'amount'],
  hover: [...TARGET_OPTIONS],
  drag: ['start', 'end', 'frame'],
  upload: [...TARGET_OPTIONS, 'file'],
  screenshot: [...TARGET_OPTIONS, 'full'],
  console: ['errors'],
  network: ['url', 'body', 'limit'],
  capture: ['body', 'name', 'description', 'bindings', 'allowConstants'],
  dialog: ['text'],
  download: ['timeout', 'filename'],
  js: ['code', 'file', 'frame', 'max'],
  http: ['method', 'url', 'body', 'form', 'headers', 'context', 'pick', 'as', 'max'],
  extract: [...TARGET_OPTIONS, 'as', 'attr', 'all', 'fields'],
  storage: ['key', 'as', 'area', 'frame'],
  learn: [],
};

/** Block arguments of control-flow commands, validated recursively. */
const BLOCK_ARG = /^\{[\s\S]*\}$/;

export function validateShellProgram(program: ShellProgram): void {
  for (const statement of program.statements) {
    for (const command of statement.pipeline) {
      const allowed = SHELL_COMMAND_OPTIONS[command.name];
      const where = `at ${statement.line}: ${command.raw.slice(0, 60)}`;
      if (!allowed) throw new ShellSyntaxError(`unsupported command "${command.name}"`, statement.line, 1);
      if (!allowed.includes(ANY_OPTION)) {
        const unknown = Object.keys(command.options).filter((key) => !allowed.includes(key));
        if (unknown.length) {
          throw new Error(
            `${command.name}: unknown option${unknown.length > 1 ? 's' : ''} ${unknown.map((key) => `"${key}"`).join(', ')} (${where}); allowed: ${allowed.join(', ') || 'none'}`,
          );
        }
      }
      if (['defer', 'if', 'for'].includes(command.name)) {
        for (const arg of command.args) {
          if (BLOCK_ARG.test(arg) && arg.slice(1, -1).trim()) validateShellProgram(parseShellProgram(arg.slice(1, -1)));
        }
      }
    }
  }
}

export function parseShellProgram(source: string): ShellProgram {
  if (typeof source !== 'string' || !source.trim()) {
    throw new ShellSyntaxError('script must be a non-empty string', 1, 1);
  }
  if (source.length > 65536) throw new ShellSyntaxError('script exceeds 64 KiB', 1, 1);
  const statements = splitTopLevelProgram(source).map((segment) => ({
    connector: segment.connector,
    pipeline: splitPipeline(segment).map((part) => parseCommand(part, segment.line)),
    line: segment.line,
    raw: segment.raw,
  }));
  if (!statements.length) throw new ShellSyntaxError('script has no commands', 1, 1);
  return { statements };
}
