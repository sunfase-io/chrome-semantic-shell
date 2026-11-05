import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NATIVE_SERVER_PORT } from './constant';

export interface ShellConfig {
  port: number;
  commandTimeoutMs: number;
}

export const DEFAULT_SHELL_CONFIG: ShellConfig = {
  port: NATIVE_SERVER_PORT,
  commandTimeoutMs: 30_000,
};

export function shellConfigPath(): string {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'chrome-semantic-shell', 'config.json');
}

function validInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : undefined;
}

export async function readShellConfig(file = shellConfigPath()): Promise<ShellConfig> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<ShellConfig>;
    return {
      port: validInteger(parsed.port, 1, 65_535) ?? DEFAULT_SHELL_CONFIG.port,
      commandTimeoutMs:
        validInteger(parsed.commandTimeoutMs, 1, 280_000) ?? DEFAULT_SHELL_CONFIG.commandTimeoutMs,
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { ...DEFAULT_SHELL_CONFIG };
    throw new Error(
      `Invalid shell config ${file}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

export async function writeShellConfig(
  patch: Partial<ShellConfig>,
  file = shellConfigPath(),
): Promise<ShellConfig> {
  const current = await readShellConfig(file);
  const next: ShellConfig = {
    port: patch.port ?? current.port,
    commandTimeoutMs: patch.commandTimeoutMs ?? current.commandTimeoutMs,
  };
  if (!validInteger(next.port, 1, 65_535)) throw new Error('port must be between 1 and 65535');
  if (!validInteger(next.commandTimeoutMs, 1, 280_000)) {
    throw new Error('timeout must be between 1 and 280000');
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
