import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  formatCommandResult,
  inlineJavascriptFiles,
  parseVariableAssignments,
  parseVariablesJson,
  resolveCommandEndpoint,
} from './semantic-cli-core';

describe('semantic command CLI helpers', () => {
  it('parses typed variable assignments', () => {
    expect(parseVariableAssignments(['count=3', 'enabled=true', 'name=铜材', 'empty='])).toEqual({
      count: 3,
      enabled: true,
      name: '铜材',
      empty: '',
    });
    expect(() => parseVariableAssignments(['bad assignment'])).toThrow(
      'invalid variable assignment',
    );
  });

  it('accepts only object JSON for variables', () => {
    expect(parseVariablesJson('{"id":42}')).toEqual({ id: 42 });
    expect(() => parseVariablesJson('[]')).toThrow('variables JSON must be an object');
  });

  it('restricts the command endpoint to loopback HTTP', () => {
    expect(resolveCommandEndpoint('http://127.0.0.1:12306/chrome/shell').pathname).toBe(
      '/chrome/shell',
    );
    expect(() => resolveCommandEndpoint('https://example.com/chrome/shell')).toThrow('loopback');
  });

  it('prints text and materializes image artifacts', async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-cli-test-'));
    try {
      const output = await formatCommandResult(
        {
          content: [
            { type: 'text', text: 'ok tab=1' },
            { type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') },
          ],
          isError: false,
        },
        { artifactDirectory: target },
      );
      expect(output.text).toContain('ok tab=1');
      const artifact = output.text.match(/artifact:\s+(.+screenshot-1\.png)/)?.[1];
      expect(artifact).toBeTruthy();
      expect(path.dirname(artifact!)).not.toBe(target);
      expect(path.dirname(artifact!).startsWith(target)).toBe(true);
      expect(await fs.readFile(artifact!, 'utf8')).toBe('png');
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it('inlines js file= as variables without touching other commands', () => {
    const files: Record<string, string> = { 'a.js': 'return 1', 'b.js': 'return "$x"' };
    const result = inlineJavascriptFiles(
      'tab list && js file=a.js frame=2 | js file="b.js"; js code="return 3"',
      (file) => files[file],
    );
    expect(result.script).toBe(
      'tab list && js code=$__js_file_1 frame=2 | js code=$__js_file_2; js code="return 3"',
    );
    expect(result.vars).toEqual({ __js_file_1: 'return 1', __js_file_2: 'return "$x"' });
    expect(() => inlineJavascriptFiles('js file=a.js code="x"', () => '')).toThrow('not both');
  });

  it('keeps json output a single parseable document with artifact paths', async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-cli-json-'));
    try {
      const output = await formatCommandResult(
        {
          content: [
            { type: 'text', text: JSON.stringify({ ok: true, steps: [] }) },
            { type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') },
            { type: 'text', text: 'workspace tool published: x' },
          ],
          isError: false,
        },
        { artifactDirectory: target, output: 'json' },
      );
      const parsed = JSON.parse(output.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.artifacts).toHaveLength(1);
      expect(parsed.notes).toEqual(['workspace tool published: x']);
      const failure = await formatCommandResult(
        { content: [{ type: 'text', text: 'Explicit target tab is unavailable' }], isError: true },
        { output: 'json' },
      );
      expect(JSON.parse(failure.text)).toEqual({ ok: false, error: 'Explicit target tab is unavailable' });
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it('creates unique artifact paths across repeated invocations', async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-cli-repeat-'));
    const result = {
      content: [
        {
          type: 'image' as const,
          mimeType: 'image/png',
          data: Buffer.from('png').toString('base64'),
        },
      ],
      isError: false,
    };
    try {
      const first = await formatCommandResult(result, { artifactDirectory: target });
      const second = await formatCommandResult(result, { artifactDirectory: target });
      expect(first.text).not.toBe(second.text);
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });
});
