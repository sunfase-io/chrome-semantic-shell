import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileOperation } from './operation-compiler';
import { OperationMemory } from './operation-memory';
import { discoverWorkspaceTools, invalidateWorkspaceToolsCache, type WorkspaceTool } from './workspace-tools';
import { pathToFileURL } from 'node:url';

const script = 'fillform 昵称=$name && query role=button name="保存" | click && assert text="保存成功"';
const pageUrl = 'https://example.test/profile';

describe('automatic operation compilation', () => {
  it('learns the same typed template from different data without persisting examples', () => {
    const a = compileOperation(script, { name: 'example-A' }, pageUrl, []);
    const b = compileOperation(script, { name: 'example-B' }, pageUrl, []);
    expect(a.eligible && b.eligible).toBe(true);
    if (!a.eligible || !b.eligible) throw new Error('expected eligible');
    expect(a.manifest).toEqual(b.manifest);
    expect(a.sampleHash).not.toBe(b.sampleHash);
    expect(JSON.stringify(a.manifest)).not.toContain('example-A');
    expect(a.manifest.script).toContain('昵称=$arg1');
    expect(a.manifest.inputSchema.properties.arg1.type).toBe('string');
  });

  it('does not confuse caller variable names with generated parameter names', () => {
    const result = compileOperation('fillform A=$first B=$arg1 && assert text="ok"', { first: 'x', arg1: 7 }, pageUrl, []);
    expect(result.eligible).toBe(true);
    if (!result.eligible) throw new Error('expected eligible');
    expect(result.manifest.inputSchema.properties.arg2.type).toBe('number');
    expect(result.manifest.script).toContain('B=$arg2');
  });

  it.each([
    ['fillform 密码=$value && assert text="ok"', { value: 'private' }],
    ['fillform 姓名=$value && assert text="ok"', { value: 'Bearer private-value' }],
    ['click @ref_12 && assert text="ok"', {}],
    ['js code="return true" && assert text="ok"', {}],
    ['query "保存" | click', {}],
    ['query "保存" | click || assert text="ok"', {}],
    ['query "保存" | click && wait 500 && assert text="ok"', {}],
  ])('rejects ungrounded, sensitive or unverified recipes: %s', (source, vars) => {
    expect(compileOperation(source, vars, pageUrl, []).eligible).toBe(false);
  });

  it('parameterizes business row keywords rather than baking one record into the macro', () => {
    const result = compileOperation('query role=row query="ORDER-ABC" | query role=button name="查看" scope=pipe | click && assert text="详情"', {}, pageUrl, []);
    expect(result.eligible).toBe(true);
    if (!result.eligible) throw new Error('expected eligible');
    expect(result.manifest.script).not.toContain('ORDER-ABC');
    expect(result.manifest.script).toContain('query=$arg1');
  });

  it('preserves dependent fillform field order and binds query/hash page identity', () => {
    const source = 'fillform Z=$org A=$record && assert text="ready"';
    const a = compileOperation(source, { org: 'alpha', record: 'one' }, 'https://example.test/app?record=1#/edit', []);
    const b = compileOperation(source, { org: 'beta', record: 'two' }, 'https://example.test/app?record=2#/edit', []);
    if (!a.eligible || !b.eligible) throw new Error('expected eligible');
    expect(a.manifest.script).toContain('fillform Z=$arg1 A=$arg2');
    expect(a.manifest.scope.href).toBe('https://example.test/app?record=1#/edit');
    expect(a.manifest.name).not.toBe(b.manifest.name);
    expect(compileOperation(source, { org: 'a', record: 'b' }, 'https://example.test/?token=secret', []).eligible).toBe(false);
  });
});

describe('automatic operation lifecycle', () => {
  let root: string;
  let settings: string;
  let memory: OperationMemory;
  let now = 100000;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-learning-test-'));
    settings = path.join(root, 'settings.json');
    await fs.writeFile(settings, JSON.stringify({ learning: { idleDays: 1, minSuccesses: 2, maxActive: 2 } }));
    memory = new OperationMemory(settings, () => now);
  });
  afterEach(async () => {
    await memory.flush(); memory.close(); invalidateWorkspaceToolsCache();
    await fs.rm(root, { recursive: true, force: true });
  });
  const observe = (value: string, ok = true) => memory.observe({ workspace: root, script, vars: { name: value }, pageUrl, ok, tools: [] });

  it('automatically publishes only after independent successful input examples', async () => {
    observe('first'); observe('first');
    expect((await memory.status(root) as any).operations[0].state).toBe('candidate');
    observe('second');
    const status = await memory.status(root) as any;
    expect(status.operations[0].state).toBe('active');
    const tools = await discoverWorkspaceTools([pathToFileURL(root).href]);
    expect(tools).toHaveLength(1);
    expect(tools[0].kind).toBe('semantic-sequence');
    expect(JSON.stringify(tools[0].manifest)).not.toMatch(/first|second/);
  });

  it('does not admit failed executions and respects the disabled setting', async () => {
    observe('first', false); observe('second', false);
    expect((await memory.status(root) as any).operations).toEqual([]);
    await fs.writeFile(settings, JSON.stringify({ learning: { enabled: false } }));
    observe('first'); observe('second');
    expect((await memory.status(root) as any).operations).toEqual([]);
  });

  it('quarantines a structurally broken tool, then learns a new revision from fresh successes', async () => {
    observe('first'); observe('second');
    const entry = (await memory.status(root) as any).operations[0];
    memory.observe({ workspace: root, script: '', ok: false, tools: [], feedback: [{ name: entry.name, status: 'failed', category: 'structural' }] });
    expect((await memory.status(root) as any).operations[0].state).toBe('quarantined');
    expect(await discoverWorkspaceTools([pathToFileURL(root).href])).toEqual([]);
    observe('third'); observe('fourth');
    const updated = (await memory.status(root) as any).operations[0];
    expect(updated.state).toBe('active'); expect(updated.version).toBe(2);
    expect(await fs.readdir(path.join(root, '.chrome-shell/learning/archive'))).toHaveLength(1);
  });

  it('retires unused generated tools but never deletes a manually modified artifact', async () => {
    observe('first'); observe('second');
    const entry = (await memory.status(root) as any).operations[0];
    const file = path.join(root, '.webmcp/learned', `${entry.name}.tool.json`);
    now += 2 * 86400000;
    expect((await memory.status(root, true) as any).operations[0].state).toBe('retired');
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    observe('third'); observe('fourth'); await memory.flush();
    await fs.appendFile(file, '\n ');
    now += 2 * 86400000;
    expect((await memory.status(root, true) as any).operations[0].state).toBe('conflict');
    expect(await fs.readFile(file, 'utf8')).toMatch(/\n $/);
  });

  it('detects a changed dependency before promoting a replacement revision', async () => {
    const dependency: WorkspaceTool = { name: 'search', source: 'snippet', kind: 'javascript', code: 'return 1', file: 'search.js' };
    const source = 'call search input=$payload && assert text="results"';
    for (const q of ['a', 'b']) memory.observe({ workspace: root, script: source, vars: { payload: { q } }, ok: true, pageUrl, tools: [dependency] });
    expect((await memory.status(root) as any).operations[0].state).toBe('active');
    for (const q of ['c', 'd']) memory.observe({ workspace: root, script: source, vars: { payload: { q } }, ok: true, pageUrl, tools: [{ ...dependency, code: 'return 2' }] });
    const entry = (await memory.status(root) as any).operations[0];
    expect(entry.state).toBe('active'); expect(entry.version).toBe(2);
  });

  it('restores lifecycle evidence after a process restart', async () => {
    observe('first'); await memory.flush(); memory.close();
    memory = new OperationMemory(settings, () => now);
    observe('second');
    expect((await memory.status(root) as any).operations[0].state).toBe('active');
  });

  it('resumes expiry maintenance on the first workspace visit after restart', async () => {
    observe('first'); observe('second'); await memory.flush(); memory.close();
    now += 2 * 86400000;
    memory = new OperationMemory(settings, () => now);
    memory.touch(root);
    await memory.flush();
    expect((await memory.status(root) as any).operations[0].state).toBe('retired');
  });

  it('retires the least-recently-used artifact when the active catalog reaches capacity', async () => {
    for (const field of ['A', 'B', 'C']) {
      now += 10;
      for (const value of ['first', 'second']) memory.observe({ workspace: root, script: `fillform ${field}=$value && assert text="ready"`, vars: { value }, pageUrl, ok: true, tools: [] });
      await memory.flush();
    }
    const status = await memory.status(root) as any;
    expect(status.operations.filter((e: any) => e.state === 'active')).toHaveLength(2);
    expect(status.operations.filter((e: any) => e.reason === 'capacity_lru')).toHaveLength(1);
  });

  it('keeps a working artifact on a transient execution failure', async () => {
    observe('first'); observe('second');
    const entry = (await memory.status(root) as any).operations[0];
    memory.observe({ workspace: root, script: '', ok: false, tools: [], feedback: [{ name: entry.name, status: 'failed', category: 'execution' }] });
    expect((await memory.status(root) as any).operations[0].state).toBe('active');
  });

  it('refuses to publish through a symlink and exposes the background failure', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-learning-outside-'));
    try {
      await fs.symlink(outside, path.join(root, '.webmcp'), 'junction');
      observe('first'); observe('second');
      const status = await memory.status(root) as any;
      expect(status.error).toBe('learning_persistence_or_configuration_failed');
      expect(await fs.readdir(outside)).toEqual([]);
      expect(status.operations.every((e: any) => e.state !== 'active')).toBe(true);
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });
});
