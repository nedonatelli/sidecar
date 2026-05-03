import { describe, it, expect, vi, beforeEach } from 'vitest';

// Ensure a fresh module instance per test so the module-level
// `internetChecked` / `internetAvailable` state does not leak between cases.
vi.mock('../webSearch.js', () => ({
  searchWeb: vi.fn(),
  formatSearchResults: vi.fn().mockReturnValue('formatted'),
  checkInternetConnectivity: vi.fn(),
}));

describe('webSearch function (knowledge.ts)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns offline message when first connectivity check fails', async () => {
    const { checkInternetConnectivity } = await import('../webSearch.js');
    vi.mocked(checkInternetConnectivity).mockResolvedValue(false);
    const { webSearch } = await import('./knowledge.js');

    const result = await webSearch({ query: 'test' });
    expect(result).toContain('No internet connection');
  });

  it('returns still offline when second connectivity check also fails', async () => {
    const { checkInternetConnectivity, searchWeb } = await import('../webSearch.js');
    // First call succeeds (sets internetAvailable=false via return false then another call)
    // Actually: first call → internetChecked=true, internetAvailable=false → return offline
    // We need to simulate: first call already done (internetChecked=true, internetAvailable=false)
    // then second call also returns false.
    // Simplest: run the first call with false, then run second call with false again.
    vi.mocked(checkInternetConnectivity).mockResolvedValue(false);
    const { webSearch } = await import('./knowledge.js');

    // First call: internetChecked=false → check fails → returns offline
    await webSearch({ query: 'q1' });
    // Now internetChecked=true, internetAvailable=false
    // Second call: goes to else-if branch → retry check → still false → still offline
    vi.mocked(checkInternetConnectivity).mockResolvedValue(false);
    const result = await webSearch({ query: 'q2' });
    expect(result).toContain('Still offline');
    expect(searchWeb).not.toHaveBeenCalled();
  });

  it('retries and succeeds on second call when connectivity is restored', async () => {
    const { checkInternetConnectivity, searchWeb, formatSearchResults } = await import('../webSearch.js');
    vi.mocked(checkInternetConnectivity).mockResolvedValue(false);
    vi.mocked(searchWeb).mockResolvedValue([{ title: 'R', url: 'https://x.com', snippet: 's' }]);
    vi.mocked(formatSearchResults).mockReturnValue('formatted results');
    const { webSearch } = await import('./knowledge.js');

    // First call sets internetAvailable=false
    await webSearch({ query: 'q1' });
    // Restore connectivity for the second call
    vi.mocked(checkInternetConnectivity).mockResolvedValue(true);
    const result = await webSearch({ query: 'q2' });
    expect(result).toContain('formatted results');
  });

  it('returns timeout message when searchWeb throws with timeout keyword', async () => {
    const { checkInternetConnectivity, searchWeb } = await import('../webSearch.js');
    vi.mocked(checkInternetConnectivity).mockResolvedValue(true);
    vi.mocked(searchWeb).mockRejectedValue(new Error('request timeout'));
    const { webSearch } = await import('./knowledge.js');

    const result = await webSearch({ query: 'test' });
    expect(result).toContain('timed out');
  });

  it('returns generic error message for non-timeout search errors', async () => {
    const { checkInternetConnectivity, searchWeb } = await import('../webSearch.js');
    vi.mocked(checkInternetConnectivity).mockResolvedValue(true);
    vi.mocked(searchWeb).mockRejectedValue(new Error('DNS failed'));
    const { webSearch } = await import('./knowledge.js');

    const result = await webSearch({ query: 'test' });
    expect(result).toContain('Search failed');
  });
});
