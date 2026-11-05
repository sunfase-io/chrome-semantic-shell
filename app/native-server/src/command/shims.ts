import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Managed launchers for the `chrome-shell` CLI.
 *
 * Package-manager shims resolve the entry relative to their own directory and leave decoding to the
 * caller: Windows PowerShell then reads the CLI's UTF-8 output with the console code page (cp936 on
 * Chinese Windows) and corrupts every non-ASCII character, and Git Bash shims depend on `dirname`.
 * Managed shims call the entry by absolute path and decode UTF-8 themselves.
 */
export const SHIM_MARKER = 'chrome-shell managed shim';
const NAMES = ['chrome-shell.ps1', 'chrome-shell.cmd', 'chrome-shell'] as const;

export function renderShims(entry: string): Record<(typeof NAMES)[number], string> {
  const windowsEntry = path.win32.normalize(entry);
  const posixEntry = entry.replace(/\\/g, '/');
  const quotedPs = windowsEntry.replace(/'/g, "''");
  return {
    'chrome-shell.ps1': `#!/usr/bin/env pwsh
# ${SHIM_MARKER}: reads the CLI's UTF-8 output regardless of the console code page.
# The encoding stays UTF-8 afterwards on purpose: PowerShell re-encodes the decoded text when it
# writes its own output, and a restored legacy code page (cp936) would corrupt it on that second leg.
$entry = '${quotedPs}'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$previousOutput = [Console]::OutputEncoding
try {
  [Console]::OutputEncoding = $utf8
} catch {
  # Hosts without a console keep their encoding.
}
$OutputEncoding = $utf8
$piped = $MyInvocation.ExpectingInput
try {
  if ($piped) { $input | & node $entry @args } else { & node $entry @args }
} catch [System.InvalidOperationException] {
  # Some PowerShell builds refuse a custom output encoding when stdout is the terminal itself;
  # the process never started, so running it again with the original encoding is safe.
  if ($_.Exception.Message -notmatch 'StandardOutputEncoding') { throw }
  [Console]::OutputEncoding = $previousOutput
  if ($piped) { $input | & node $entry @args } else { & node $entry @args }
}
exit $LASTEXITCODE
`,
    'chrome-shell.cmd': `@ECHO off\r\nREM ${SHIM_MARKER}\r\nnode "${windowsEntry}" %*\r\n`,
    'chrome-shell': `#!/bin/sh\n# ${SHIM_MARKER}\nexec node "${posixEntry}" "$@"\n`,
  };
}

export interface ShimState {
  dir: string;
  file: string;
  managed: boolean;
}

/** Directories on PATH that already hold a chrome-shell launcher (the ones the shell resolves). */
export async function findShimDirectories(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const dirs = new Set<string>();
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const name of NAMES) {
      try {
        await fs.access(path.join(dir, name));
        dirs.add(path.resolve(dir));
        break;
      } catch {
        // not here
      }
    }
  }
  return [...dirs];
}

export async function inspectShims(dirs: string[]): Promise<ShimState[]> {
  const states: ShimState[] = [];
  for (const dir of dirs) {
    for (const name of NAMES) {
      const file = path.join(dir, name);
      const text = await fs.readFile(file, 'utf8').catch(() => undefined);
      if (text !== undefined) states.push({ dir, file, managed: text.includes(SHIM_MARKER) });
    }
  }
  return states;
}

export async function installShims(entry: string, dirs: string[]): Promise<string[]> {
  await fs.access(entry);
  const shims = renderShims(entry);
  const written: string[] = [];
  for (const dir of dirs) {
    for (const name of NAMES) {
      const file = path.join(dir, name);
      await fs.writeFile(file, shims[name], 'utf8');
      if (name === 'chrome-shell') await fs.chmod(file, 0o755).catch(() => undefined);
      written.push(file);
    }
  }
  return written;
}
