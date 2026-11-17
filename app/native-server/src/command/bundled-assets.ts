import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The npm package ships the built Chrome extension and the agent skill, so a plain
 * `npm install -g chrome-semantic-shell` puts both on disk without a GitHub download.
 * `prepack` stages them from the workspace; the bridge CLI hands them out at runtime.
 */
export const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
export const EXTENSION_SUBDIR = 'extension';
export const SKILL_SUBDIR = path.join('skill', 'chrome-shell');
/** Development files that stay out of the shipped skill, same as the release skill zip. */
const SKILL_EXCLUDED = new Set(['evals', '__pycache__']);

export const bundledExtensionDir = (root = PACKAGE_ROOT) => path.join(root, EXTENSION_SUBDIR);
export const bundledSkillDir = (root = PACKAGE_ROOT) => path.join(root, SKILL_SUBDIR);
export const defaultExtensionDir = (home = os.homedir()) =>
  path.join(home, '.chrome-semantic-shell', 'extension');

export interface ExtensionInfo {
  version: string;
  id: string;
}

/** Chrome derives an unpacked extension's ID from the manifest key: SHA-256 of the DER, hex digits mapped to a-p. */
export function extensionIdFromKey(key: string): string {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('');
}

export async function readExtensionInfo(dir: string): Promise<ExtensionInfo> {
  const file = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as {
    version?: unknown;
    key?: unknown;
  };
  if (typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error(`${file} has no version`);
  }
  if (typeof manifest.key !== 'string' || !manifest.key) {
    throw new Error(`${file} has no key; the extension ID would not be stable`);
  }
  return { version: manifest.version, id: extensionIdFromKey(manifest.key) };
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

/** Replaces `target` with a fresh copy of the bundled extension, so an upgrade never keeps stale files. */
export async function installExtension(
  target: string,
  source = bundledExtensionDir(),
): Promise<ExtensionInfo & { dir: string }> {
  const dir = path.resolve(target);
  const info = await readExtensionInfo(source);
  if (dir === path.resolve(source))
    throw new Error(`target ${dir} is the bundled extension itself`);
  const entries = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  if (entries.length && !entries.includes('manifest.json')) {
    throw new Error(
      `${dir} is not empty and holds no extension (manifest.json); refusing to replace it`,
    );
  }
  await fs.rm(dir, { recursive: true, force: true });
  await fs.cp(source, dir, { recursive: true });
  return { dir, ...info };
}

export async function resolveSkillDir(root = PACKAGE_ROOT): Promise<string> {
  const dir = bundledSkillDir(root);
  if (!(await exists(path.join(dir, 'SKILL.md')))) {
    throw new Error(`bundled skill not found at ${dir}; reinstall chrome-semantic-shell`);
  }
  return dir;
}

export interface StageOptions {
  /** Built extension (dist-extension/chrome-mv3). */
  extensionSource: string;
  /** Skill source (skills/chrome-shell). */
  skillSource: string;
  packageRoot: string;
  /** The package version; the bundled extension must carry the same one. */
  version: string;
  allowedIds: readonly string[];
}

/** Copies the built extension and the skill into the package before `npm pack`. */
export async function stageBundledAssets(options: StageOptions): Promise<ExtensionInfo> {
  const info = await readExtensionInfo(options.extensionSource);
  if (info.version !== options.version) {
    throw new Error(
      `built extension is ${info.version} but the package is ${options.version}; rebuild the extension`,
    );
  }
  if (!options.allowedIds.includes(info.id)) {
    throw new Error(`built extension ID ${info.id} is not accepted by the native host`);
  }
  if (!(await exists(path.join(options.skillSource, 'SKILL.md')))) {
    throw new Error(`${options.skillSource} has no SKILL.md`);
  }
  const extensionDir = bundledExtensionDir(options.packageRoot);
  const skillRoot = path.dirname(bundledSkillDir(options.packageRoot));
  await Promise.all(
    [extensionDir, skillRoot].map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
  await fs.cp(options.extensionSource, extensionDir, { recursive: true });
  await fs.cp(options.skillSource, bundledSkillDir(options.packageRoot), {
    recursive: true,
    filter: (file) => !SKILL_EXCLUDED.has(path.basename(file)) && !file.endsWith('.pyc'),
  });
  return info;
}
