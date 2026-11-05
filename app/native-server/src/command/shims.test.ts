import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findShimDirectories, inspectShims, installShims, renderShims, SHIM_MARKER } from './shims';
import { renderCommandHelp } from './semantic-cli-core';

describe('managed chrome-shell launchers', () => {
  it('decode UTF-8 in PowerShell and call the entry by absolute path', () => {
    const shims = renderShims("D:\\Tools\\it's\\semantic-cli.js");
    expect(shims['chrome-shell.ps1']).toContain("$entry = 'D:\\Tools\\it''s\\semantic-cli.js'");
    expect(shims['chrome-shell.ps1']).toContain('[Console]::OutputEncoding = $utf8');
    expect(shims['chrome-shell.ps1']).toContain('exit $LASTEXITCODE');
    expect(shims['chrome-shell']).toContain('exec node "D:/Tools/it\'s/semantic-cli.js" "$@"');
    expect(shims['chrome-shell.cmd']).toContain('node "D:\\Tools\\it\'s\\semantic-cli.js" %*');
  });

  it('replaces only the launchers found on PATH and reports their state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-shims-'));
    try {
      const bin = path.join(root, 'bin');
      const other = path.join(root, 'other');
      await fs.mkdir(bin);
      await fs.mkdir(other);
      await fs.writeFile(path.join(bin, 'chrome-shell.ps1'), 'pnpm shim');
      const entry = path.join(root, 'semantic-cli.js');
      await fs.writeFile(entry, '');
      const dirs = await findShimDirectories({ PATH: [bin, other].join(path.delimiter) });
      expect(dirs).toEqual([path.resolve(bin)]);
      expect((await inspectShims(dirs)).map((shim) => shim.managed)).toEqual([false]);
      await installShims(entry, dirs);
      const states = await inspectShims(dirs);
      expect(states).toHaveLength(3);
      expect(states.every((shim) => shim.managed)).toBe(true);
      expect(await fs.readFile(path.join(bin, 'chrome-shell'), 'utf8')).toContain(SHIM_MARKER);
      await expect(installShims(path.join(root, 'missing.js'), dirs)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('local help', () => {
  it('lists commands and the options a command accepts', () => {
    expect(renderCommandHelp()).toContain('http [GET|POST|...] URL');
    expect(renderCommandHelp('js')).toContain('options: code, file, frame, max');
    expect(() => renderCommandHelp('nope')).toThrow('unknown command');
  });
});
