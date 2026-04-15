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
});
