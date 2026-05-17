import type { ContextProviderConfig, ContextProviderResult, ContextIssue } from './types.js';
import { fetchGitHubIssues } from './providers/github.js';
import { fetchLinearIssues } from './providers/linear.js';
import { fetchJiraIssues } from './providers/jira.js';
import { fetchBitbucketPRs } from './providers/bitbucket.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  result: ContextProviderResult;
  fetchedAt: number;
}

function cacheKey(cfg: ContextProviderConfig): string {
  return `${cfg.type}:${cfg.baseUrl ?? ''}:${cfg.project ?? ''}:${cfg.filter}`;
}

function formatIssue(issue: ContextIssue): string {
  const parts: string[] = [`- **${issue.id}** ${issue.title} [${issue.status}]`];
  const meta: string[] = [];
  if (issue.priority) meta.push(`Priority: ${issue.priority}`);
  if (issue.labels?.length) meta.push(`Labels: ${issue.labels.join(', ')}`);
  if (issue.updatedAt) meta.push(`Updated: ${issue.updatedAt}`);
  if (meta.length) parts.push(`  ${meta.join(' · ')}`);
  if (issue.body) parts.push(`  ${issue.body.replace(/\n/g, ' ')}`);
  if (issue.url) parts.push(`  ${issue.url}`);
  return parts.join('\n');
}

/**
 * Format a list of provider results into the `## Active Issues` prompt block.
 * Returns an empty string when there are no results to inject (all providers
 * returned empty issue lists without errors).
 */
export function formatActiveIssues(results: ContextProviderResult[]): string {
  const sections: string[] = [];
  for (const result of results) {
    if (result.error) {
      sections.push(`### ${result.providerLabel}\n⚠️ ${result.error}`);
    } else if (result.issues.length > 0) {
      const lines = result.issues.map(formatIssue).join('\n');
      sections.push(`### ${result.providerLabel}\n${lines}`);
    }
  }
  if (sections.length === 0) return '';
  return `## Active Issues\n\n${sections.join('\n\n')}`;
}

export class ContextProviderManager {
  private cache = new Map<string, CacheEntry>();
  private fetchFn: typeof fetch;

  constructor(
    private readonly configs: ContextProviderConfig[],
    fetchFn?: typeof fetch,
    private readonly workspacePath = '',
  ) {
    this.fetchFn = fetchFn ?? fetch;
  }

  /** Fetch from all configured providers (parallel), respecting cache TTL. */
  async fetchAll(): Promise<ContextProviderResult[]> {
    if (this.configs.length === 0) return [];

    const now = Date.now();
    const tasks = this.configs.map(async (cfg): Promise<ContextProviderResult> => {
      const key = cacheKey(cfg);
      const cached = this.cache.get(key);
      if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.result;
      }
      const result = await this.fetchOne(cfg);
      this.cache.set(key, { result, fetchedAt: Date.now() });
      return result;
    });

    return Promise.all(tasks);
  }

  /** Fetch from a single provider config. */
  private fetchOne(cfg: ContextProviderConfig): Promise<ContextProviderResult> {
    switch (cfg.type) {
      case 'github':
        return fetchGitHubIssues(cfg, this.workspacePath, this.fetchFn);
      case 'linear':
        return fetchLinearIssues(cfg, this.fetchFn);
      case 'jira':
        return fetchJiraIssues(cfg, this.fetchFn);
      case 'bitbucket':
        return fetchBitbucketPRs(cfg, this.fetchFn);
    }
  }

  /** Fetch all providers and return the formatted `## Active Issues` block. */
  async buildPromptBlock(): Promise<string> {
    const results = await this.fetchAll();
    return formatActiveIssues(results);
  }

  /** Invalidate all cached entries (e.g. on config change). */
  invalidate(): void {
    this.cache.clear();
  }
}
