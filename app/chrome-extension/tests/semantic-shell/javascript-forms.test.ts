import { describe, expect, it } from 'vitest';
import { buildPageProgram, planCode } from '@/entrypoints/background/tools/browser/javascript';
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

describe('javascript code plan', () => {
  it('runs a single expression as one, object literals included', () => {
    expect(planCode('document.title')).toMatchObject({ form: 'expression', returns: 'expression' });
    expect(planCode('{ a: 1 }')).toMatchObject({ form: 'expression' });
    expect(planCode('await fetch("/x").then((r) => r.json());')).toMatchObject({ form: 'expression' });
  });

  it('returns the last expression statement of statement code, as a console does', async () => {
    const plan = planCode('const rows = [1, 2, 3];\nrows.map((n) => n * 2) // doubled');
    expect(plan).toMatchObject({ form: 'body', returns: 'last' });
    await expect(run(plan!.code, plan!.form)).resolves.toMatchObject({ value: [2, 4, 6] });
    await expect(run(planCode('let a = 1; a += 2; a')!.code, 'body')).resolves.toMatchObject({ value: 3 });
  });

  it('leaves code that returns, or ends in another statement, as written', () => {
    expect(planCode('if (x) return 1; const f = () => { return 2 }; f()')).toMatchObject({ returns: 'return', code: 'if (x) return 1; const f = () => { return 2 }; f()' });
    expect(planCode('const f = () => { return 2 }; f()')).toMatchObject({ returns: 'last' });
    expect(planCode('for (const x of [1]) { console.log(x) }')).toMatchObject({ returns: 'none' });
    expect(planCode('"use strict"')).toMatchObject({ returns: 'expression' });
  });

  it('defers code the parser rejects to the engine', () => {
    expect(planCode('const = 1')).toBeUndefined();
  });
});

describe('javascript step output', () => {
  it('prints the decoded value and warns about truncation or a missing return', () => {
    const ok = javascriptStepOutcome(JSON.stringify({ success: true, result: '{"a":1}', returns: 'expression' }));
    expect(ok).toEqual({ value: { a: 1 }, line: '{"a":1}', warnings: [] });
    const truncated = javascriptStepOutcome(JSON.stringify({ success: true, result: 'abc', truncated: true }));
    expect(truncated.warnings[0]).toContain('result truncated');
    const missing = javascriptStepOutcome(JSON.stringify({ success: true, result: 'undefined', undefinedResult: true, returns: 'none' }));
    expect(missing.warnings[0]).toContain('return the value explicitly');
    const called = javascriptStepOutcome(JSON.stringify({ success: true, result: 'undefined', undefinedResult: true, returns: 'last' }));
    expect(called.warnings).toEqual([]);
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
