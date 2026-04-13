import type {
  GitHubPR,
  GitHubIssue,
  GitHubRepoFile,
  GitHubRelease,
  RawPR,
  RawIssue,
  RawRelease,
  RawRepoContent,
} from './types.js';

const BASE_URL = 'https://api.github.com';

export class GitHubAPI {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  static parseRepo(input: string): { owner: string; repo: string } | null {
    // Handle owner/repo shorthand
    const shortMatch = input.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
    if (shortMatch) {
      return { owner: shortMatch[1], repo: shortMatch[2] };
    }

    // Handle full GitHub URLs (HTTPS and SSH)
    const httpsMatch = input.match(/github\.com[/:]([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }

    return null;
  }

  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${body}`);
    }

    // 204 No Content (DELETE endpoints, some PUT endpoints) — skip the
    // JSON parse that would otherwise throw on an empty body. Callers
    // that expect a 204 should type T as `void`.
    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  private parsePR(pr: RawPR): GitHubPR {
    return {
      number: pr.number,
      title: pr.title,
      state: pr.merged ? 'merged' : pr.state,
      author: pr.user?.login ?? 'unknown',
      url: pr.html_url,
      createdAt: pr.created_at,
      body: pr.body ?? undefined,
      head: pr.head?.ref,
      base: pr.base?.ref,
    };
  }

  private parseIssue(issue: RawIssue): GitHubIssue {
    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      author: issue.user?.login ?? 'unknown',
      url: issue.html_url,
      labels: issue.labels.map((l) => l.name),
      createdAt: issue.created_at,
      body: issue.body ?? undefined,
    };
  }

  async listPRs(owner: string, repo: string, state: string = 'open'): Promise<GitHubPR[]> {
    const data = await this.request<RawPR[]>(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=20`);
    return data.map((pr) => this.parsePR({ ...pr, merged: false }));
  }

  async getPR(owner: string, repo: string, number: number): Promise<GitHubPR> {
    const pr = await this.request<RawPR>(`/repos/${owner}/${repo}/pulls/${number}`);
    return this.parsePR(pr);
  }

  async createPR(
    owner: string,
    repo: string,
    title: string,
    head: string,
    base: string,
    body?: string,
  ): Promise<GitHubPR> {
    const pr = await this.request<RawPR>(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, head, base, body }),
    });
    return this.parsePR(pr);
  }

  async listIssues(owner: string, repo: string, state: string = 'open'): Promise<GitHubIssue[]> {
    const data = await this.request<RawIssue[]>(`/repos/${owner}/${repo}/issues?state=${state}&per_page=20`);
    return data.filter((issue) => !issue.pull_request).map((issue) => this.parseIssue(issue));
  }

  async getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue> {
    const issue = await this.request<RawIssue>(`/repos/${owner}/${repo}/issues/${number}`);
    return this.parseIssue(issue);
  }

  async createIssue(owner: string, repo: string, title: string, body?: string): Promise<GitHubIssue> {
    const issue = await this.request<RawIssue>(`/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
    });
    return this.parseIssue(issue);
  }

  // --- Releases ---

  private parseRelease(r: RawRelease): GitHubRelease {
    return {
      id: r.id,
      tagName: r.tag_name,
      name: r.name || r.tag_name,
      body: r.body || '',
      draft: r.draft,
      prerelease: r.prerelease,
      url: r.html_url,
      createdAt: r.created_at,
      publishedAt: r.published_at || '',
      assets: r.assets.map((a) => ({
        name: a.name,
        size: a.size,
        downloadUrl: a.browser_download_url,
        downloadCount: a.download_count,
      })),
    };
  }

  async listReleases(owner: string, repo: string): Promise<GitHubRelease[]> {
    const data = await this.request<RawRelease[]>(`/repos/${owner}/${repo}/releases?per_page=20`);
    return data.map((r) => this.parseRelease(r));
  }

  async getRelease(owner: string, repo: string, tagOrId: string): Promise<GitHubRelease> {
    // Try by tag first, fall back to by ID
    try {
      const r = await this.request<RawRelease>(`/repos/${owner}/${repo}/releases/tags/${tagOrId}`);
      return this.parseRelease(r);
    } catch {
      const r = await this.request<RawRelease>(`/repos/${owner}/${repo}/releases/${tagOrId}`);
      return this.parseRelease(r);
    }
  }

  async getLatestRelease(owner: string, repo: string): Promise<GitHubRelease> {
    const r = await this.request<RawRelease>(`/repos/${owner}/${repo}/releases/latest`);
    return this.parseRelease(r);
  }

  async createRelease(
    owner: string,
    repo: string,
    options: {
      tag: string;
      name?: string;
      body?: string;
      draft?: boolean;
      prerelease?: boolean;
      target?: string;
      generateNotes?: boolean;
    },
  ): Promise<GitHubRelease> {
    const r = await this.request<RawRelease>(`/repos/${owner}/${repo}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: options.tag,
        name: options.name || options.tag,
        body: options.body || '',
        draft: options.draft ?? false,
        prerelease: options.prerelease ?? false,
        target_commitish: options.target,
        generate_release_notes: options.generateNotes ?? false,
      }),
    });
    return this.parseRelease(r);
  }

  async deleteRelease(owner: string, repo: string, releaseId: number): Promise<void> {
    await this.request<void>(`/repos/${owner}/${repo}/releases/${releaseId}`, {
      method: 'DELETE',
    });
  }

  async listRepoContents(owner: string, repo: string, repoPath: string = ''): Promise<GitHubRepoFile[]> {
    const endpoint = repoPath ? `/repos/${owner}/${repo}/contents/${repoPath}` : `/repos/${owner}/${repo}/contents`;
    const data = await this.request<RawRepoContent[]>(endpoint);
    return data.map((item) => ({
      name: item.name,
      type: item.type === 'dir' ? 'dir' : 'file',
      path: item.path,
      url: item.html_url,
    }));
  }
}
