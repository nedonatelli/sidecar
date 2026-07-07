import type { ContextProviderConfig, ContextProviderResult, ContextIssue } from '../types.js';
import { truncateIssueBody, resolveToken } from '../types.js';
import { stripTrailingSlash } from '../../util/url.js';

interface BitbucketPR {
  id: number;
  title: string;
  state: string;
  description?: string;
  links: { html: { href: string } };
  author: { display_name: string };
  reviewers?: Array<{ display_name: string }>;
  updated_on?: string;
  source: { branch: { name: string } };
  destination: { branch: { name: string } };
}

interface BitbucketPRList {
  values?: BitbucketPR[];
  error?: { message: string };
}

/**
 * Build the Authorization header value from the token field.
 * If the token contains ":" it's treated as "username:app_password" and
 * base64-encoded for Basic auth. Otherwise it's used as a Bearer token.
 */
function buildAuthHeader(token: string): string {
  if (token.includes(':')) {
    return `Basic ${Buffer.from(token).toString('base64')}`;
  }
  return `Bearer ${token}`;
}

export async function fetchBitbucketPRs(
  config: ContextProviderConfig,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ContextProviderResult> {
  const baseUrl = config.baseUrl ? stripTrailingSlash(config.baseUrl) : 'https://api.bitbucket.org/2.0';
  const projectSlug = config.project?.trim() ?? '';
  const providerLabel = `Bitbucket (${projectSlug || 'unknown repo'})`;

  const token = resolveToken(config);
  if (!token) {
    return {
      providerLabel,
      issues: [],
      error:
        'No token configured. Set sidecar.contextProviders[].token to "username:app_password" or a Bearer token, or set SIDECAR_CTX_TOKEN_BITBUCKET.',
    };
  }

  if (!projectSlug) {
    return {
      providerLabel,
      issues: [],
      error: 'No project configured. Set sidecar.contextProviders[].project to "workspace/repo".',
    };
  }

  // Validate "workspace/repo" format
  if (!projectSlug.includes('/')) {
    return {
      providerLabel,
      issues: [],
      error: 'Invalid project format. Expected "workspace/repo" (e.g. "myteam/myrepo").',
    };
  }

  const maxResults = config.maxIssues || 5;

  const params = new URLSearchParams({ state: 'OPEN', pagelen: String(maxResults) });
  const url = `${baseUrl}/repositories/${projectSlug}/pullrequests?${params}`;

  try {
    const res = await fetchFn(url, {
      headers: {
        Authorization: buildAuthHeader(token),
        Accept: 'application/json',
      },
      signal,
    });

    if (!res.ok) {
      return {
        providerLabel,
        issues: [],
        error: `Bitbucket API error: ${res.status} ${res.statusText}`,
      };
    }

    const json = (await res.json()) as BitbucketPRList;

    if (json.error) {
      return { providerLabel, issues: [], error: `Bitbucket error: ${json.error.message}` };
    }

    const raw = json.values ?? [];
    const issues: ContextIssue[] = raw.map((pr) => ({
      id: `#${pr.id}`,
      title: pr.title,
      status: pr.state,
      body: pr.description ? truncateIssueBody(pr.description) : undefined,
      url: pr.links.html.href,
      labels: pr.reviewers?.map((r) => r.display_name).filter(Boolean),
      updatedAt: pr.updated_on ? new Date(pr.updated_on).toLocaleDateString() : undefined,
    }));

    return { providerLabel, issues };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { providerLabel, issues: [], error: `Bitbucket fetch failed: ${msg}` };
  }
}
