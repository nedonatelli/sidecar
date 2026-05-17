import type { ContextProviderConfig, ContextProviderResult, ContextIssue } from '../types.js';

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
): Promise<ContextProviderResult> {
  const baseUrl = config.baseUrl?.replace(/\/$/, '') ?? 'https://api.bitbucket.org/2.0';
  const projectSlug = config.project?.trim() ?? '';
  const providerLabel = `Bitbucket (${projectSlug || 'unknown repo'})`;

  if (!config.token) {
    return {
      providerLabel,
      issues: [],
      error: 'No token configured. Set sidecar.contextProviders[].token to "username:app_password" or a Bearer token.',
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

  const stateFilter = config.filter === 'open' || config.filter === 'assigned' ? 'OPEN' : 'OPEN';
  const maxResults = config.maxIssues || 5;

  const params = new URLSearchParams({ state: stateFilter, pagelen: String(maxResults) });
  const url = `${baseUrl}/repositories/${projectSlug}/pullrequests?${params}`;

  try {
    const res = await fetchFn(url, {
      headers: {
        Authorization: buildAuthHeader(config.token),
        Accept: 'application/json',
      },
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
      body: pr.description ? pr.description.slice(0, 400) + (pr.description.length > 400 ? '…' : '') : undefined,
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
