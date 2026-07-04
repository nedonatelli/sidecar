import { describe, it, expect, vi, afterEach } from 'vitest';
import { workspace, Uri } from 'vscode';
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

describe('DocumentationIndexer — indexing pipeline', () => {
  const README = [
    '# Installation Guide',
    '',
    'To install SideCar you need TypeScript and Node.js configured properly here.',
    '',
    '## API Key Setup',
    '',
    'Set your API key in the settings panel to authenticate with the provider now.',
  ].join('\n');

  function setup(files: Record<string, string>) {
    vi.spyOn(workspace, 'workspaceFolders', 'get').mockReturnValue([
      { uri: Uri.file('/root'), name: 'root', index: 0 },
    ] as never);
    const uris = Object.keys(files).map((p) => Uri.file('/root/' + p));
    let served = false;
    vi.spyOn(workspace, 'findFiles').mockImplementation((async () => {
      if (served) return [];
      served = true;
      return uris;
    }) as never);
    vi.spyOn(workspace.fs, 'readFile').mockImplementation((async (uri: { fsPath: string }) => {
      const rel = uri.fsPath.replace('/root/', '');
      if (!(rel in files)) throw new Error('ENOENT');
      return Buffer.from(files[rel]);
    }) as never);
  }

  afterEach(() => vi.restoreAllMocks());

  it('is not ready before initialize and returns no search results', () => {
    const idx = new DocumentationIndexer();
    expect(idx.isReady()).toBe(false);
    expect(idx.search('install')).toEqual([]);
  });

  it('indexes markdown headings and paragraphs on initialize', async () => {
    setup({ 'README.md': README });
    const idx = new DocumentationIndexer();
    await idx.initialize();
    expect(idx.isReady()).toBe(true);
    expect(idx.getEntriesByType('heading').map((e) => e.title)).toEqual(['Installation Guide', 'API Key Setup']);
    expect(idx.getEntriesByType('paragraph')).toHaveLength(2);
  });

  it('ranks a heading title match above content-only matches', async () => {
    setup({ 'README.md': README });
    const idx = new DocumentationIndexer();
    await idx.initialize();
    const results = idx.search('installation');
    expect(results[0].title).toBe('Installation Guide'); // title match (+3) × heading bonus (1.5)
    expect(results[0].type).toBe('heading');
  });

  it('respects the maxResults cap', async () => {
    setup({ 'README.md': README });
    const idx = new DocumentationIndexer();
    await idx.initialize();
    expect(idx.search('api key install typescript', 1)).toHaveLength(1);
  });

  it('indexes .txt files as paragraphs only (no headings)', async () => {
    setup({ 'docs/notes.txt': 'A long enough plain-text note about configuration and setup steps.' });
    const idx = new DocumentationIndexer();
    await idx.initialize();
    expect(idx.getEntriesByType('heading')).toEqual([]);
    expect(idx.getEntriesByType('paragraph')).toHaveLength(1);
  });

  it('returns early (never ready) when no workspace folder is open', async () => {
    vi.spyOn(workspace, 'workspaceFolders', 'get').mockReturnValue(undefined as never);
    const idx = new DocumentationIndexer();
    await idx.initialize();
    expect(idx.isReady()).toBe(false);
  });

  it('skips a file that fails to read and still indexes the rest', async () => {
    setup({ 'README.md': README, 'docs/broken.md': 'x' });
    vi.spyOn(workspace.fs, 'readFile').mockImplementation((async (uri: { fsPath: string }) => {
      if (uri.fsPath.includes('broken')) throw new Error('EIO');
      return Buffer.from(README);
    }) as never);
    const idx = new DocumentationIndexer();
    await idx.initialize();
    expect(idx.isReady()).toBe(true);
    expect(idx.getEntryCount()).toBeGreaterThan(0);
  });
});
