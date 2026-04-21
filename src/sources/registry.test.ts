import { describe, it, expect, beforeEach } from 'vitest';
import { registerSource, findSourceFor, extractFromUri, listSources, clearSources } from './registry.js';
import type { Source, SourceDocument } from './types.js';

function makeSource(type: string, pattern: RegExp): Source {
  return {
    sourceType: type as never,
    canHandle: (uri: string) => pattern.test(uri),
    async *extract(uri: string): AsyncGenerator<SourceDocument> {
      yield {
        id: `${type}:${uri}:0`,
        title: `${type} doc`,
        content: `content from ${uri}`,
        metadata: {},
        sourceType: type as never,
        uri,
        chunkIndex: 0,
      };
    },
  };
}

describe('SourceRegistry', () => {
  beforeEach(() => clearSources());

  it('findSourceFor returns undefined when no source is registered', () => {
    expect(findSourceFor('file.pdf')).toBeUndefined();
  });

  it('findSourceFor returns a matching source', () => {
    const pdf = makeSource('pdf', /\.pdf$/i);
    registerSource(pdf);
    expect(findSourceFor('paper.pdf')).toBe(pdf);
  });

  it('findSourceFor returns undefined when URI does not match', () => {
    registerSource(makeSource('pdf', /\.pdf$/i));
    expect(findSourceFor('paper.docx')).toBeUndefined();
  });

  it('later-registered source wins on overlap', () => {
    const first = makeSource('pdf', /\.pdf$/i);
    const second = makeSource('pdf', /\.pdf$/i);
    registerSource(first);
    registerSource(second);
    expect(findSourceFor('file.pdf')).toBe(second);
  });

  it('teardown removes the source', () => {
    const remove = registerSource(makeSource('pdf', /\.pdf$/i));
    remove();
    expect(findSourceFor('file.pdf')).toBeUndefined();
  });

  it('listSources returns a snapshot', () => {
    const s = makeSource('pdf', /\.pdf$/i);
    registerSource(s);
    const list = listSources();
    expect(list).toHaveLength(1);
    expect(list[0]).toBe(s);
    // Mutating the snapshot does not affect the registry
    (list as Source[]).splice(0);
    expect(listSources()).toHaveLength(1);
  });

  it('extractFromUri throws when no source matches', async () => {
    await expect(async () => {
      for await (const _ of extractFromUri('unknown.xyz')) {
        // noop
      }
    }).rejects.toThrow('No source registered for URI: unknown.xyz');
  });

  it('extractFromUri yields chunks from the matching source', async () => {
    registerSource(makeSource('pdf', /\.pdf$/i));
    const chunks: SourceDocument[] = [];
    for await (const doc of extractFromUri('paper.pdf')) {
      chunks.push(doc);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('content from paper.pdf');
    expect(chunks[0].sourceType).toBe('pdf');
  });

  it('extractFromUri respects abort signal', async () => {
    const controller = new AbortController();
    let extractCalled = false;
    const abortingSource: Source = {
      sourceType: 'pdf',
      canHandle: () => true,
      async *extract(_uri, signal) {
        extractCalled = true;
        controller.abort();
        if (signal?.aborted) return;
        yield {
          id: 'pdf:x:0',
          title: 'x',
          content: 'should not yield',
          metadata: {},
          sourceType: 'pdf' as const,
          uri: 'x',
          chunkIndex: 0,
        };
      },
    };
    registerSource(abortingSource);
    const chunks: SourceDocument[] = [];
    for await (const doc of extractFromUri('file.pdf', controller.signal)) {
      chunks.push(doc);
    }
    expect(extractCalled).toBe(true);
    expect(chunks).toHaveLength(0);
  });
});
