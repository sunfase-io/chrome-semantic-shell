import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface PortState {
  pid: number;
  port: number;
  updatedAt: number;
}

export function commandPortStatePath(): string {
  return path.join(os.tmpdir(), 'chrome-semantic-shell-port.json');
}

export async function writeCommandPortState(
  port: number,
  file = commandPortStatePath(),
): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid command port: ${port}`);
  }
  const state: PortState = { pid: process.pid, port, updatedAt: Date.now() };
  await fs.writeFile(file, JSON.stringify(state), { encoding: 'utf8', flag: 'w' });
}

export async function readCommandPortState(
  file = commandPortStatePath(),
): Promise<number | undefined> {
  try {
    const state = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<PortState>;
    if (
      !Number.isInteger(state.pid) ||
      !Number.isInteger(state.port) ||
      Number(state.port) < 1 ||
      Number(state.port) > 65535 ||
      typeof state.updatedAt !== 'number'
    ) {
      return undefined;
    }
    try {
      process.kill(Number(state.pid), 0);
    } catch {
      return undefined;
    }
    return Number(state.port);
  } catch {
    return undefined;
  }
}

export async function clearCommandPortState(file = commandPortStatePath()): Promise<void> {
  try {
    const state = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<PortState>;
    if (state.pid !== process.pid) return;
    await fs.unlink(file);
  } catch (error: any) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
}
