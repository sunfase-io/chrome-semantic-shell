import { describe, expect, it, vi } from 'vitest';
import {
  applySemanticViewFilters,
  buildHttpSequenceOperationCode,
  capturePublishAllowsConstants,
  chromeShellTool,
  clickZeroRectOptionInPage,
  createCapturedOperationManifest,
  createOperationDraft,
  defaultInspectModeForRole,
  ensureSemanticActionBridge,
  extractScreenshotArtifacts,
  matchExactSelectOptions,
  matchExactSemanticTarget,
  normalizeCapturedRequest,
  pollUntil,
  resolveSemanticScope,
  syncActionTabContext,
  unwrapJavascriptToolPayload,
  validateSemanticToolInput,
  learnedFailureCategory,
} from '@/entrypoints/background/tools/browser/semantic-shell';
import { parseShellProgram } from '@/entrypoints/background/tools/browser/semantic-shell-dsl';

describe('chrome shell runtime', () => {
  it('does not retire a working operation for business-data or timeout failures', () => {
    expect(learnedFailureCategory('call search input=$arg1', 'Customer not found')).toBe('execution');
    expect(learnedFailureCategory('assert text="Saved"', 'Text not found')).toBe('execution');
    expect(learnedFailureCategory('click @ref_1', 'network timeout')).toBe('execution');
    expect(learnedFailureCategory('fill role=textbox name="Name" value=$arg1', 'fill target matched 0 exact semantic nodes; expected exactly one')).toBe('structural');
  });
  it('validates learned tool inputs before any browser operation', () => {
    const schema = { type: 'object', properties: { id: { type: 'string' }, active: { type: 'boolean' } }, required: ['id'] };
    expect(validateSemanticToolInput(schema, { id: '9223372036854775807', active: false })).toEqual({ id: '9223372036854775807', active: false });
    expect(() => validateSemanticToolInput(schema, { id: 1 })).toThrow('Invalid tool input type');
    expect(() => validateSemanticToolInput(schema, {})).toThrow('Missing tool input');
    expect(() => validateSemanticToolInput(schema, { id: '1', script: 'injected' })).toThrow('Unknown tool input');
  });
  it('dry-runs without touching Chrome and returns the parsed AST', async () => {
    const result = await chromeShellTool.execute({
      script: 'inspect forms | query "保存" | click && assert text="成功"',
      vars: {},
      dryRun: true,
    });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.ok).toBe(true);
    expect(parsed.program.statements[0].pipeline.map((x: any) => x.name)).toEqual([
      'inspect',
      'query',
      'click',
    ]);
  });

  it('rejects unknown options and commands during dry-run, including nested blocks', async () => {
    const text = async (script: string) => {
      const result = await chromeShellTool.execute({ script, dryRun: true });
      return { isError: result.isError, text: (result.content[0] as any).text as string };
    };
    expect(await text('js frame=3 code="return 1"')).toMatchObject({ isError: false });
    expect((await text('query css="#a" | click --tab 12')).text).toContain('click: unknown option "tab"');
    expect((await text('defer { tab close; wait selector="#x" foo=1 }')).text).toContain(
      'wait: unknown option "foo"',
    );
    expect((await text('started x')).text).toContain('unsupported command "started"');
    expect(await text('fillform 邮箱=$email 密码=$pwd')).toMatchObject({ isError: false });
  });

  it('returns a fail-fast syntax error', async () => {
    const result = await chromeShellTool.execute({ script: 'inspect |', dryRun: true });
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('DSL syntax error');
  });

  it('synchronizes the action context and invalidates page state after a tab change', () => {
    const runtime = {
      tabId: 1,
      lastPage: { version: 1 },
      lastView: { options: { mode: 'interactive' } },
      pipelineNodes: [{ ref: 'ref_1' }],
    } as any;
    const context = { tabId: 1 };

    syncActionTabContext(2, runtime, context);

    expect(runtime.tabId).toBe(2);
    expect(context.tabId).toBe(2);
    expect(runtime.lastPage).toBeUndefined();
    expect(runtime.lastView).toBeUndefined();
    expect(runtime.pipelineNodes).toEqual([]);
  });

  it('retries transient probe errors until the page predicate matches', async () => {
    let attempts = 0;
    const result = await pollUntil(
      100,
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('execution context was destroyed');
        return attempts === 2;
      },
      1,
    );

    expect(result).toEqual({ matched: true });
    expect(attempts).toBe(2);
  });

  it('publishes captured scalar bindings without erasing their JSON types', () => {
    const manifest = createCapturedOperationManifest(
      {
        name: 'typed_capture',
        requests: [
          {
            method: 'POST',
            url: 'https://example.test/orders',
            body: { count: 2, enabled: false, note: null, label: 'sample' },
          },
        ],
        scalarPaths: [
          'requests.0.url',
          'requests.0.body.count',
          'requests.0.body.enabled',
          'requests.0.body.note',
          'requests.0.body.label',
        ],
      },
      {
        'requests.0.body.count': 'count',
        'requests.0.body.enabled': 'enabled',
        'requests.0.body.note': 'note',
        'requests.0.body.label': 'label',
      },
      true,
    ) as any;

    expect(manifest.inputSchema.properties).toEqual({
      count: { type: 'number' },
      enabled: { type: 'boolean' },
      note: { type: 'null' },
      label: { type: 'string' },
    });
    expect(manifest.requests[0].body).toEqual({
      count: { $chromeShellInput: 'count' },
      enabled: { $chromeShellInput: 'enabled' },
      note: { $chromeShellInput: 'note' },
      label: '{{label}}',
    });
  });

  it('replays typed captured inputs as JSON scalars instead of strings', async () => {
    const code = buildHttpSequenceOperationCode(
      [
        {
          method: 'POST',
          url: 'https://example.test/orders/{{id}}',
          body: {
            count: { $chromeShellInput: 'count' },
            enabled: { $chromeShellInput: 'enabled' },
            note: { $chromeShellInput: 'note' },
          },
        },
      ],
      { id: 'abc', count: 3, enabled: false, note: null },
    );
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '{"ok":true}',
    }));
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...values: unknown[]) => Promise<unknown>;

    await new AsyncFunction('fetch', code)(fetch);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.test/orders/abc');
    expect(JSON.parse(String(init.body))).toEqual({
      count: 3,
      enabled: false,
      note: null,
    });
  });

  it('omits an unavailable captured status instead of serializing undefined', () => {
    expect(
      normalizeCapturedRequest({
        type: 'fetch',
        method: 'POST',
        url: 'https://example.test/api',
        requestBody: '{"enabled":false}',
      }),
    ).toEqual({
      method: 'POST',
      url: 'https://example.test/api',
      headers: {},
      body: { enabled: false },
    });
  });

  it('accepts the documented bare allowConstants capture flag', () => {
    const command = parseShellProgram(
      'capture publish bindings={"requests.0.body.id":"id"} allowConstants',
    ).statements[0].pipeline[0];

    expect(capturePublishAllowsConstants(command)).toBe(true);
  });

  it('omits an absent optional capture description from the JSON draft', () => {
    const draft = createOperationDraft('capture_without_description', undefined, [], []);

    expect(draft).not.toHaveProperty('description');
    expect(() => JSON.stringify(draft)).not.toThrow();
  });

  it('installs the lightweight ref bridge in the target frame on demand', async () => {
    const previousSendMessage = chrome.tabs.sendMessage;
    const previousScripting = (chrome as any).scripting;
    const sendMessage = vi.fn().mockRejectedValueOnce(new Error('Receiving end does not exist'));
    const executeScript = vi.fn().mockResolvedValueOnce([]);
    (chrome.tabs as any).sendMessage = sendMessage;
    (chrome as any).scripting = { executeScript };
    try {
      await ensureSemanticActionBridge(91, 7);

      expect(executeScript).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { tabId: 91, frameIds: [7] },
          world: 'ISOLATED',
          files: ['inject-scripts/accessibility-tree-helper.js'],
        }),
      );
    } finally {
      (chrome.tabs as any).sendMessage = previousSendMessage;
      (chrome as any).scripting = previousScripting;
    }
  });

  it('converts the screenshot tool base64 envelope into an image artifact', () => {
    expect(
      extractScreenshotArtifacts({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ base64Data: 'YWJj', mimeType: 'image/jpeg' }),
          },
        ],
        isError: false,
      }),
    ).toEqual([{ type: 'image', data: 'YWJj', mimeType: 'image/jpeg' }]);
  });

  it('resolves an explicit pipeline scope only from one framed node', () => {
    expect(
      resolveSemanticScope('pipe', [{ ref: 'ref_8', frameId: 3, role: 'row', source: 'native' }]),
    ).toEqual({ scopeRef: 'ref_8', scopeFrameId: 3 });
    expect(() => resolveSemanticScope('pipe', [])).toThrow('received 0');
    expect(() =>
      resolveSemanticScope('pipe', [
        { ref: 'ref_1', role: 'row', source: 'native' },
        { ref: 'ref_2', role: 'row', source: 'native' },
      ]),
    ).toThrow('received 2');
  });

  it('treats name= as an exact filter while query text remains the fuzzy search surface', () => {
    const state = {
      version: 1,
      url: 'https://example.test',
      title: 'menu',
      capabilities: ['native'],
      nodes: [
        { ref: 'ref_1', role: 'menuitem', name: '流程管理工作流角色', source: 'native' },
        { ref: 'ref_2', role: 'menuitem', name: '工作流角色', source: 'native' },
      ],
    } as any;

    expect(
      applySemanticViewFilters(state, {
        options: { mode: 'interactive' },
        roleFilter: 'menuitem',
        nameFilter: '工作流角色',
      }).nodes.map((node) => node.ref),
    ).toEqual(['ref_2']);
  });

  it('matches select options exactly without fuzzy guessing', () => {
    const nodes = [
      { ref: 'ref_1', role: 'option', name: '加工事业部贸易', value: '44', source: 'native' },
      { ref: 'ref_2', role: 'option', name: '加工事业部贸易测试', value: '45', source: 'native' },
    ] as any;

    expect(matchExactSelectOptions(nodes, '加工事业部贸易').map((node) => node.ref)).toEqual([
      'ref_1',
    ]);
    expect(matchExactSelectOptions(nodes, '44').map((node) => node.ref)).toEqual(['ref_1']);
    expect(matchExactSelectOptions(nodes, '44:加工事业部贸易').map((node) => node.ref)).toEqual([
      'ref_1',
    ]);
    expect(matchExactSelectOptions(nodes, '加工事业部')).toEqual([]);
  });

  it('matches an enriched action target by exact role and name', () => {
    const nodes = [
      { ref: 'ref_1', role: 'combobox', name: '所属系统', source: 'vue2' },
      { ref: 'ref_2', role: 'textbox', name: '所属系统', source: 'native' },
      { ref: 'ref_3', role: 'combobox', name: '所属系统测试', source: 'vue2' },
    ] as any;

    expect(matchExactSemanticTarget(nodes, 'combobox', '所属系统').map((node) => node.ref)).toEqual(
      ['ref_1'],
    );
  });

  it('defaults table structure roles to the tables view', () => {
    expect(defaultInspectModeForRole('row')).toBe('tables');
    expect(defaultInspectModeForRole('cell')).toBe('tables');
    expect(defaultInspectModeForRole('button')).toBe('interactive');
  });

  it('clicks only a live zero-height option inside an active custom popup', () => {
    const popup = document.createElement('div');
    popup.className = 'el-select-dropdown';
    const option = document.createElement('li');
    option.className = 'el-select-dropdown__item';
    popup.appendChild(option);
    document.body.appendChild(popup);
    Object.defineProperty(option, 'getClientRects', { value: () => [{ width: 120, height: 0 }] });
    Object.defineProperty(option, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 120, height: 0 }),
    });
    const clicked = vi.fn();
    option.addEventListener('click', clicked);
    (window as any).__chromeShellElementMap = { ref_9: new WeakRef(option) };

    expect(clickZeroRectOptionInPage('ref_9')).toBe(true);
    expect(clicked).toHaveBeenCalledOnce();

    Object.defineProperty(option, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 120, height: 30 }),
    });
    expect(clickZeroRectOptionInPage('ref_9')).toBe(false);
  });

  it('unwraps the JavaScript executor envelope returned by workspace tools', () => {
    expect(
      unwrapJavascriptToolPayload(
        JSON.stringify({
          success: true,
          engine: 'cdp',
          result: '{"ok":true,"count":2}',
          metrics: { elapsedMs: 12 },
        }),
      ),
    ).toEqual({
      value: { ok: true, count: 2 },
      truncated: false,
      warnings: [],
      engine: 'cdp',
      elapsedMs: 12,
    });
  });
});
