import { describe, expect, it } from 'vitest';
import { buildPageProgram } from '@/entrypoints/background/tools/browser/javascript';
import {
  describeInputSchema,
  describeJavascriptFailure,
  javascriptStepOutcome,
} from '@/entrypoints/background/tools/browser/semantic-shell';

// The page program is plain JavaScript; indirect eval stands in for Runtime.evaluate.
const run = (code: string, form: 'expression' | 'body', vars?: Record<string, unknown>) =>
  (0, eval)(buildPageProgram(code, form, vars));

describe('javascript code forms', () => {
  it('returns the value of a single expression, including promises and IIFEs', async () => {
    await expect(run('1 + 1', 'expression')).resolves.toMatchObject({ ok: true, value: 2 });
    await expect(run('Promise.resolve("x").then((v) => v + "y");', 'expression')).resolves.toMatchObject({ value: 'xy' });
    await expect(run('(() => { return 3 })()', 'expression')).resolves.toMatchObject({ value: 3 });
    await expect(run('({ a: 1 })', 'expression')).resolves.toMatchObject({ value: { a: 1 } });
  });

  it('rejects statement code in expression form at compile time, before any side effect', () => {
    (globalThis as any).__sideEffect = 0;
    expect(() => run('globalThis.__sideEffect++; return 1', 'expression')).toThrow(SyntaxError);
    expect((globalThis as any).__sideEffect).toBe(0);
  });

  it('runs statement bodies and flags a missing return', async () => {
    await expect(run('const a = 2; return a * 2', 'body')).resolves.toMatchObject({ value: 4 });
    await expect(run('const a = 2;', 'body')).resolves.toMatchObject({ ok: true, isUndefined: true });
  });

  it('reports runtime errors as values so they are never retried as another form', async () => {
    await expect(run('JSON.parse("{")', 'expression')).resolves.toMatchObject({ ok: false, name: 'SyntaxError' });
  });

  it('exposes VARS only when the code references it', async () => {
    await expect(run('VARS.idx + 1', 'expression', { idx: 4 })).resolves.toMatchObject({ value: 5 });
    expect(buildPageProgram('1', 'expression', { secret: 'x' })).not.toContain('secret');
    await expect(run('const VARS = 1; return VARS', 'body', { idx: 4 })).resolves.toMatchObject({ value: 1 });
  });
});

describe('javascript step output', () => {
  it('prints the decoded value and warns about truncation or a missing return', () => {
    const ok = javascriptStepOutcome(JSON.stringify({ success: true, result: '{"a":1}', expression: true }));
    expect(ok).toEqual({ value: { a: 1 }, line: '{"a":1}', warnings: [] });
    const truncated = javascriptStepOutcome(JSON.stringify({ success: true, result: 'abc', truncated: true }));
    expect(truncated.warnings[0]).toContain('result truncated');
    const missing = javascriptStepOutcome(JSON.stringify({ success: true, result: 'undefined', undefinedResult: true }));
    expect(missing.warnings[0]).toContain('explicit return');
  });

  it('reduces a failure envelope to one line', () => {
    const text = JSON.stringify({ success: false, error: { kind: 'runtime_error', message: 'ReferenceError: x is not defined' } });
    expect(describeJavascriptFailure(text)).toBe('runtime_error: ReferenceError: x is not defined');
  });

  it('summarizes tool input schemas', () => {
    expect(describeInputSchema({ type: 'object', properties: { id: { type: 'string' }, all: { type: 'boolean' } }, required: ['id'] })).toBe(' input={id:string, all?:boolean}');
    expect(describeInputSchema(undefined)).toBe('');
  });
});
