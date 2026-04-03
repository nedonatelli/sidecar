import type { GitHubPR, GitHubIssue, GitHubRepoFile } from './types.js';

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
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${body}`);
    }

    return response.json() as Promise<T>;
  }

  async listPRs(owner: string, repo: string, state: string = 'open'): Promise<GitHubPR[]> {
    const data = await this.request<Array<Record<string, unknown>>>(
      `/repos/${owner}/${repo}/pulls?state=${state}&per_page=20`
    );
    return data.map((pr) => ({
      number: pr.number as number,
      title: pr.title as string,
      state: pr.state as string,
      author: (pr.user as Record<string, unknown>)?.login as string ?? 'unknown',
      url: pr.html_url as string,
      createdAt: pr.created_at as string,
      body: pr.body as string | undefined,
      head: ((pr.head as Record<string, unknown>)?.ref as string) ?? undefined,
      base: ((pr.base as Record<string, unknown>)?.ref as string) ?? undefined,
    }));
  }

  async getPR(owner: string, repo: string, number: number): Promise<GitHubPR> {
    const pr = await this.request<Record<string, unknown>>(
      `/repos/${owner}/${repo}/pulls/${number}`
    );
    return {
      number: pr.number as number,
      title: pr.title as string,
      state: (pr.merged as boolean) ? 'merged' : pr.state as string,
      author: (pr.user as Record<string, unknown>)?.login as string ?? 'unknown',
      url: pr.html_url as string,
      createdAt: pr.created_at as string,
      body: pr.body as string | undefined,
      head: ((pr.head as Record<string, unknown>)?.ref as string) ?? undefined,
      base: ((pr.base as Record<string, unknown>)?.ref as string) ?? undefined,
    };
  }

  async createPR(
    owner: string, repo: string,
    title: string, head: string, base: string,
    body?: string
  ): Promise<GitHubPR> {
    const pr = await this.request<Record<string, unknown>>(
      `/repos/${owner}/${repo}/pulls`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, head, base, body }),
      }
    );
    return {
      number: pr.number as number,
      title: pr.title as string,
      state: pr.state as string,
      author: (pr.user as Record<string, unknown>)?.login as string ?? 'unknown',
      url: pr.html_url as string,
      createdAt: pr.created_at as string,
      body: pr.body as string | undefined,
      head,
      base,
    };
  }

  async listIssues(owner: string, repo: string, state: string = 'open'): Promise<GitHubIssue[]> {
    const data = await this.request<Array<Record<string, unknown>>>(
      `/repos/${owner}/${repo}/issues?state=${state}&per_page=20`
    );
    return data
      .filter((issue) => !(issue.pull_request))
      .map((issue) => ({
        number: issue.number as number,
        title: issue.title as string,
        state: issue.state as string,
        author: (issue.user as Record<string, unknown>)?.login as string ?? 'unknown',
        url: issue.html_url as string,
        labels: (issue.labels as Array<Record<string, unknown>>)?.map((l) => l.name as string) ?? [],
        createdAt: issue.created_at as string,
        body: issue.body as string | undefined,
      }));
  }

  async getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue> {
    const issue = await this.request<Record<string, unknown>>(
      `/repos/${owner}/${repo}/issues/${number}`
    );
    return {
      number: issue.number as number,
      title: issue.title as string,
      state: issue.state as string,
      author: (issue.user as Record<string, unknown>)?.login as string ?? 'unknown',
      url: issue.html_url as string,
      labels: (issue.labels as Array<Record<string, unknown>>)?.map((l) => l.name as string) ?? [],
      createdAt: issue.created_at as string,
      body: issue.body as string | undefined,
    };
  }

  async createIssue(
    owner: string, repo: string,
    title: string, body?: string
  ): Promise<GitHubIssue> {
    const issue = await this.request<Record<string, unknown>>(
      `/repos/${owner}/${repo}/issues`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body }),
      }
    );
    return {
      number: issue.number as number,
      title: issue.title as string,
      state: issue.state as string,
      author: (issue.user as Record<string, unknown>)?.login as string ?? 'unknown',
      url: issue.html_url as string,
      labels: [],
      createdAt: issue.created_at as string,
      body: issue.body as string | undefined,
    };
  }

  async listRepoContents(owner: string, repo: string, repoPath: string = ''): Promise<GitHubRepoFile[]> {
    const endpoint = repoPath
      ? `/repos/${owner}/${repo}/contents/${repoPath}`
      : `/repos/${owner}/${repo}/contents`;
    const data = await this.request<Array<Record<string, unknown>>>(endpoint);
    return data.map((item) => ({
      name: item.name as string,
      type: item.type === 'dir' ? 'dir' : 'file',
      path: item.path as string,
      url: item.html_url as string,
    }));
  }
}
