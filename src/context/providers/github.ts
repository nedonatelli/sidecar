import { exec } from 'child_process';
import { promisify } from 'util';
import type { ContextProviderConfig, ContextProviderResult, ContextIssue } from '../types.js';
import { truncateIssueBody } from '../types.js';
import { stripTrailingSlash } from '../../util/url.js';

const execAsync = promisify(exec);

/** Detect "owner/repo" from the first git remote URL. */
async function detectRepo(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git remote get-url origin', { cwd, timeout: 5000 });
    const url = stdout.trim();
    // https://github.com/owner/repo.git  or  git@github.com:owner/repo.git
    const https = url.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (https) return https[1];
    const ssh = url.match(/github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
    if (ssh) return ssh[1];
    return null;
  } catch {
    return null;
  }
}

interface GHIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  body: string | null;
  labels: Array<{ name: string }>;
  updated_at: string;
}

export async function fetchGitHubIssues(
  config: ContextProviderConfig,
  workspacePath: string,
  fetchFn: typeof fetch = fetch,
): Promise<ContextProviderResult> {
  const baseUrl = config.baseUrl ? stripTrailingSlash(config.baseUrl) : 'https://api.github.com';
  const repo = config.project || (await detectRepo(workspacePath));

  if (!repo) {
    return {
      providerLabel: 'GitHub',
      issues: [],
      error: 'Could not detect GitHub repo. Set sidecar.contextProviders[].project to "owner/repo".',
    };
  }

  const providerLabel = `GitHub (${repo})`;

  if (!config.token) {
    return { providerLabel, issues: [], error: 'No token configured. Set sidecar.contextProviders[].token.' };
  }

  try {
    const params = new URLSearchParams({
      state: 'open',
      per_page: String(config.maxIssues || 5),
      sort: 'updated',
    });
    if (config.filter === 'assigned') params.set('assignee', '@me');

    const url = `${baseUrl}/repos/${repo}/issues?${params}`;
    const res = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!res.ok) {
      return { providerLabel, issues: [], error: `GitHub API error: ${res.status} ${res.statusText}` };
    }

    const raw = (await res.json()) as GHIssue[];
    const issues: ContextIssue[] = raw.slice(0, config.maxIssues || 5).map((gh) => ({
      id: `#${gh.number}`,
      title: gh.title,
      status: gh.state,
      body: gh.body ? truncateIssueBody(gh.body) : undefined,
      url: gh.html_url,
      labels: gh.labels.map((l) => l.name),
      updatedAt: gh.updated_at ? new Date(gh.updated_at).toLocaleDateString() : undefined,
    }));

    return { providerLabel, issues };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { providerLabel, issues: [], error: `GitHub fetch failed: ${msg}` };
  }
}
