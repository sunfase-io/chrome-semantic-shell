import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bundledExtensionDir,
  bundledSkillDir,
  defaultExtensionDir,
  extensionIdFromKey,
  installExtension,
  resolveSkillDir,
  stageBundledAssets,
} from './bundled-assets';
import { EXTENSION_IDS } from '../scripts/constant';

// The repository's stable public key (app/chrome-extension/wxt.config.ts).
const KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArrtfHInqCGPqhB2Wr+z6mP529Nye6esnyMUN0gHDZ58rrdn7BsLvooGBx2eZETh30Hle0drFiJHOuqYkQ86ACRqf7UTcPzbSybH5vUR3eOhKCa5BVPXHgvRpl0Zcg+E8iBCegwFNWK8T4FaLz6K5iQpgVy4tbdPEDtMOc/VJMTgtmOGpBLn1s2/30AGE5YFr6MDdpsxOASlAo5DCTk0VKha9fNnnFguCD20vZ/bau8qEA3bNtCoHEgyMFD4S9NIIUZ79P9SePPkAKwUdeBiO9xaUaktGAQz1DIQZgv5hegRgDJ2WWPNAE43NwY8gMvu31TBqCnXwxN8pSRtds+vPgwIDAQAB';
const ID = 'hnhimbinihlfejljamlgfniplabkaamk';

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function list(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
    .sort();
}

describe('bundled extension and skill', () => {
  let root: string;
  let extension: string;
  let skill: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-bundled-'));
    extension = path.join(root, 'dist-extension', 'chrome-mv3');
    skill = path.join(root, 'skills', 'chrome-shell');
    await write(
      path.join(extension, 'manifest.json'),
      JSON.stringify({ version: '1.2.0', key: KEY }),
    );
    await write(path.join(extension, 'inject-scripts', 'click-helper.js'), 'click');
    await write(path.join(skill, 'SKILL.md'), '# skill');
    await write(path.join(skill, 'references', 'semantic-shell.md'), 'ref');
    await write(path.join(skill, 'scripts', 'jev_flow.py'), 'flow');
    await write(path.join(skill, 'scripts', '__pycache__', 'jev_flow.cpython-312.pyc'), 'cache');
    await write(path.join(skill, 'evals', 'test_jev_flow.py'), 'test');
  });

  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  const stage = (overrides: Partial<Parameters<typeof stageBundledAssets>[0]> = {}) =>
    stageBundledAssets({
      extensionSource: extension,
      skillSource: skill,
      packageRoot: path.join(root, 'pkg'),
      version: '1.2.0',
      allowedIds: EXTENSION_IDS,
      ...overrides,
    });

  it('derives the extension ID from the manifest key the way Chrome does', () => {
    expect(extensionIdFromKey(KEY)).toBe(ID);
    expect(EXTENSION_IDS).toContain(ID);
  });

  it('stages the extension and the skill without development files', async () => {
    const pkg = path.join(root, 'pkg');
    await write(path.join(bundledExtensionDir(pkg), 'stale.js'), 'old');
    await expect(stage()).resolves.toEqual({ version: '1.2.0', id: ID });
    expect(await list(bundledExtensionDir(pkg))).toEqual([
      'inject-scripts/click-helper.js',
      'manifest.json',
    ]);
    expect(await list(bundledSkillDir(pkg))).toEqual([
      'SKILL.md',
      'references/semantic-shell.md',
      'scripts/jev_flow.py',
    ]);
    await expect(resolveSkillDir(pkg)).resolves.toBe(bundledSkillDir(pkg));
  });

  it('refuses a stale, unkeyed or foreign extension build and a missing skill', async () => {
    await expect(stage({ version: '1.3.0' })).rejects.toThrow(
      'built extension is 1.2.0 but the package is 1.3.0',
    );
    await expect(stage({ allowedIds: [] })).rejects.toThrow(`ID ${ID} is not accepted`);
    await expect(stage({ skillSource: root })).rejects.toThrow('has no SKILL.md');
    await write(path.join(extension, 'manifest.json'), JSON.stringify({ version: '1.2.0' }));
    await expect(stage()).rejects.toThrow('has no key');
    await write(path.join(extension, 'manifest.json'), JSON.stringify({ key: KEY }));
    await expect(stage()).rejects.toThrow('has no version');
    await expect(resolveSkillDir(path.join(root, 'missing'))).rejects.toThrow(
      'bundled skill not found',
    );
  });

  it('installs a fresh copy over an older extension folder', async () => {
    const target = path.join(root, 'home', '.chrome-semantic-shell', 'extension');
    await expect(installExtension(target, extension)).resolves.toEqual({
      dir: target,
      version: '1.2.0',
      id: ID,
    });
    await write(path.join(target, 'old-chunk.js'), 'old');
    await installExtension(target, extension);
    expect(await list(target)).toEqual(['inject-scripts/click-helper.js', 'manifest.json']);
    expect(defaultExtensionDir(path.join(root, 'home'))).toBe(target);
  });

  it('never replaces an unrelated folder or the bundled copy itself', async () => {
    const unrelated = path.join(root, 'documents');
    await write(path.join(unrelated, 'notes.txt'), 'keep');
    await expect(installExtension(unrelated, extension)).rejects.toThrow('refusing to replace it');
    expect(await list(unrelated)).toEqual(['notes.txt']);
    await expect(installExtension(extension, extension)).rejects.toThrow(
      'is the bundled extension itself',
    );
  });
});
