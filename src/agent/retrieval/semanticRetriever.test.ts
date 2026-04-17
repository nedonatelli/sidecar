/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { SemanticRetriever } from './semanticRetriever';

function fakeIndex(overrides: Partial<any> = {}) {
  return {
    isReady: () => true,
    rankFiles: async () => [
      { relativePath: 'src/foo.ts', sizeBytes: 100, relevanceScore: 1, score: 1.5 },
      { relativePath: 'src/bar.ts', sizeBytes: 200, relevanceScore: 1, score: 0.8 },
    ],
    loadFileContent: async (p: string) => `// ${p}\nexport const x = 1;\n`,
    // v0.62 c.1: default to "no symbol index wired" so legacy tests
    // continue to exercise the file-level retrieval path.
    getSymbolEmbeddings: () => null,
    ...overrides,
  } as any;
}

/**
 * Build a fake `SymbolEmbeddingIndex` surface with just the three
 * methods the retriever actually consults. Tests that exercise the
 * PKI-preferred path pass this to `fakeIndex({ getSymbolEmbeddings })`.
 */
function fakeSymbolIndex(overrides: Partial<any> = {}) {
  return {
    isReady: () => true,
    getCount: () => 5,
    search: async () => [
      {
        symbolId: 'src/auth.ts::requireAuth',
        filePath: 'src/auth.ts',
        qualifiedName: 'requireAuth',
        name: 'requireAuth',
        kind: 'function',
        startLine: 3,
        endLine: 5,
        similarity: 0.82,
      },
    ],
    ...overrides,
  } as any;
}

describe('SemanticRetriever', () => {
  it('returns empty when the underlying index is not ready', async () => {
    const retriever = new SemanticRetriever(fakeIndex({ isReady: () => false }));
    expect(await retriever.retrieve('q', 5)).toEqual([]);
  });

  it('emits one hit per ranked file', async () => {
    const retriever = new SemanticRetriever(fakeIndex());
    const hits = await retriever.retrieve('q', 5);
    expect(hits).toHaveLength(2);
    expect(hits[0].id).toBe('workspace:src/foo.ts');
    expect(hits[0].source).toBe('workspace');
    expect(hits[0].filePath).toBe('src/foo.ts');
    expect(hits[0].content).toContain('### src/foo.ts');
    expect(hits[0].content).toContain('export const x = 1');
  });

  it('honors topK by slicing the ranked list', async () => {
    const retriever = new SemanticRetriever(fakeIndex());
    const hits = await retriever.retrieve('q', 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('workspace:src/foo.ts');
  });

  it('truncates file content to maxCharsPerFile', async () => {
    const bigContent = 'x'.repeat(10_000);
    const index = fakeIndex({ loadFileContent: async () => bigContent });
    const retriever = new SemanticRetriever(index, undefined, 100);
    const hits = await retriever.retrieve('q', 1);
    expect(hits[0].content.length).toBeLessThan(300);
    expect(hits[0].content).toContain('file truncated');
  });

  it('skips files that fail to load', async () => {
    const index = fakeIndex({
      loadFileContent: async (p: string) => (p === 'src/foo.ts' ? null : '// bar\n'),
    });
    const retriever = new SemanticRetriever(index);
    const hits = await retriever.retrieve('q', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('workspace:src/bar.ts');
  });

  it('forwards activeFilePath to rankFiles', async () => {
    let seen: string | undefined;
    const index = fakeIndex({
      rankFiles: async (_q: string, active?: string) => {
        seen = active;
        return [];
      },
    });
    const retriever = new SemanticRetriever(index, 'src/main.ts');
    await retriever.retrieve('q', 5);
    expect(seen).toBe('src/main.ts');
  });

  describe('PKI symbol-index preference (v0.62 c.1)', () => {
    it('prefers symbol-level hits when PKI is wired, ready, and has entries', async () => {
      const fileContent =
        '// src/auth.ts header\nimport { verifyToken } from "./token";\nfunction requireAuth(req, res, next) {\n  verifyToken(req);\n}\n';
      const index = fakeIndex({
        getSymbolEmbeddings: () => fakeSymbolIndex(),
        loadFileContent: async () => fileContent,
      });
      const retriever = new SemanticRetriever(index);
      const hits = await retriever.retrieve('auth', 5);

      expect(hits).toHaveLength(1);
      // Symbol-level IDs use the `workspace-sym:` prefix so fusion
      // can distinguish them from legacy file-level hits.
      expect(hits[0].id).toBe('workspace-sym:src/auth.ts::requireAuth');
      expect(hits[0].score).toBe(0.82);
      // Header includes the line range + kind + qualified name.
      expect(hits[0].content).toContain('src/auth.ts:3-5');
      expect(hits[0].content).toContain('(function requireAuth)');
      // Body is the symbol's lines 3–5 only — NOT the file header.
      expect(hits[0].content).toContain('function requireAuth');
      expect(hits[0].content).not.toContain('src/auth.ts header');
    });

    it('falls back to file-level ranking when the symbol index is not ready', async () => {
      const index = fakeIndex({ getSymbolEmbeddings: () => fakeSymbolIndex({ isReady: () => false }) });
      const retriever = new SemanticRetriever(index);
      const hits = await retriever.retrieve('q', 5);
      // Legacy file-level IDs (no `-sym` suffix).
      expect(hits.every((h) => h.id.startsWith('workspace:') && !h.id.startsWith('workspace-sym:'))).toBe(true);
      expect(hits).toHaveLength(2);
    });

    it('falls back to file-level ranking when the symbol index is empty', async () => {
      const index = fakeIndex({ getSymbolEmbeddings: () => fakeSymbolIndex({ getCount: () => 0 }) });
      const retriever = new SemanticRetriever(index);
      const hits = await retriever.retrieve('q', 5);
      expect(hits.every((h) => h.id.startsWith('workspace:') && !h.id.startsWith('workspace-sym:'))).toBe(true);
      expect(hits).toHaveLength(2);
    });

    it('returns an empty array (no fallback) when symbol search has no hits', async () => {
      // A populated symbol index that returns 0 matches is a valid
      // "PKI searched but nothing scored" result — don't double-up
      // with a file-level scan that would pollute the fusion layer.
      const index = fakeIndex({
        getSymbolEmbeddings: () => fakeSymbolIndex({ search: async () => [] }),
      });
      const retriever = new SemanticRetriever(index);
      const hits = await retriever.retrieve('nothing-relevant', 5);
      expect(hits).toEqual([]);
    });

    it('truncates long symbol bodies to maxCharsPerSymbol', async () => {
      const bigBody = 'x'.repeat(5_000);
      const index = fakeIndex({
        getSymbolEmbeddings: () =>
          fakeSymbolIndex({
            search: async () => [
              {
                symbolId: 'src/a.ts::big',
                filePath: 'src/a.ts',
                qualifiedName: 'big',
                name: 'big',
                kind: 'function',
                startLine: 1,
                endLine: 1,
                similarity: 0.7,
              },
            ],
          }),
        loadFileContent: async () => bigBody,
      });
      const retriever = new SemanticRetriever(index, undefined, 3000, 100);
      const hits = await retriever.retrieve('q', 1);
      expect(hits).toHaveLength(1);
      expect(hits[0].content.length).toBeLessThan(300);
      expect(hits[0].content).toContain('symbol truncated');
    });

    it('skips hits where the containing file is unreadable', async () => {
      const index = fakeIndex({
        getSymbolEmbeddings: () => fakeSymbolIndex(),
        loadFileContent: async () => null, // file disappeared between index + load
      });
      const retriever = new SemanticRetriever(index);
      const hits = await retriever.retrieve('q', 5);
      expect(hits).toEqual([]);
    });
  });
});
