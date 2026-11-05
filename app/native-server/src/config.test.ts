import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_SHELL_CONFIG, readShellConfig, writeShellConfig } from './config';

describe('shell config', () => {
  let directory = '';
  let file = '';

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-shell-config-'));
    file = path.join(directory, 'config.json');
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('uses defaults when the config file does not exist', async () => {
    await expect(readShellConfig(file)).resolves.toEqual(DEFAULT_SHELL_CONFIG);
  });

  it('persists a validated port and default command timeout', async () => {
    await expect(
      writeShellConfig({ port: 12307, commandTimeoutMs: 45_000 }, file),
    ).resolves.toEqual({ port: 12307, commandTimeoutMs: 45_000 });
    await expect(readShellConfig(file)).resolves.toEqual({
      port: 12307,
      commandTimeoutMs: 45_000,
    });
  });

  it('rejects invalid values instead of silently falling back', async () => {
    await expect(writeShellConfig({ port: 70_000 }, file)).rejects.toThrow('port');
    await expect(writeShellConfig({ commandTimeoutMs: 0 }, file)).rejects.toThrow('timeout');
  });
});
