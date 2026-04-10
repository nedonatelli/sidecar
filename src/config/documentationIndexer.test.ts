import { describe, it, expect } from 'vitest';
import { DocumentationIndexer } from './documentationIndexer.js';

describe('DocumentationIndexer', () => {
  it('exports DocumentationIndexer class', () => {
    expect(typeof DocumentationIndexer).toBe('function');
  });

  it('creates indexer instance with no errors', () => {
    const indexer = new DocumentationIndexer();
    expect(indexer).toBeDefined();
    expect(typeof indexer.initialize).toBe('function');
  });

  it('provides search functionality', () => {
    const indexer = new DocumentationIndexer();
    expect(typeof indexer.search).toBe('function');
  });

  it('provides entry count', () => {
    const indexer = new DocumentationIndexer();
    expect(indexer.getEntryCount()).toBe(0);
  });

  it('can format entries for context', () => {
    const indexer = new DocumentationIndexer();
    const entries = [
      {
        id: 'test-1',
        filePath: 'README.md',
        lineNumber: 1,
        type: 'heading' as const,
        title: 'Test Heading',
        content: 'This is test content',
        relevanceScore: 0.8,
      },
    ];

    const formatted = indexer.formatForContext(entries);
    expect(formatted).toContain('Documentation Reference');
    expect(formatted).toContain('Test Heading');
  });

  it('handles empty search results', () => {
    const indexer = new DocumentationIndexer();
    const results = indexer.search('nonexistent query');
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });

  it('can clear indexed documentation', () => {
    const indexer = new DocumentationIndexer();
    expect(indexer.getEntryCount()).toBe(0);
    indexer.clear();
    expect(indexer.getEntryCount()).toBe(0);
    expect(indexer.isReady()).toBe(false);
  });
});
