import { describe, it, expect, vi } from 'vitest';
import { authentication } from 'vscode';
import { getGitHubToken } from './auth.js';

describe('getGitHubToken', () => {
  it('returns token from existing session', async () => {
    vi.spyOn(authentication, 'getSession').mockResolvedValueOnce({
      accessToken: 'ghp_test123',
      id: 's1',
      scopes: ['repo'],
      account: { id: 'u1', label: 'user' },
    } as never);

    const token = await getGitHubToken();
    expect(token).toBe('ghp_test123');
  });

  it('prompts user when no existing session', async () => {
    // First call: no existing session
    vi.spyOn(authentication, 'getSession')
      .mockResolvedValueOnce(null as never)
      // Second call: user signs in
      .mockResolvedValueOnce({
        accessToken: 'ghp_new456',
        id: 's2',
        scopes: ['repo'],
        account: { id: 'u2', label: 'user' },
      } as never);

    const token = await getGitHubToken();
    expect(token).toBe('ghp_new456');
  });

  it('throws when user declines sign in', async () => {
    vi.spyOn(authentication, 'getSession')
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(null as never);

    await expect(getGitHubToken()).rejects.toThrow('GitHub sign-in is required');
  });
});
