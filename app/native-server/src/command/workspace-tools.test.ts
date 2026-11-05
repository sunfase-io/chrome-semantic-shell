import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverWorkspaceTools, publishWorkspaceTool } from './workspace-tools';

describe('workspace tool discovery', () => {
  let root = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-shell-tools-'));
    await fs.mkdir(path.join(root, '.webmcp'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('discovers legacy snippets and manifest-backed JavaScript tools', async () => {
    await fs.writeFile(
      path.join(root, '.webmcp', 'legacy.js'),
      '// tool: search_supplier\n// description: Search suppliers\n// input: { keyword: string }\n// readonly: true\nreturn ARGS.keyword;',
    );
    await fs.writeFile(path.join(root, '.webmcp', 'create.js'), 'return { ok: true, ...ARGS };');
    await fs.writeFile(
      path.join(root, '.webmcp', 'create.tool.json'),
      JSON.stringify({
        name: 'create_order',
        description: 'Create an order',
        kind: 'javascript',
        entry: 'create.js',
        readOnly: true,
        inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      }),
    );

    const tools = await discoverWorkspaceTools([pathToFileURL(root).href]);
    expect(tools.map((tool) => tool.name).sort()).toEqual(['create_order', 'search_supplier']);
    expect(tools.find((tool) => tool.name === 'create_order')?.code).toContain('ok: true');
    expect(tools.find((tool) => tool.name === 'create_order')?.readOnly).toBe(true);
    expect(tools.find((tool) => tool.name === 'search_supplier')?.readOnly).toBe(true);
  });

  it('skips manifests whose entry escapes the workspace root', async () => {
    await fs.writeFile(
      path.join(root, '.webmcp', 'bad.tool.json'),
      JSON.stringify({ name: 'bad_tool', kind: 'javascript', entry: '../../../outside.js' }),
    );
    const tools = await discoverWorkspaceTools([pathToFileURL(root).href]);
    expect(tools).toEqual([]);
  });

  it('skips JavaScript entries whose symlink resolves outside the workspace root', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-shell-outside-'));
    try {
      const outsideFile = path.join(outside, 'outside.js');
      const linkedFile = path.join(root, '.webmcp', 'linked.js');
      await fs.writeFile(outsideFile, 'return "outside";');
      await fs.symlink(outsideFile, linkedFile, 'file');
      await fs.writeFile(
        path.join(root, '.webmcp', 'linked.tool.json'),
        JSON.stringify({ name: 'linked_tool', kind: 'javascript', entry: 'linked.js' }),
      );
      await expect(discoverWorkspaceTools([pathToFileURL(root).href])).resolves.toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('publishes sanitized operation manifests inside the workspace root', async () => {
    const target = await publishWorkspaceTool([pathToFileURL(root).href], {
      name: 'create_order',
      manifest: {
        name: 'create_order',
        kind: 'http-sequence',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        requests: [{ method: 'POST', url: '/orders/{{id}}', body: { id: '{{id}}' } }],
      },
    });
    expect(target).toBe(path.join(root, '.webmcp', 'operations', 'create_order.tool.json'));
    expect(JSON.parse(await fs.readFile(target, 'utf8')).name).toBe('create_order');
  });

  it('rejects operation manifests containing persisted credentials', async () => {
    await expect(
      publishWorkspaceTool([pathToFileURL(root).href], {
        name: 'unsafe',
        manifest: {
          name: 'unsafe',
          kind: 'http-sequence',
          requests: [{ url: '/x', headers: { Authorization: 'Bearer secret' } }],
        },
      }),
    ).rejects.toThrow('sensitive field');

    await expect(
      publishWorkspaceTool([pathToFileURL(root).href], {
        name: 'unsafe_url',
        manifest: {
          name: 'unsafe_url',
          kind: 'http-sequence',
          requests: [{ url: '/x?access_token=raw-secret' }],
        },
      }),
    ).rejects.toThrow('sensitive field');
  });

  it('rejects a symlinked operation publish directory', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-shell-publish-outside-'));
    try {
      await fs.rm(path.join(root, '.webmcp'), { recursive: true, force: true });
      await fs.mkdir(path.join(root, '.webmcp'));
      await fs.symlink(
        outside,
        path.join(root, '.webmcp', 'operations'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await expect(
        publishWorkspaceTool([pathToFileURL(root).href], {
          name: 'unsafe_target',
          manifest: { name: 'unsafe_target', kind: 'http-sequence', requests: [] },
        }),
      ).rejects.toThrow('Unsafe workspace directory');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
