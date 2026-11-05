#!/usr/bin/env node

import type { CommandResult } from './command/types';
import { Command } from 'commander';
import { promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { CHROME_SHELL_PORT_ENV, getChromeShellPort } from './constant';
import { readShellConfig } from './config';
import { readCommandPortState } from './command/port-state';
import {
  formatCommandResult,
  inlineJavascriptFiles,
  parseVariableAssignments,
  renderCommandHelp,
  parseVariablesJson,
  resolveCommandEndpoint,
} from './command/semantic-cli-core';

interface CliOptions {
  file?: string;
  stdin?: boolean;
  var: string[];
  varsJson?: string;
  varsFile?: string;
  tab?: string;
  window?: string;
  timeout: string;
  output: 'compact' | 'json' | 'debug';
  dryRun?: boolean;
  failFast?: boolean;
  quiet?: boolean;
  out?: string;
  printEntry?: boolean;
  workspace?: string;
  projectTools: boolean;
  endpoint: string;
  resultJson?: boolean;
  artifactDir?: string;
  timing?: boolean;
  expectedUrl?: string;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function parseOptionalInteger(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
}

async function resolveScript(parts: string[], options: CliOptions): Promise<string> {
  const hasArgument = parts.length > 0;
  const hasFile = Boolean(options.file);
  const shouldReadStdin =
    Boolean(options.stdin) || (!hasArgument && !hasFile && !process.stdin.isTTY);
  const sources = Number(hasArgument) + Number(hasFile) + Number(shouldReadStdin);
  if (sources !== 1) {
    throw new Error('provide exactly one script source: argument, --file, or --stdin');
  }
  const script = hasArgument
    ? parts.join(' ')
    : hasFile
      ? await fs.readFile(path.resolve(options.file!), 'utf8')
      : await readStdin();
  if (!script.trim()) throw new Error('script must not be empty');
  return script;
}

async function resolveVariables(options: CliOptions): Promise<Record<string, unknown>> {
  if (options.varsJson && options.varsFile) {
    throw new Error('--vars-json and --vars-file are mutually exclusive');
  }
  const document = options.varsFile
    ? await fs.readFile(path.resolve(options.varsFile), 'utf8')
    : options.varsJson;
  return {
    ...(document ? parseVariablesJson(document) : {}),
    ...parseVariableAssignments(options.var),
  };
}

async function main(): Promise<void> {
  const config = await readShellConfig();
  const explicitPort = process.env[CHROME_SHELL_PORT_ENV];
  const discoveredPort = explicitPort ? getChromeShellPort() : await readCommandPortState();
  const defaultEndpoint = `http://127.0.0.1:${discoveredPort || config.port}/chrome/shell`;
  const program = new Command()
    .name('chrome-shell')
    .description('Execute a Chrome Semantic Shell program in the connected browser')
    .version(require('../package.json').version)
    .argument('[script...]', 'Semantic Shell program')
    .option('-f, --file <path>', 'Read the Semantic Shell program from a UTF-8 file')
    .option('--stdin', 'Read the Semantic Shell program from stdin')
    .option('-v, --var <key=value>', 'Set a typed variable; repeatable', collect, [])
    .option('--vars-json <json>', 'Merge variables from a JSON object')
    .option('--vars-file <path>', 'Merge variables from a JSON file')
    .option('--tab <id>', 'Target Chrome tab ID')
    .option('--window <id>', 'Target Chrome window ID')
    .option('--timeout <ms>', 'Semantic program timeout', String(config.commandTimeoutMs))
    .option('--output <mode>', 'Semantic output: compact, json, or debug', 'compact')
    .option('--dry-run', 'Parse and validate without browser side effects')
    .option('--fail-fast', 'Stop at the first failed statement, even across ; and newlines')
    .option('--quiet', 'Omit the change/delta report of mutating programs')
    .option('--out <file>', 'Write the result to a UTF-8 file and print a one-line summary')
    .option('--print-entry', 'Print the absolute path of the CLI entry script (for node/python callers)')
    .option('-C, --workspace <path>', 'Workspace used for .webmcp tools', process.cwd())
    .option('--no-project-tools', 'Disable workspace .webmcp discovery and publishing')
    .option('--endpoint <url>', 'Local direct-command endpoint', defaultEndpoint)
    .option('--result-json', 'Print the complete command result envelope as JSON')
    .option('--artifact-dir <path>', 'Directory for image artifacts; defaults to a temp directory')
    .option('--timing', 'Print HTTP round-trip time to stderr')
    .option('--expected-url <url>', 'Fail before execution if the target tab URL changed')
    .allowExcessArguments(false);

  program.parse(process.argv);
  const options = program.opts<CliOptions>();
  if (options.printEntry) {
    process.stdout.write(`${__filename}\n`);
    return;
  }
  if (program.args[0] === 'help' && program.args.length <= 2) {
    process.stdout.write(`${renderCommandHelp(program.args[1])}\n`);
    return;
  }
  if (!['compact', 'json', 'debug'].includes(options.output)) {
    throw new Error('--output must be compact, json, or debug (write files with --out <file>)');
  }
  const timeoutMs = parseOptionalInteger(options.timeout, 'timeout');
  if (!timeoutMs || timeoutMs > 280_000) throw new Error('timeout must be between 1 and 280000');
  const source = await resolveScript(program.args, options);
  const outerQuote = /^\s*(["'])([\s\S]*)\1\s*$/.exec(source);
  if (outerQuote && !/["']/.test(outerQuote[2])) {
    throw new Error(
      'the whole program arrived wrapped in quotes (cmd.exe passes them through); drop the outer quotes, or use --file/--stdin',
    );
  }
  const baseDir = options.file ? path.dirname(path.resolve(options.file)) : process.cwd();
  const inlined = inlineJavascriptFiles(source, (file) =>
    readFileSync(path.resolve(baseDir, file), 'utf8'),
  );
  const script = inlined.script;
  const vars = { ...inlined.vars, ...(await resolveVariables(options)) };
  const endpoint = resolveCommandEndpoint(options.endpoint);
  const request = {
    script,
    ...(Object.keys(vars).length ? { vars } : {}),
    tabId: parseOptionalInteger(options.tab, 'tab'),
    windowId: parseOptionalInteger(options.window, 'window'),
    timeoutMs,
    output: options.output,
    dryRun: Boolean(options.dryRun),
    ...(options.failFast ? { failFast: true } : {}),
    ...(options.quiet ? { quiet: true } : {}),
    ...(options.expectedUrl ? { expectedUrl: options.expectedUrl } : {}),
    ...(options.projectTools
      ? { workspace: path.resolve(options.workspace || process.cwd()) }
      : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 6_000);
  const startedAt = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const raw = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error(
        `command endpoint returned non-JSON HTTP ${response.status}: ${raw.slice(0, 300)}`,
      );
    }
    if (!response.ok) {
      const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : body;
      throw new Error(`HTTP ${response.status}: ${String(error || 'command failed')}`);
    }
    const formatted = await formatCommandResult(body as CommandResult, {
      resultJson: Boolean(options.resultJson),
      artifactDirectory: options.artifactDir,
      output: options.output,
    });
    if (options.out) {
      const target = path.resolve(options.out);
      await fs.writeFile(target, `${formatted.text}\n`, 'utf8');
      const head = formatted.text.split('\n', 1)[0];
      process.stdout.write(`${options.output === 'json' ? (formatted.isError ? 'failed' : 'ok') : head} -> ${target} (${Buffer.byteLength(formatted.text)} bytes)\n`);
    } else {
      process.stdout.write(`${formatted.text}\n`);
    }
    if (options.timing) process.stderr.write(`roundtrip=${Date.now() - startedAt}ms\n`);
    if (formatted.isError) process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`chrome-shell: ${message}\n`);
  process.exitCode = 1;
});
