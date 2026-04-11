import { describe, it, expect } from 'vitest';
import type { GitHubPR, GitHubIssue, GitCommitInfo } from './types.js';

describe('GitHub types', () => {
  it('GitHubPR has expected shape', () => {
    const pr: GitHubPR = {
      number: 1,
      title: 'Test PR',
      state: 'open',
      author: 'user',
      url: 'https://github.com/org/repo/pull/1',
      createdAt: '2024-01-01',
    };
    expect(pr.number).toBe(1);
    expect(pr.title).toBe('Test PR');
  });

  it('GitHubIssue has expected shape', () => {
    const issue: GitHubIssue = {
      number: 42,
      title: 'Bug report',
      state: 'open',
      author: 'reporter',
      url: 'https://github.com/org/repo/issues/42',
      labels: ['bug', 'p1'],
      createdAt: '2024-01-01',
    };
    expect(issue.labels).toContain('bug');
  });

  it('GitCommitInfo has expected shape', () => {
    const commit: GitCommitInfo = {
      hash: 'abc123',
      author: 'dev',
      date: '2024-01-01',
      message: 'fix: resolve issue',
    };
    expect(commit.hash).toBe('abc123');
  });
});
