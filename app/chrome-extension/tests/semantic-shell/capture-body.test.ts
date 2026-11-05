import { describe, expect, it } from 'vitest';
import { decodeCapturedBody } from '@/entrypoints/background/tools/browser/network-capture-web-request';

describe('request capture body fidelity', () => {
  it('reassembles UTF-8 JSON split across byte chunks', () => {
    const text = '{"name":"中文","id":"9223372036854775807"}';
    const bytes = new TextEncoder().encode(text);
    const result = decodeCapturedBody({ raw: [{ bytes: bytes.slice(0, 11).buffer }, { bytes: bytes.slice(11).buffer }] });
    expect(result).toBe(text);
  });

  it('does not publish a binary/file body as a fake text placeholder', () => {
    expect(decodeCapturedBody({ raw: [{ bytes: new Uint8Array([0xff, 0, 0xfe]).buffer }] })).toBeUndefined();
    expect(decodeCapturedBody({ raw: [{ file: '/private/file' }] })).toBeUndefined();
  });

  it('preserves form values and bounds capture memory', () => {
    expect(decodeCapturedBody({ formData: { tag: ['a', 'b'] } })).toBe('{"tag":["a","b"]}');
    expect(decodeCapturedBody({ raw: [{ bytes: new ArrayBuffer(1024 * 1024 + 1) }] })).toBeUndefined();
  });
});
