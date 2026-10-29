import { GitHubAPI } from './api.js';

/** 'not public' when GitHub will not show the repo to this caller: private, or gone. */
export type RepoVisibility = 'public' | 'private' | 'not public';

const VISIBILITY_TIMEOUT_MS = 3000;

/**
 * Whether a GitHub remote is public, for the git_push approval prompt. Null
 * for a non-GitHub URL or when GitHub could not be asked in time: the prompt
 * then says nothing rather than guess.
 *
 * Without a token the request is unauthenticated, which still answers the one
 * question that matters before a push: GitHub returns a public repo to anyone
 * and 404 for every other.
 */
export async function fetchRepoVisibility(remoteUrl: string, token?: string | null): Promise<RepoVisibility | null> {
  const parsed = GitHubAPI.parseRepo(remoteUrl);
  if (!parsed || !/github\.com/i.test(remoteUrl)) return null;
  try {
    const response = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(VISIBILITY_TIMEOUT_MS),
    });
    if (response.status === 404) return 'not public';
    if (!response.ok) return null;
    const body = (await response.json()) as { private?: boolean };
    return body.private ? 'private' : 'public';
  } catch {
    return null;
  }
}
