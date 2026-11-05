import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { compileOperation, digest, toolFingerprint, type LearnedManifest } from './operation-compiler';
import { discoverWorkspaceTools, invalidateWorkspaceToolsCache, type WorkspaceTool } from './workspace-tools';
import { pathToFileURL } from 'node:url';

type State = 'candidate' | 'active' | 'quarantined' | 'retired' | 'conflict';
interface Entry {
  manifest: LearnedManifest;
  state: State;
  successes: number;
  samples: string[];
  lastSeen: number;
  lastUsed: number;
  failures: number;
  reason?: string;
  publishedHash?: string;
}
interface Ledger {
  version: 1;
  entries: Record<string, Entry>;
  skipped: Record<string, number>;
}
interface Settings {
  enabled: boolean;
  minSuccesses: number;
  maxActive: number;
  idleDays: number;
}
interface Feedback { name: string; status: 'success' | 'failed'; category?: string }
interface Receipt {
  workspace: string;
  script: string;
  vars?: Record<string, unknown>;
  ok: boolean;
  pageUrl?: string;
  feedback?: Feedback[];
  tools: WorkspaceTool[];
}

const DEFAULTS: Settings = { enabled: true, minSuccesses: 2, maxActive: 32, idleDays: 30 };
const EMPTY = (): Ledger => ({ version: 1, entries: {}, skipped: {} });
const FILE_NAME = /^auto_[a-z]+_[a-f0-9]{12}$/;
const DAY = 86400000;

async function directory(root: string, segments: string[]): Promise<string> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try { await fs.mkdir(current); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe operation memory directory');
    const relative = path.relative(root, await fs.realpath(current));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Operation memory directory escapes workspace');
  }
  return current;
}

async function read(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('Unsafe operation memory file');
    return await fs.readFile(file, 'utf8');
  } catch (error: any) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function atomicWrite(file: string, text: string): Promise<void> {
  await read(file); // Reject symlink destinations, including existing files.
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch((error: any) => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** Background-only persistence. Browser success never waits for learning or maintenance. */
export class OperationMemory {
  private queue: Array<Receipt | { workspace: string; maintain: true }> = [];
  private pending?: Promise<void>;
  private wake?: ReturnType<typeof setTimeout>;
  private roots = new Set<string>();
  private visited = new Set<string>();
  private ledgers = new Map<string, Ledger>();
  private errors = new Map<string, string>();
  private timer: ReturnType<typeof setInterval>;
  private dropped = 0;

  constructor(private settingsFile = path.join(os.homedir(), '.agents', 'skills', 'chrome-shell', 'config.json'),
              private now = () => Date.now()) {
    this.timer = setInterval(() => {
      for (const workspace of this.roots) this.enqueue({ workspace, maintain: true });
    }, 60000);
    this.timer.unref();
  }

  close(): void { clearInterval(this.timer); if (this.wake) clearTimeout(this.wake); }

  touch(workspace: string): void {
    const key = path.resolve(workspace);
    if (this.visited.has(key)) return;
    this.visited.add(key);
    this.enqueue({ workspace: key, maintain: true });
  }

  observe(receipt: Receipt): void {
    if (!receipt.pageUrl && !receipt.feedback?.length) return;
    if (!receipt.feedback?.length && (!receipt.ok || !/\bassert\b/.test(receipt.script))) return;
    this.enqueue(receipt);
  }

  private enqueue(job: Receipt | { workspace: string; maintain: true }): void {
    if (this.queue.length >= 128) {
      this.dropped++;
      this.errors.set(job.workspace, 'learning_queue_full');
      return;
    }
    this.queue.push(job);
    if (!this.wake && !this.pending) {
      this.wake = setTimeout(() => { this.wake = undefined; void this.flush(); }, 25);
      this.wake.unref();
    }
  }

  async flush(): Promise<void> {
    if (this.wake) { clearTimeout(this.wake); this.wake = undefined; }
    if (this.pending) { await this.pending; if (this.queue.length) await this.flush(); return; }
    this.pending = (async () => {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        try { await this.process(job); this.errors.delete(job.workspace); }
        catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
            this.roots.delete(job.workspace); this.ledgers.delete(job.workspace); continue;
          }
          // File bodies, browser text and input values do not enter diagnostics.
          this.errors.set(job.workspace, 'learning_persistence_or_configuration_failed');
          console.error('[operation-memory] learning failed; inspect learn status', error instanceof Error ? error.name : 'Error');
        }
      }
    })();
    try { await this.pending; } finally { this.pending = undefined; }
  }

  private async settings(root: string): Promise<Settings> {
    const combined: Record<string, unknown> = { ...DEFAULTS };
    for (const file of [this.settingsFile, path.join(root, '.chrome-shell', 'config.json')]) {
      const raw = await read(file);
      if (raw !== undefined) Object.assign(combined, JSON.parse(raw).learning || {});
    }
    if (typeof combined.enabled !== 'boolean') throw new Error('learning.enabled must be boolean');
    for (const [key, min, max] of [['minSuccesses', 2, 100], ['maxActive', 1, 100], ['idleDays', 1, 365]] as const) {
      if (!Number.isInteger(combined[key]) || Number(combined[key]) < min || Number(combined[key]) > max) throw new Error(`Invalid learning.${key}`);
    }
    return combined as unknown as Settings;
  }

  private async load(root: string): Promise<Ledger> {
    if (this.ledgers.has(root)) return this.ledgers.get(root)!;
    // Verify every existing parent before reading state.
    const dir = await directory(root, ['.chrome-shell', 'learning']);
    const raw = await read(path.join(dir, 'state.json'));
    const ledger: Ledger = raw === undefined ? EMPTY() : JSON.parse(raw);
    if (ledger.version !== 1 || !ledger.entries || !ledger.skipped) throw new Error('Invalid operation memory ledger');
    for (const [key, entry] of Object.entries(ledger.entries)) {
      if (!/^[a-f0-9]{20}$/.test(key) || !FILE_NAME.test(entry.manifest?.name || '')
          || entry.manifest.learning?.owner !== 'chrome-shell' || entry.manifest.learning.key !== key) throw new Error('Invalid managed entry');
    }
    this.ledgers.set(root, ledger);
    return ledger;
  }

  private async save(root: string, ledger: Ledger): Promise<void> {
    const dir = await directory(root, ['.chrome-shell', 'learning']);
    await atomicWrite(path.join(dir, 'state.json'), JSON.stringify(ledger, null, 2) + '\n');
  }

  private async deactivate(root: string, entry: Entry, state: 'quarantined' | 'retired', reason: string): Promise<void> {
    const dir = await directory(root, ['.webmcp', 'learned']);
    const file = path.join(dir, `${entry.manifest.name}.tool.json`);
    const raw = await read(file);
    if (raw !== undefined && digest(raw) !== entry.publishedHash) {
      entry.state = 'conflict'; entry.reason = 'managed_file_modified'; return;
    }
    const archive = await directory(root, ['.chrome-shell', 'learning', 'archive']);
    const record = { reason, retiredAt: this.now(), manifest: entry.manifest, previousState: entry.state };
    await atomicWrite(path.join(archive, `${entry.manifest.name}-v${entry.manifest.learning.version}.json`), JSON.stringify(record, null, 2) + '\n');
    if (raw !== undefined) await fs.unlink(file);
    entry.state = state;
    entry.reason = reason;
    entry.successes = 0;
    entry.samples = [];
    delete entry.publishedHash;
    invalidateWorkspaceToolsCache();
  }

  private async publish(root: string, entry: Entry): Promise<void> {
    const dir = await directory(root, ['.webmcp', 'learned']);
    const file = path.join(dir, `${entry.manifest.name}.tool.json`);
    if (await read(file) !== undefined) {
      entry.state = 'conflict'; entry.reason = 'publish_destination_exists'; return;
    }
    const raw = JSON.stringify(entry.manifest, null, 2) + '\n';
    // wx prevents an untracked/user-authored file from being overwritten.
    await fs.writeFile(file, raw, { flag: 'wx', mode: 0o600 });
    entry.state = 'active';
    entry.publishedHash = digest(raw);
    entry.reason = undefined;
    entry.lastUsed = this.now();
    invalidateWorkspaceToolsCache();
  }

  private async process(job: Receipt | { workspace: string; maintain: true }): Promise<void> {
    const root = await fs.realpath(job.workspace);
    const settings = await this.settings(root);
    if (!settings.enabled) return;
    if ('maintain' in job && !this.ledgers.has(root)) {
      try {
        const state = await fs.realpath(path.join(root, '.chrome-shell', 'learning', 'state.json'));
        const relative = path.relative(root, state);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Operation memory escapes workspace');
      } catch (error: any) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
    }
    this.roots.add(root);
    const ledger = await this.load(root);
    if ('maintain' in job) {
      const tools = await discoverWorkspaceTools([pathToFileURL(root).href]);
      const fingerprints = new Map(tools.map((tool) => [tool.name, toolFingerprint(tool)]));
      for (const entry of Object.values(ledger.entries)) {
        if (entry.state !== 'active') continue;
        const activeDir = await directory(root, ['.webmcp', 'learned']);
        const current = await read(path.join(activeDir, `${entry.manifest.name}.tool.json`));
        if (current === undefined) {
          entry.state = 'quarantined'; entry.reason = 'artifact_missing'; entry.successes = 0; entry.samples = [];
          continue;
        }
        if (digest(current) !== entry.publishedHash) {
          entry.state = 'conflict'; entry.reason = 'managed_file_modified'; continue;
        }
        if (Object.entries(entry.manifest.dependencies).some(([name, hash]) => fingerprints.get(name) !== hash)) {
          await this.deactivate(root, entry, 'quarantined', 'dependency_changed');
        } else if (this.now() - entry.lastUsed > settings.idleDays * DAY) {
          await this.deactivate(root, entry, 'retired', 'unused_expired');
        }
      }
    } else {
      for (const feedback of job.feedback || []) {
        const entry = Object.values(ledger.entries).find((item) => item.manifest.name === feedback.name);
        if (!entry || entry.state !== 'active') continue;
        if (feedback.status === 'success') {
          entry.lastUsed = this.now(); entry.failures = 0;
        } else {
          entry.failures++;
          if (feedback.category === 'structural' || feedback.category === 'dependency_changed') {
            await this.deactivate(root, entry, 'quarantined', feedback.category);
          }
        }
      }
      if (job.ok && job.pageUrl) {
        const compiled = compileOperation(job.script, job.vars || {}, job.pageUrl, job.tools);
        if (!compiled.eligible) {
          ledger.skipped[compiled.reason] = (ledger.skipped[compiled.reason] || 0) + 1;
        } else {
          const { manifest, sampleHash } = compiled;
          let entry = ledger.entries[manifest.learning.key];
          if (entry?.state === 'active' && JSON.stringify(entry.manifest.dependencies) !== JSON.stringify(manifest.dependencies)) {
            await this.deactivate(root, entry, 'quarantined', 'dependency_changed');
          }
          if (!entry) {
            entry = ledger.entries[manifest.learning.key] = {
              manifest, state: 'candidate', successes: 0, samples: [], lastSeen: this.now(), lastUsed: 0, failures: 0,
            };
          } else if (['quarantined', 'retired'].includes(entry.state)) {
            manifest.learning.version = entry.manifest.learning.version + 1;
            entry.manifest = manifest; entry.state = 'candidate'; entry.successes = 0; entry.samples = [];
          }
          entry.lastSeen = this.now(); entry.successes++;
          if (!entry.samples.includes(sampleHash)) entry.samples = [...entry.samples, sampleHash].slice(-8);
          const varied = !manifest.inputSchema.required.length || entry.samples.length >= 2;
          if (entry.state === 'candidate' && entry.successes >= settings.minSuccesses && varied) await this.publish(root, entry);
        }
      }
    }
    const active = Object.values(ledger.entries).filter((entry) => entry.state === 'active').sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of active.slice(0, Math.max(0, active.length - settings.maxActive))) await this.deactivate(root, entry, 'retired', 'capacity_lru');
    // Bound non-active candidate memory as well as the active catalog.
    const candidates = Object.entries(ledger.entries).filter(([, e]) => e.state !== 'active' && e.state !== 'conflict').sort((a, b) => b[1].lastSeen - a[1].lastSeen);
    for (const [key] of candidates.slice(128)) delete ledger.entries[key];
    await this.save(root, ledger);
  }

  async status(workspace: string, maintain = false): Promise<unknown> {
    if (maintain) this.enqueue({ workspace, maintain: true });
    await this.flush();
    const root = await fs.realpath(workspace);
    const settings = await this.settings(root);
    const ledger = await this.load(root);
    return {
      enabled: settings.enabled, pending: this.queue.length, dropped: this.dropped,
      error: this.errors.get(workspace) || this.errors.get(root), skipped: ledger.skipped,
      operations: Object.values(ledger.entries).map((e) => ({
        name: e.manifest.name, state: e.state, version: e.manifest.learning.version,
        successes: e.successes, distinctInputs: e.samples.length, lastUsed: e.lastUsed, reason: e.reason,
      })),
    };
  }
}

export const operationMemory = new OperationMemory();
