import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WorkspaceTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown> | string;
  readOnly?: boolean;
  source: 'snippet' | 'operation' | 'learned';
  kind: 'javascript' | 'http-sequence' | 'semantic-sequence';
  code?: string;
  manifest?: Record<string, unknown>;
  file: string;
}

export interface WorkspacePublishRequest {
  name: string;
  manifest: Record<string, unknown>;
}

const MAX_ROOTS = 16;
const MAX_FILES = 100;
/** Per-file cap; the whole catalog travels in every native message (1 MB Chrome limit). */
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CATALOG_BYTES = 768 * 1024;

export interface SkippedWorkspaceTool {
  file: string;
  reason: string;
}

export interface WorkspaceToolCatalog {
  tools: WorkspaceTool[];
  skipped: SkippedWorkspaceTool[];
}

const cache = new Map<string, { expiresAt: number; catalog: WorkspaceToolCatalog }>();

export function invalidateWorkspaceToolsCache(): void {
  cache.clear();
}

function safeName(value: unknown): string {
  const name = String(value || '').trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name)) {
    throw new Error(`Invalid workspace tool name "${name}"`);
  }
  return name;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function rootPath(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return null;
    return path.resolve(fileURLToPath(parsed));
  } catch {
    return null;
  }
}

async function readSmallFile(file: string): Promise<string> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${file}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`Workspace tool file exceeds 256 KiB: ${file}`);
  return await fs.readFile(file, 'utf8');
}

async function realDirectoryInside(root: string, candidate: string): Promise<string | null> {
  try {
    const real = await fs.realpath(candidate);
    const stat = await fs.stat(real);
    return stat.isDirectory() && isInside(root, real) ? real : null;
  } catch {
    return null;
  }
}

async function ensureDirectoryInside(root: string, segments: string[]): Promise<string> {
  let current = root;
  for (const segment of segments) {
    const candidate = path.join(current, segment);
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Unsafe workspace directory: ${candidate}`);
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      await fs.mkdir(candidate);
    }
    current = await fs.realpath(candidate);
    if (!isInside(root, current)) throw new Error(`Workspace directory escapes root: ${candidate}`);
  }
  return current;
}

function parseLegacySnippet(file: string, code: string): WorkspaceTool | null {
  const header = code.split(/\r?\n/).slice(0, 20);
  const read = (key: string) =>
    header
      .map((line) => line.match(new RegExp(`^\\s*//\\s*${key}\\s*:\\s*(.+)$`, 'i'))?.[1]?.trim())
      .find(Boolean);
  const rawName = read('tool');
  if (!rawName) return null;
  return {
    name: safeName(rawName),
    description: read('description'),
    inputSchema: read('input'),
    readOnly: read('readonly')?.toLowerCase() === 'true' || undefined,
    source: 'snippet',
    kind: 'javascript',
    code,
    file,
  };
}

async function parseManifest(root: string, file: string): Promise<WorkspaceTool> {
  const raw = await readSmallFile(file);
  const manifest = JSON.parse(raw) as Record<string, unknown>;
  const name = safeName(manifest.name);
  const kind = manifest.kind === 'semantic-sequence' ? 'semantic-sequence'
    : manifest.kind === 'http-sequence' ? 'http-sequence' : 'javascript';
  if (kind === 'semantic-sequence' && (typeof manifest.script !== 'string' || !manifest.script.trim())) {
    throw new Error(`Semantic workspace tool "${name}" is missing script`);
  }
  let code: string | undefined;
  if (kind === 'javascript') {
    const entry = String(manifest.entry || '').trim();
    if (!entry) throw new Error(`JavaScript workspace tool "${name}" is missing entry`);
    const target = path.resolve(path.dirname(file), entry);
    if (!isInside(root, target))
      throw new Error(`Workspace tool entry escapes workspace root: ${entry}`);
    const realTarget = await fs.realpath(target);
    if (!isInside(root, realTarget)) {
      throw new Error(`Workspace tool entry resolves outside workspace root: ${entry}`);
    }
    code = await readSmallFile(realTarget);
  }
  return {
    name,
    description: typeof manifest.description === 'string' ? manifest.description : undefined,
    inputSchema:
      manifest.inputSchema && typeof manifest.inputSchema === 'object'
        ? (manifest.inputSchema as Record<string, unknown>)
        : undefined,
    readOnly: manifest.readOnly === true || undefined,
    source: kind === 'semantic-sequence' ? 'learned' : kind === 'http-sequence' ? 'operation' : 'snippet',
    kind,
    code,
    manifest,
    file,
  };
}

async function listFiles(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (files.length >= MAX_FILES) break;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(target, depth - 1)));
    else if (entry.isFile()) files.push(target);
  }
  return files.slice(0, MAX_FILES);
}

export async function discoverWorkspaceTools(rootUris: string[]): Promise<WorkspaceTool[]> {
  return (await discoverWorkspaceToolCatalog(rootUris)).tools;
}

/** Tools plus the files that could not be loaded, so callers can report why a tool is missing. */
export async function discoverWorkspaceToolCatalog(rootUris: string[]): Promise<WorkspaceToolCatalog> {
  const roots = rootUris
    .slice(0, MAX_ROOTS)
    .map(rootPath)
    .filter((x): x is string => Boolean(x));
  const extra = String(process.env.CHROME_SHELL_SNIPPET_DIRS || '')
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));
  const allRoots = [
    ...new Set(
      (
        await Promise.all(
          [...roots, ...extra].map(async (root) => {
            try {
              return await fs.realpath(root);
            } catch {
              return null;
            }
          }),
        )
      ).filter((root): root is string => Boolean(root)),
    ),
  ];
  const key = allRoots.join('|');
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.catalog;

  const tools: WorkspaceTool[] = [];
  const skipped: SkippedWorkspaceTool[] = [];
  let catalogBytes = 0;
  const names = new Set<string>();
  for (const root of allRoots) {
    const requestedWebmcp = root.endsWith('.webmcp') ? root : path.join(root, '.webmcp');
    const webmcp = await realDirectoryInside(root, requestedWebmcp);
    if (!webmcp) continue;
    const files = await listFiles(webmcp, 2);
    for (const file of files) {
      if (tools.length >= MAX_FILES) break;
      try {
        let tool: WorkspaceTool | null = null;
        if (file.endsWith('.tool.json')) tool = await parseManifest(root, file);
        else if (file.endsWith('.js')) tool = parseLegacySnippet(file, await readSmallFile(file));
        if (!tool) continue;
        if (names.has(tool.name)) {
          skipped.push({ file, reason: `duplicate tool name "${tool.name}"` });
          continue;
        }
        const bytes = Buffer.byteLength(JSON.stringify(tool));
        if (catalogBytes + bytes > MAX_CATALOG_BYTES) {
          skipped.push({ file, reason: `workspace tool catalog exceeds ${MAX_CATALOG_BYTES / 1024} KiB` });
          continue;
        }
        catalogBytes += bytes;
        names.add(tool.name);
        tools.push(tool);
      } catch (error) {
        skipped.push({ file, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const catalog = { tools, skipped };
  cache.set(key, { expiresAt: Date.now() + 2000, catalog });
  return catalog;
}

function containsSensitiveValue(value: unknown, key = ''): boolean {
  if (/authorization|cookie|token|secret|password|proxy-authorization/i.test(key)) return true;
  if (
    typeof value === 'string' &&
    (/\bBearer\s+[A-Za-z0-9._~-]+/i.test(value) ||
      /[?&](access_token|token|api_key|signature|password)=[^&{]+/i.test(value) ||
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.some((entry) => containsSensitiveValue(entry));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([childKey, child]) =>
      containsSensitiveValue(child, childKey),
    );
  }
  return false;
}

export async function publishWorkspaceTool(
  rootUris: string[],
  request: WorkspacePublishRequest,
): Promise<string> {
  const requestedRoot = rootUris.map(rootPath).find((value): value is string => Boolean(value));
  if (!requestedRoot)
    throw new Error('No writable file:// workspace root is available for capture publish');
  const root = await fs.realpath(requestedRoot);
  const name = safeName(request.name);
  if (containsSensitiveValue(request.manifest.requests)) {
    throw new Error(
      'Operation manifest contains a sensitive field; authorization/cookies/tokens are never persisted',
    );
  }
  const dir = await ensureDirectoryInside(root, ['.webmcp', 'operations']);
  const target = path.resolve(dir, `${name}.tool.json`);
  if (!isInside(root, target)) throw new Error('Operation publish target escapes workspace root');
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) {
      throw new Error(`Operation publish target is a symbolic link: ${target}`);
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.writeFile(target, JSON.stringify(request.manifest, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'w',
  });
  cache.clear();
  return target;
}
