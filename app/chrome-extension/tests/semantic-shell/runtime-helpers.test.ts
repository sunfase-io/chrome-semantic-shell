import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPageHttpCode,
  extractInPage,
  parseHttpCommand,
  readStorageInPage,
  renderTabList,
  summarizeNetworkCapture,
} from '@/entrypoints/background/tools/browser/semantic-shell';
import { parseShellProgram } from '@/entrypoints/background/tools/browser/semantic-shell-dsl';
import { buildPageProgram } from '@/entrypoints/background/tools/browser/javascript';
import { parseKeySequence } from '@/entrypoints/background/tools/browser/semantic-input';

const command = (script: string) => parseShellProgram(script).statements[0].pipeline[0];

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  delete (window as any).__chromeShellElementMap;
});

describe('http command', () => {
  it('defaults to GET for a bare URL and substitutes header variables', () => {
    const request = parseHttpCommand(
      command('http /common/list?type=A headers={"accessToken":"$token"} pick=data.records as=$rows'),
      { token: 'secret' },
    );
    expect(request).toMatchObject({
      method: 'GET',
      url: '/common/list?type=A',
      context: 'page',
      headers: { accessToken: 'secret' },
      pick: 'data.records',
      as: 'rows',
    });
    expect(parseHttpCommand(command('http post https://x.test/api body={"a":1}'), {}).method).toBe('POST');
    expect(() => parseHttpCommand(command('http GET'), {})).toThrow('expects a URL');
    expect(() => parseHttpCommand(command('http /x body="a" form={"b":1}'), {})).toThrow('not both');
  });

  it('runs in the page with credentials and reduces the response there', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      url: 'http://localhost/api',
      text: async () => JSON.stringify({ data: { records: [1, 2] }, noise: 'x'.repeat(100) }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const code = buildPageHttpCode(parseHttpCommand(command('http POST /api body={"q":1} pick=data.records'), {}));
    const outcome = await (0, eval)(buildPageProgram(code, 'body'));
    expect(outcome.value).toEqual({ status: 200, ok: true, url: 'http://localhost/api', data: [1, 2] });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      body: '{"q":1}',
      headers: { 'Content-Type': 'application/json' },
    });
  });
});

describe('page readers', () => {
  it('reads storage values without JSON quotes', () => {
    sessionStorage.setItem('workFlowSystem:accessToken', JSON.stringify('abc'));
    expect(readStorageInPage('session', 'workFlowSystem:accessToken')).toEqual({ ok: true, value: 'abc' });
    expect(readStorageInPage('local', 'missing').ok).toBe(false);
  });

  it('extracts lists with field specs and refs', () => {
    document.body.innerHTML = `
      <ul><li class="row"><a href="/a">A</a><span class="n">1</span></li>
      <li class="row"><a href="/b">B</a><span class="n">2</span></li></ul>`;
    const rows = extractInPage({ selector: '.row', attr: 'text', all: false, fields: { title: 'a', href: 'a@href', n: '.n' }, limit: 10 });
    expect(rows.ok).toBe(true);
    expect((rows.value as any[]).map((row) => row.title)).toEqual(['A', 'B']);
    expect((rows.value as any[])[1].href).toMatch(/\/b$/);
    (window as any).__chromeShellElementMap = { ref_1: new WeakRef(document.querySelector('.n')!) };
    expect(extractInPage({ ref: 'ref_1', attr: 'text', all: false, limit: 1 })).toEqual({ ok: true, value: '1' });
    expect(extractInPage({ ref: 'ref_9', attr: 'text', all: false, limit: 1 }).error).toContain('STALE_REF');
    expect(extractInPage({ selector: '[', attr: 'text', all: false, limit: 1 }).ok).toBe(false);
  });
});

describe('compact listings', () => {
  it('prints one filtered line per tab', () => {
    const text = renderTabList(
      {
        windowCount: 1,
        tabCount: 2,
        windows: [{ windowId: 7, tabs: [
          { tabId: 1, url: 'https://wiki.example.com/x', title: 'Wiki', active: true },
          { tabId: 2, url: 'https://linux.do/t/1', title: 'LINUX DO', active: false },
        ] }],
      },
      'linux',
    );
    expect(text.split('\n')).toEqual(['tabs: 1 matching "linux" of 2 (* = active in window)', '  2 w7 "LINUX DO" https://linux.do/t/1']);
  });

  it('summarizes captured requests without headers', () => {
    const summary = summarizeNetworkCapture(
      JSON.stringify({ requests: [
        { method: 'POST', url: 'https://x.test/data/api.json', status: 200, mimeType: 'text/plain', requestHeaders: { Cookie: 'secret' }, responseBody: '{"ok":true}' },
        { method: 'GET', url: 'https://x.test/logo.png', status: 200 },
      ] }),
      'api.json',
      50,
    );
    expect(summary.line).toBe('network: 1 request(s) matching "api.json"\nPOST 200 https://x.test/data/api.json text/plain\n  body: {"ok":true}');
    expect(JSON.stringify(summary.requests)).not.toContain('secret');
  });
});

describe('trusted key parsing', () => {
  it('parses chords and sequences', () => {
    const [save, enter, letter] = parseKeySequence('Ctrl+S Enter a');
    expect(save.modifiers.map((modifier) => modifier.key)).toEqual(['Control']);
    expect(save.key).toMatchObject({ key: 's', code: 'KeyS', keyCode: 83 });
    expect(enter.key).toMatchObject({ key: 'Enter', text: '\r' });
    expect(letter.key.text).toBe('a');
    expect(() => parseKeySequence('Hyper+x')).toThrow('unknown modifier');
  });
});
