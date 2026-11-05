import { describe, expect, it } from 'vitest';
import {
  parseShellProgram,
  ShellSyntaxError,
} from '@/entrypoints/background/tools/browser/semantic-shell-dsl';

describe('semantic shell DSL', () => {
  it('keeps deferred cleanup blocks intact', () => {
    const program = parseShellProgram('defer { tab close; assert text="closed" }');
    expect(program.statements[0].pipeline[0]).toEqual(
      expect.objectContaining({
        name: 'defer',
        args: ['{ tab close; assert text="closed" }'],
      }),
    );
  });

  it('parses pipelines, connectors, quoted strings and JSON values', () => {
    const program = parseShellProgram(`
      inspect dialog query="创建网站" | query "确认" | click
      && fillform domain="$domain" protocol="https"
      || assert text="创建失败"
      ; call submit_order input={"confirm":true}
    `);

    expect(program.statements).toHaveLength(4);
    expect(program.statements[0].pipeline.map((x) => x.name)).toEqual([
      'inspect',
      'query',
      'click',
    ]);
    expect(program.statements[1].connector).toBe('and');
    expect(program.statements[1].pipeline[0].options.domain).toBe('$domain');
    expect(program.statements[2].connector).toBe('or');
    expect(program.statements[3].pipeline[0].options.input).toBe('{"confirm":true}');
  });

  it('keeps pipe characters inside quoted values', () => {
    const program = parseShellProgram('query text="A|B" | click');
    expect(program.statements[0].pipeline).toHaveLength(2);
    expect(program.statements[0].pipeline[0].options.text).toBe('A|B');
  });

  it('preserves positional URLs containing query assignments', () => {
    const command = parseShellProgram('navigate https://example.com/?a=b').statements[0]
      .pipeline[0];
    expect(command.args).toEqual(['https://example.com/?a=b']);
    expect(command.options).toEqual({});
  });

  it('preserves non-quote backslashes inside quoted values', () => {
    const command = parseShellProgram(String.raw`js code="return /\d+/.test('123')"`).statements[0]
      .pipeline[0];
    expect(command.options.code).toBe(String.raw`return /\d+/.test('123')`);
  });

  it('keeps control-flow blocks and variable assignments intact', () => {
    const program = parseShellProgram(
      'set $items=["A","B"]; for $item in $items { query text=$item | click }; if success { assert text="完成" } else { assert text="失败" }',
    );
    expect(program.statements).toHaveLength(3);
    expect(program.statements[0].pipeline[0].args[0]).toBe('$items=["A","B"]');
    expect(program.statements[1].pipeline[0].args[3]).toBe('{ query text=$item | click }');
    expect(program.statements[2].pipeline[0].args).toEqual([
      'success',
      '{ assert text="完成" }',
      'else',
      '{ assert text="失败" }',
    ]);
  });

  it('never treats a quoted positional argument containing "=" as an option', () => {
    const command = parseShellProgram(`js "const p = 1; return p"`).statements[0].pipeline[0];
    expect(command.args).toEqual(['const p = 1; return p']);
    expect(command.options).toEqual({});
    const embedded = parseShellProgram(`js code="const f=[1]; return f"`).statements[0].pipeline[0];
    expect(embedded.options.code).toBe('const f=[1]; return f');
  });

  it('records quoted option values so they are not decoded as JSON or numbers', () => {
    const command = parseShellProgram('wait selector="[role=dialog]" timeout=500').statements[0]
      .pipeline[0];
    expect(command.options).toEqual({ selector: '[role=dialog]', timeout: '500' });
    expect(command.quoted).toEqual(['selector']);
    const dashed = parseShellProgram('wait --selector="[a]"').statements[0].pipeline[0];
    expect(dashed.quoted).toEqual(['selector']);
  });

  it('rejects option names with spaces and text glued to a closing quote', () => {
    expect(parseShellProgram('js const p = 1').statements[0].pipeline[0].options).toEqual({});
    expect(() =>
      parseShellProgram(`js code="document.querySelector('a[href*="item"]')"`),
    ).toThrow(/1:\d+: unexpected text after closing double quote/);
  });

  it('accepts substring match option keys', () => {
    const command = parseShellProgram('query role=button name~="保存"').statements[0].pipeline[0];
    expect(command.options['name~']).toBe('保存');
  });

  it('reports the real line and column of syntax errors', () => {
    expect(() => parseShellProgram('inspect text\nquery role=button && "click"')).toThrow(
      'DSL syntax error at 2:22: invalid command name "click"',
    );
    expect(() => parseShellProgram('tab list; [] ')).toThrow(/at 1:11:/);
  });

  it('fails fast with line and column for malformed input', () => {
    expect(() => parseShellProgram('inspect |')).toThrow(ShellSyntaxError);
    expect(() => parseShellProgram('click name="保存')).toThrow(/DSL syntax error at 1:/);
    expect(() => parseShellProgram('')).toThrow('script must be a non-empty string');
  });
});
