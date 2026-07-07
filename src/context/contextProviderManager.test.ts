import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextProviderManager, formatActiveIssues } from './contextProviderManager.js';
import type { ContextProviderConfig, ContextProviderResult } from './types.js';

function makeConfig(overrides: Partial<ContextProviderConfig> = {}): ContextProviderConfig {
  return { type: 'github', token: 'tok', project: 'owner/repo', filter: 'assigned', maxIssues: 5, ...overrides };
}

// ---------------------------------------------------------------------------
// formatActiveIssues
// ---------------------------------------------------------------------------

describe('formatActiveIssues', () => {
  it('returns empty string when all results are empty with no errors', () => {
    const results: ContextProviderResult[] = [{ providerLabel: 'GitHub (owner/repo)', issues: [] }];
    expect(formatActiveIssues(results)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(formatActiveIssues([])).toBe('');
  });

  it('includes ## Active Issues heading when there are issues', () => {
    const results: ContextProviderResult[] = [
      { providerLabel: 'GitHub (owner/repo)', issues: [{ id: '#1', title: 'Fix bug', status: 'open' }] },
    ];
    expect(formatActiveIssues(results)).toContain('## Active Issues');
  });

  it('renders provider label as ### heading', () => {
    const results: ContextProviderResult[] = [
      { providerLabel: 'GitHub (owner/repo)', issues: [{ id: '#1', title: 'Fix bug', status: 'open' }] },
    ];
    expect(formatActiveIssues(results)).toContain('### GitHub (owner/repo)');
  });

  it('renders issue id, title, and status', () => {
    const results: ContextProviderResult[] = [
      { providerLabel: 'Linear', issues: [{ id: 'SC-123', title: 'Refactor auth', status: 'In Progress' }] },
    ];
    const out = formatActiveIssues(results);
    expect(out).toContain('**SC-123**');
    expect(out).toContain('Refactor auth');
    expect(out).toContain('[In Progress]');
  });

  it('renders optional fields when present', () => {
    const results: ContextProviderResult[] = [
      {
        providerLabel: 'Linear',
        issues: [
          {
            id: 'SC-1',
            title: 'T',
            status: 'Todo',
            priority: 'High',
            labels: ['bug'],
            updatedAt: '1/1/2026',
            body: 'Details here',
            url: 'https://linear.app/sc-1',
          },
        ],
      },
    ];
    const out = formatActiveIssues(results);
    expect(out).toContain('Priority: High');
    expect(out).toContain('Labels: bug');
    expect(out).toContain('Updated: 1/1/2026');
    expect(out).toContain('Details here');
    expect(out).toContain('https://linear.app/sc-1');
  });

  it('shows error line for provider with fetch error', () => {
    const results: ContextProviderResult[] = [
      { providerLabel: 'GitHub (owner/repo)', issues: [], error: 'API error: 401 Unauthorized' },
    ];
    const out = formatActiveIssues(results);
    expect(out).toContain('## Active Issues');
    expect(out).toContain('⚠️ API error: 401 Unauthorized');
  });

  it('renders multiple providers as separate sections', () => {
    const results: ContextProviderResult[] = [
      { providerLabel: 'GitHub (o/r)', issues: [{ id: '#1', title: 'A', status: 'open' }] },
      { providerLabel: 'Linear', issues: [{ id: 'SC-2', title: 'B', status: 'Todo' }] },
    ];
    const out = formatActiveIssues(results);
    expect(out).toContain('### GitHub (o/r)');
    expect(out).toContain('### Linear');
  });
});

// ---------------------------------------------------------------------------
// ContextProviderManager — caching
// ---------------------------------------------------------------------------

describe('ContextProviderManager', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  const ghResponse = {
    ok: true,
    json: async () => [
      {
        number: 42,
        title: 'Fix login',
        state: 'open',
        html_url: 'https://gh.com',
        body: null,
        labels: [],
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
  };

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue(ghResponse);
  });

  it('returns empty array when no providers configured', async () => {
    const mgr = new ContextProviderManager([], mockFetch as unknown as typeof fetch);
    expect(await mgr.fetchAll()).toEqual([]);
  });

  it('fetches from GitHub and returns a result', async () => {
    const mgr = new ContextProviderManager([makeConfig()], mockFetch as unknown as typeof fetch, '/workspace');
    const results = await mgr.fetchAll();
    expect(results).toHaveLength(1);
    expect(results[0].issues).toHaveLength(1);
    expect(results[0].issues[0].id).toBe('#42');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('returns cached result on second call within TTL', async () => {
    const mgr = new ContextProviderManager([makeConfig()], mockFetch as unknown as typeof fetch, '/workspace');
    await mgr.fetchAll();
    await mgr.fetchAll();
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('re-fetches after invalidate()', async () => {
    const mgr = new ContextProviderManager([makeConfig()], mockFetch as unknown as typeof fetch, '/workspace');
    await mgr.fetchAll();
    mgr.invalidate();
    await mgr.fetchAll();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('buildPromptBlock returns non-empty string when issues exist', async () => {
    const mgr = new ContextProviderManager([makeConfig()], mockFetch as unknown as typeof fetch, '/workspace');
    const block = await mgr.buildPromptBlock();
    expect(block).toContain('## Active Issues');
    expect(block).toContain('#42');
  });

  it('buildPromptBlock returns empty string when fetch returns no issues', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => [] });
    const mgr = new ContextProviderManager([makeConfig()], mockFetch as unknown as typeof fetch, '/workspace');
    const block = await mgr.buildPromptBlock();
    expect(block).toBe('');
  });

  it('fetches multiple providers in parallel', async () => {
    const linearFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { issues: { nodes: [] } } }),
    });
    const callOrder: string[] = [];
    const orderedFetch = vi.fn().mockImplementation((url: string) => {
      callOrder.push(url as string);
      if ((url as string).includes('github')) return ghResponse;
      return linearFetch(url);
    });
    const configs = [makeConfig({ type: 'github' }), makeConfig({ type: 'linear', token: 'lin-key' })];
    const mgr = new ContextProviderManager(configs, orderedFetch as unknown as typeof fetch, '/workspace');
    const results = await mgr.fetchAll();
    expect(results).toHaveLength(2);
  });

  it('passes a timeout AbortSignal to the underlying fetch', async () => {
    const mgr = new ContextProviderManager([makeConfig()], mockFetch as unknown as typeof fetch, '/workspace');
    await mgr.fetchAll();
    const opts = mockFetch.mock.calls[0][1] as { signal?: AbortSignal };
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal!.aborted).toBe(false);
  });

  it('aborts the fetch when the turn signal is already aborted', async () => {
    const mgr = new ContextProviderManager([makeConfig()], mockFetch as unknown as typeof fetch, '/workspace');
    await mgr.fetchAll(AbortSignal.abort());
    const opts = mockFetch.mock.calls[0][1] as { signal?: AbortSignal };
    expect(opts.signal!.aborted).toBe(true);
  });
});
