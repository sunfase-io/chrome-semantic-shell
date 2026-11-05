import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeSemanticStateVersion,
  readSemanticPageState,
  resetSemanticStateVersions,
} from '@/entrypoints/background/tools/browser/semantic-state';
import type { SemanticPageState } from 'chrome-semantic-shell-shared';

const state = (version: number, url: string): SemanticPageState => ({
  version,
  url,
  title: 'test',
  nodes: [],
  capabilities: ['native'],
});

afterEach(() => resetSemanticStateVersions());

describe('tab semantic version normalization', () => {
  it('keeps versions stable across repeated views of one document', () => {
    expect(normalizeSemanticStateVersion(1, state(1, 'https://a.test'), 'doc-a').version).toBe(1);
    expect(normalizeSemanticStateVersion(1, state(1, 'https://a.test'), 'doc-a').version).toBe(1);
  });

  it('stays monotonic when navigation resets the page-local version', () => {
    expect(normalizeSemanticStateVersion(1, state(4, 'https://a.test'), 'doc-a').version).toBe(4);
    expect(normalizeSemanticStateVersion(1, state(1, 'https://b.test'), 'doc-b').version).toBe(5);
    expect(normalizeSemanticStateVersion(1, state(2, 'https://b.test'), 'doc-b').version).toBe(6);
  });

  it('tracks adapter changes without making native-only reads oscillate', () => {
    expect(normalizeSemanticStateVersion(1, state(1, 'https://a.test'), 'doc-a', 'x').version).toBe(
      1,
    );
    expect(normalizeSemanticStateVersion(1, state(1, 'https://a.test'), 'doc-a').version).toBe(1);
    expect(normalizeSemanticStateVersion(1, state(1, 'https://a.test'), 'doc-a', 'y').version).toBe(
      2,
    );
  });

  it('merges semantic nodes from every frame with frame-local refs', async () => {
    const previous = (chrome as any).scripting;
    (chrome as any).scripting = {
      executeScript: vi.fn().mockResolvedValue([
        {
          frameId: 0,
          documentId: 'top',
          result: {
            ...state(1, 'https://a.test'),
            nodes: [{ ref: 'ref_1', role: 'button', source: 'native' }],
          },
        },
        {
          frameId: 7,
          documentId: 'child',
          result: {
            ...state(1, 'https://frame.test'),
            nodes: [{ ref: 'ref_1', role: 'textbox', source: 'native' }],
          },
        },
      ]),
    };
    try {
      const result = await readSemanticPageState(1, { includeAdapters: false });
      expect(result.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ref: 'ref_1', frameId: 0, role: 'button' }),
          expect.objectContaining({ ref: 'ref_1', frameId: 7, role: 'textbox' }),
        ]),
      );
    } finally {
      (chrome as any).scripting = previous;
    }
  });
});
