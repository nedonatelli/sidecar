import type {
  GitHubPR,
  GitHubIssue,
  GitHubRepoFile,
  GitHubRelease,
  RawPR,
  RawIssue,
  RawRelease,
  RawRepoContent,
  RawBranchProtection,
  BranchProtection,
  RawWorkflowRun,
  WorkflowRun,
  RawWorkflowJob,
  WorkflowJob,
  PullRequest,
  PrReview,
  PrReviewComment,
  PrReviewThread,
  RawPrReviewComment,
  RawPrReview,
  RawPullRequestFull,
  CheckRun,
  RawCheckRun,
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
    draft?: boolean,
  ): Promise<GitHubPR> {
    const pr = await this.request<RawPR>(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, head, base, body, draft: draft ?? false }),
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

  // --- Branch Protection (v0.68 chunk 3) ---

  private parseBranchProtection(raw: RawBranchProtection): BranchProtection {
    const reviews = raw.required_pull_request_reviews;
    return {
      pullRequestRequired: reviews !== undefined,
      requiredApprovingReviews: reviews?.required_approving_review_count,
      codeOwnersRequired: reviews?.require_code_owner_reviews ?? false,
      requiredStatusChecks: raw.required_status_checks?.contexts ?? [],
      signedCommitsRequired: raw.required_signatures?.enabled ?? false,
      enforceAdmins: raw.enforce_admins?.enabled ?? false,
      linearHistoryRequired: raw.required_linear_history?.enabled ?? false,
      forcePushesAllowed: raw.allow_force_pushes?.enabled ?? false,
    };
  }

  /**
   * Fetch branch protection rules. Returns `null` when the branch
   * isn't protected (GitHub returns 404 in that case — not an error
   * from our perspective). Any other non-2xx becomes a thrown
   * `Error` from `request()` so the caller can surface it.
   */
  async getBranchProtection(owner: string, repo: string, branch: string): Promise<BranchProtection | null> {
    try {
      const raw = await this.request<RawBranchProtection>(
        `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`,
      );
      return this.parseBranchProtection(raw);
    } catch (err) {
      // GitHub returns 404 for unprotected branches; treat that as
      // "no rules" rather than an error. Any other failure bubbles.
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('404')) return null;
      throw err;
    }
  }

  // --- Workflow Runs (v0.68 chunk 4) ---

  private parseWorkflowRun(raw: RawWorkflowRun): WorkflowRun {
    return {
      id: raw.id,
      name: raw.name || raw.display_title || `Run #${raw.run_number}`,
      status: raw.status,
      conclusion: raw.conclusion,
      headBranch: raw.head_branch,
      headSha: raw.head_sha,
      url: raw.html_url,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      runNumber: raw.run_number,
      event: raw.event,
    };
  }

  private parseWorkflowJob(raw: RawWorkflowJob): WorkflowJob {
    return {
      id: raw.id,
      name: raw.name,
      status: raw.status,
      conclusion: raw.conclusion,
      url: raw.html_url,
      startedAt: raw.started_at,
      completedAt: raw.completed_at,
      steps: (raw.steps ?? []).map((s) => ({
        name: s.name,
        status: s.status,
        conclusion: s.conclusion,
        number: s.number,
      })),
    };
  }

  /**
   * List recent workflow runs for a branch. `perPage` caps the first
   * page (GitHub default is 30); tests rely on the param being honored
   * so small fixtures don't have to fabricate 30 runs.
   */
  async listWorkflowRuns(owner: string, repo: string, branch: string, perPage: number = 10): Promise<WorkflowRun[]> {
    const data = await this.request<{ workflow_runs: RawWorkflowRun[] }>(
      `/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${perPage}`,
    );
    return data.workflow_runs.map((r) => this.parseWorkflowRun(r));
  }

  async listWorkflowJobs(owner: string, repo: string, runId: number): Promise<WorkflowJob[]> {
    const data = await this.request<{ jobs: RawWorkflowJob[] }>(
      `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`,
    );
    return data.jobs.map((j) => this.parseWorkflowJob(j));
  }

  /**
   * Fetch raw log text for a job. The endpoint returns a redirect to
   * a signed blob URL; `fetch` follows it transparently. Response is
   * a plain text body (not JSON), so we route around `request` — its
   * JSON + JSON-error-body handling would corrupt log content that
   * happens to look like JSON, and a 404 (expired log) needs to
   * become `null` rather than a thrown error.
   */
  async getJobLogs(owner: string, repo: string, jobId: number): Promise<string | null> {
    const response = await fetch(`${BASE_URL}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'follow',
    });
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${body}`);
    }
    return response.text();
  }

  // --- PR Review Comments (v0.69 chunk 2) ---

  private parsePullRequestFull(raw: RawPullRequestFull): PullRequest {
    return {
      number: raw.number,
      title: raw.title,
      state: raw.merged ? 'merged' : (raw.state as 'open' | 'closed'),
      draft: raw.draft,
      author: raw.user?.login ?? 'unknown',
      url: raw.html_url,
      headBranch: raw.head.ref,
      headSha: raw.head.sha,
      baseBranch: raw.base.ref,
      createdAt: raw.created_at,
      body: raw.body ?? undefined,
    };
  }

  private parsePrReviewComment(raw: RawPrReviewComment): PrReviewComment {
    return {
      id: raw.id,
      reviewId: raw.pull_request_review_id,
      inReplyToId: raw.in_reply_to_id ?? null,
      path: raw.path,
      line: raw.line,
      diffHunk: raw.diff_hunk,
      body: raw.body,
      author: raw.user?.login ?? 'unknown',
      createdAt: raw.created_at,
      url: raw.html_url,
      commitSha: raw.commit_id,
    };
  }

  /**
   * Find the open PRs whose head branch matches the given branch name.
   * Uses the `head={owner}:{branch}` filter so results are scoped to
   * exactly this branch — not all open PRs in the repo. Returns an
   * empty array when no matching PR exists.
   */
  async listPullRequestsForBranch(owner: string, repo: string, branch: string): Promise<PullRequest[]> {
    const data = await this.request<RawPullRequestFull[]>(
      `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(owner)}:${encodeURIComponent(branch)}&per_page=10`,
    );
    return data.map((pr) => this.parsePullRequestFull(pr));
  }

  /**
   * Fetch all inline review comments for a PR as a flat list.
   * These are file-level diff comments, not issue-level PR comments.
   */
  async getPRReviewComments(owner: string, repo: string, prNumber: number): Promise<PrReviewComment[]> {
    const data = await this.request<RawPrReviewComment[]>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`,
    );
    return data.map((c) => this.parsePrReviewComment(c));
  }

  /**
   * Fetch review comments grouped into threads. A thread starts with a
   * root comment (`inReplyToId === null`) followed by any replies that
   * reference it via `inReplyToId`. Threads are ordered by file path,
   * then by the root comment's line number.
   */
  async getPRReviewThreads(owner: string, repo: string, prNumber: number): Promise<PrReviewThread[]> {
    const comments = await this.getPRReviewComments(owner, repo, prNumber);
    const roots = comments.filter((c) => c.inReplyToId === null);
    const threads: PrReviewThread[] = roots.map((root) => ({
      id: root.id,
      path: root.path,
      diffHunk: root.diffHunk,
      line: root.line,
      comments: [root, ...comments.filter((c) => c.inReplyToId === root.id)],
    }));
    // Sort by file path, then line for a predictable, readable order.
    threads.sort((a, b) => {
      const pathCmp = a.path.localeCompare(b.path);
      if (pathCmp !== 0) return pathCmp;
      return (a.line ?? 0) - (b.line ?? 0);
    });
    return threads;
  }

  /**
   * Post a reply to a specific inline review comment thread.
   * GitHub requires the ID of the root comment (not a reply) as the
   * target — replies to replies are automatically attached to the same
   * thread by the API.
   */
  async replyToPRComment(
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<PrReviewComment> {
    const raw = await this.request<RawPrReviewComment>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      },
    );
    return this.parsePrReviewComment(raw);
  }

  /**
   * Submit a top-level PR review. `event` controls the review disposition:
   * COMMENT is a plain summary; APPROVE and REQUEST_CHANGES change merge status.
   * Defaults to COMMENT so the agent doesn't accidentally approve or block a PR
   * unless it explicitly chooses to.
   */
  async submitPRReview(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' = 'COMMENT',
  ): Promise<PrReview> {
    const raw = await this.request<RawPrReview>(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, event }),
    });
    return {
      id: raw.id,
      body: raw.body,
      state: raw.state,
      htmlUrl: raw.html_url,
      submittedAt: raw.submitted_at,
    };
  }

  // --- GraphQL + PR lifecycle (v0.69 chunk 4) ---

  /**
   * Execute an authenticated GitHub GraphQL query. Throws if the
   * response contains `errors` or if the HTTP call fails.
   * The caller is responsible for structuring the query and typing T
   * — this method is a thin authenticated transport layer.
   */
  async graphql<T = Record<string, unknown>>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub GraphQL error ${response.status}: ${body}`);
    }

    const json = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      throw new Error(`GitHub GraphQL: ${json.errors.map((e) => e.message).join(', ')}`);
    }

    return json.data as T;
  }

  /**
   * Convert a draft PR to ready-for-review via PATCH.
   * Calling this on an already-ready PR is harmless — GitHub
   * returns the unchanged PR, and the caller can check `pr.draft`.
   */
  async markPrReadyForReview(owner: string, repo: string, prNumber: number): Promise<PullRequest> {
    const raw = await this.request<RawPullRequestFull>(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: false }),
    });
    return this.parsePullRequestFull(raw);
  }

  /**
   * Fetch check runs for a specific commit ref (SHA or branch name).
   * Covers both GitHub Actions workflow runs and third-party CI checks
   * (CircleCI, Travis, etc.) that report via the Checks API.
   */
  async getPRCheckRuns(owner: string, repo: string, ref: string): Promise<CheckRun[]> {
    const data = await this.request<{ check_runs: RawCheckRun[] }>(
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
    );
    return data.check_runs.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      url: r.html_url,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    }));
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
