import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Notebook tools test — verifies source ingestion and study-aid generators
// work correctly with a mocked filesystem.
// ---------------------------------------------------------------------------

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const content = 'Mock file content for testing. '.repeat(20);
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => content),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    promises: {
      ...actual.promises,
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(content),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

// Mock fetch for web URL ingestion
vi.stubGlobal('fetch', vi.fn());

import { notebookTools, listIngestedSources, clearIngestedSources } from './notebook.js';
import type { SideCarConfig } from '../../config/settings.js';

function mockConfig(overrides: Partial<SideCarConfig> = {}): SideCarConfig {
  return {
    notebookModeEnabled: true,
    notebookModeRequireCitations: 'strict',
    notebookModeWebUrlEnabled: true,
    notebookModeSlidesEnabled: true,
    notebookModeStudyAidsEnabled: true,
    ...overrides,
  } as SideCarConfig;
}

function findTool(name: string) {
  const tool = notebookTools.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found in notebookTools`);
  return tool;
}

beforeEach(() => {
  clearIngestedSources();
  vi.clearAllMocks();
});

describe('ingest_source', () => {
  it('ingests a local file and returns an id', async () => {
    const tool = findTool('ingest_source');
    const result = await tool.executor({ source: 'docs/notes.txt', label: 'notes' }, { config: mockConfig() } as never);
    expect(result).toContain('id="notes"');
    expect(listIngestedSources()).toHaveLength(1);
    expect(listIngestedSources()[0].id).toBe('notes');
  });

  it('returns an error when webUrl is disabled', async () => {
    const tool = findTool('ingest_source');
    const result = await tool.executor({ source: 'https://example.com' }, {
      config: mockConfig({ notebookModeWebUrlEnabled: false }),
    } as never);
    expect(result).toContain('Error');
    expect(result).toContain('disabled');
  });

  it('returns an error for a missing file', async () => {
    const { promises: fsp } = await import('fs');
    const enoent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    vi.mocked(fsp.readFile).mockRejectedValueOnce(enoent);
    const tool = findTool('ingest_source');
    const result = await tool.executor({ source: 'nonexistent.txt' }, { config: mockConfig() } as never);
    expect(result).toContain('Error');
    expect(result).toContain('not found');
  });

  it('fetches a web URL and ingests it', async () => {
    const mockHtml = '<title>Test Page</title><p>Some article content here. '.repeat(10) + '</p>';
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => mockHtml,
    } as Response);

    const tool = findTool('ingest_source');
    const result = await tool.executor({ source: 'https://example.com/article' }, { config: mockConfig() } as never);
    expect(result).toContain('id="src-1"');
    expect(listIngestedSources()).toHaveLength(1);
  });
});

describe('generate_briefing', () => {
  it('returns an error when no sources are ingested', async () => {
    const tool = findTool('generate_briefing');
    const result = await tool.executor({ source_ids: '*' }, { config: mockConfig() } as never);
    expect(result).toContain('Error');
    expect(result).toContain('no sources ingested');
  });

  it('generates a briefing template when sources are present', async () => {
    // Ingest a source first
    const ingest = findTool('ingest_source');
    await ingest.executor({ source: 'paper.txt', label: 'paper' }, { config: mockConfig() } as never);

    const tool = findTool('generate_briefing');
    const result = await tool.executor({ source_ids: 'paper', project: 'test' }, { config: mockConfig() } as never);
    expect(result).toContain('paper');
    expect(result).toContain('briefing');
  });

  it('returns an error when study aids are disabled', async () => {
    const tool = findTool('generate_briefing');
    const result = await tool.executor({ source_ids: '*' }, {
      config: mockConfig({ notebookModeStudyAidsEnabled: false }),
    } as never);
    expect(result).toContain('Error');
    expect(result).toContain('disabled');
  });
});

describe('generate_study_guide', () => {
  it('returns an error when no sources are ingested', async () => {
    const tool = findTool('generate_study_guide');
    const result = await tool.executor({ source_ids: '*' }, { config: mockConfig() } as never);
    expect(result).toContain('Error');
  });

  it('generates a study guide template when sources are present', async () => {
    const ingest = findTool('ingest_source');
    await ingest.executor({ source: 'paper.txt', label: 'paper' }, { config: mockConfig() } as never);
    const tool = findTool('generate_study_guide');
    const result = await tool.executor({ source_ids: 'paper', project: 'test' }, { config: mockConfig() } as never);
    expect(result).toContain('study_guide.md');
  });

  it('returns error when study aids are disabled', async () => {
    const tool = findTool('generate_study_guide');
    const result = await tool.executor({ source_ids: '*' }, {
      config: mockConfig({ notebookModeStudyAidsEnabled: false }),
    } as never);
    expect(result).toContain('disabled');
  });
});

describe('generate_faq', () => {
  it('returns an error when no sources are ingested', async () => {
    const tool = findTool('generate_faq');
    const result = await tool.executor({ source_ids: '*' }, { config: mockConfig() } as never);
    expect(result).toContain('Error');
  });

  it('generates a faq template when sources are present', async () => {
    const ingest = findTool('ingest_source');
    await ingest.executor({ source: 'ref.txt', label: 'ref' }, { config: mockConfig() } as never);
    const tool = findTool('generate_faq');
    const result = await tool.executor({ source_ids: 'ref', project: 'test', count: 5 }, {
      config: mockConfig(),
    } as never);
    expect(result).toContain('faq.md');
  });

  it('returns error when study aids are disabled', async () => {
    const tool = findTool('generate_faq');
    const result = await tool.executor({ source_ids: '*' }, {
      config: mockConfig({ notebookModeStudyAidsEnabled: false }),
    } as never);
    expect(result).toContain('disabled');
  });
});

describe('generate_timeline', () => {
  it('returns an error when no sources are ingested', async () => {
    const tool = findTool('generate_timeline');
    const result = await tool.executor({ source_ids: '*' }, { config: mockConfig() } as never);
    expect(result).toContain('Error');
  });

  it('generates a timeline template when sources are present', async () => {
    const ingest = findTool('ingest_source');
    await ingest.executor({ source: 'history.txt', label: 'hist' }, { config: mockConfig() } as never);
    const tool = findTool('generate_timeline');
    const result = await tool.executor({ source_ids: 'hist', project: 'test' }, { config: mockConfig() } as never);
    expect(result).toContain('timeline.md');
  });

  it('returns error when study aids are disabled', async () => {
    const tool = findTool('generate_timeline');
    const result = await tool.executor({ source_ids: '*' }, {
      config: mockConfig({ notebookModeStudyAidsEnabled: false }),
    } as never);
    expect(result).toContain('disabled');
  });
});

describe('generate_outline', () => {
  it('returns an error when no sources are ingested', async () => {
    const tool = findTool('generate_outline');
    const result = await tool.executor({ source_ids: '*' }, { config: mockConfig() } as never);
    expect(result).toContain('Error');
  });

  it('generates an outline template when sources are present', async () => {
    const ingest = findTool('ingest_source');
    await ingest.executor({ source: 'notes.txt', label: 'notes' }, { config: mockConfig() } as never);
    const tool = findTool('generate_outline');
    const result = await tool.executor({ source_ids: 'notes', project: 'test', depth: 2 }, {
      config: mockConfig(),
    } as never);
    expect(result).toContain('outline.md');
  });

  it('returns error when study aids are disabled', async () => {
    const tool = findTool('generate_outline');
    const result = await tool.executor({ source_ids: '*' }, {
      config: mockConfig({ notebookModeStudyAidsEnabled: false }),
    } as never);
    expect(result).toContain('disabled');
  });
});

describe('notebook mode activation — /notebook enters citation mode', () => {
  it('notebookTools contains all 6 expected tools', () => {
    const names = notebookTools.map((t) => t.definition.name);
    expect(names).toContain('ingest_source');
    expect(names).toContain('generate_briefing');
    expect(names).toContain('generate_study_guide');
    expect(names).toContain('generate_faq');
    expect(names).toContain('generate_timeline');
    expect(names).toContain('generate_outline');
    expect(names).toHaveLength(6);
  });
});
