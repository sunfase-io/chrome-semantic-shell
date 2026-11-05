import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearCommandPortState, readCommandPortState, writeCommandPortState } from './port-state';

describe('command port state', () => {
  it('shares the active native port with independent CLI processes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-port-state-'));
    const file = path.join(dir, 'port.json');
    try {
      await writeCommandPortState(23456, file);
      await expect(readCommandPortState(file)).resolves.toBe(23456);
      await clearCommandPortState(file);
      await expect(readCommandPortState(file)).resolves.toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps a live process state valid beyond 24 hours', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-port-state-old-'));
    const file = path.join(dir, 'port.json');
    try {
      await fs.writeFile(
        file,
        JSON.stringify({
          pid: process.pid,
          port: 23457,
          updatedAt: Date.now() - 48 * 60 * 60 * 1000,
        }),
      );
      await expect(readCommandPortState(file)).resolves.toBe(23457);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
