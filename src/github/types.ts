export interface GitHubPR {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  createdAt: string;
  body?: string;
  head?: string;
  base?: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  labels: string[];
  createdAt: string;
  body?: string;
}

export interface GitCommitInfo {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export interface GitDiffResult {
  summary: string;
  diff: string;
}

export interface GitHubRepoFile {
  name: string;
  type: 'file' | 'dir';
  path: string;
  url: string;
}

export interface GitHubRelease {
  id: number;
  tagName: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  url: string;
  createdAt: string;
  publishedAt: string;
  assets: GitHubReleaseAsset[];
}

/**
 * All GitHub / git actions dispatched from the webview.
 * Exhaustive union — update when adding a new action handler.
 */
export type GitHubAction =
  | 'clone'
  | 'push'
  | 'pull'
  | 'log'
  | 'diff'
  | 'listPRs'
  | 'getPR'
  | 'createPR'
  | 'listIssues'
  | 'getIssue'
  | 'createIssue'
  | 'listReleases'
  | 'getRelease'
  | 'createRelease'
  | 'deleteRelease'
  | 'browse';

export interface GitHubReleaseAsset {
  name: string;
  size: number;
  downloadUrl: string;
  downloadCount: number;
}

// --- Raw GitHub REST API response shapes ---
// Narrow subsets of the real payloads — only the fields we actually read.
// Keeps `api.ts` free of `as number` / `as string` casts.

interface RawUser {
  login: string;
}

interface RawLabel {
  name: string;
}

interface RawRef {
  ref: string;
}

export interface RawPR {
  number: number;
  title: string;
  state: string;
  user: RawUser | null;
  html_url: string;
  created_at: string;
  body: string | null;
  head?: RawRef;
  base?: RawRef;
  merged?: boolean;
}

export interface RawIssue {
  number: number;
  title: string;
  state: string;
  user: RawUser | null;
  html_url: string;
  labels: RawLabel[];
  created_at: string;
  body: string | null;
  pull_request?: unknown;
}

export interface RawReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
  download_count: number;
}

export interface RawRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  created_at: string;
  published_at: string | null;
  assets: RawReleaseAsset[];
}

export interface RawRepoContent {
  name: string;
  type: string;
  path: string;
  html_url: string;
}

// --- Workflow Runs (v0.68 chunk 4) ---

export type WorkflowConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'neutral'
  | 'timed_out'
  | 'action_required'
  | 'startup_failure'
  | null;

export interface RawWorkflowRun {
  id: number;
  name: string | null;
  display_title: string;
  status: string;
  conclusion: WorkflowConclusion;
  head_branch: string;
  head_sha: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_number: number;
  event: string;
}

export interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: WorkflowConclusion;
  headBranch: string;
  headSha: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  runNumber: number;
  event: string;
}

export interface RawWorkflowStep {
  name: string;
  status: string;
  conclusion: WorkflowConclusion;
  number: number;
}

export interface RawWorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: WorkflowConclusion;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps?: RawWorkflowStep[];
}

export interface WorkflowStep {
  name: string;
  status: string;
  conclusion: WorkflowConclusion;
  number: number;
}

export interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: WorkflowConclusion;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  steps: WorkflowStep[];
}

// --- Branch Protection (v0.68 chunk 3) ---
// GitHub's `GET /repos/{owner}/{repo}/branches/{branch}/protection`
// returns a nested payload where every subsection is optional and
// its presence alone signals "this rule is active". We only surface
// the five fields that actually affect agent + user push/merge
// decisions — reviewers, status checks, signed commits, admin
// enforcement, and linear history. Everything else (e.g. `url`,
// `restrictions.users` detail) is ignored.

export interface RawRequiredStatusChecks {
  strict: boolean;
  contexts: string[];
}

export interface RawRequiredPullRequestReviews {
  required_approving_review_count?: number;
  dismiss_stale_reviews?: boolean;
  require_code_owner_reviews?: boolean;
}

export interface RawBranchProtection {
  required_status_checks?: RawRequiredStatusChecks;
  required_pull_request_reviews?: RawRequiredPullRequestReviews;
  required_signatures?: { enabled: boolean };
  enforce_admins?: { enabled: boolean };
  required_linear_history?: { enabled: boolean };
  allow_force_pushes?: { enabled: boolean };
}

export interface BranchProtection {
  /** True when `required_pull_request_reviews` is present — direct push blocked for non-admins. */
  pullRequestRequired: boolean;
  /** Approver count required to merge. Undefined when PR reviews aren't required. */
  requiredApprovingReviews?: number;
  /** True when code-owner review is also required alongside general approvers. */
  codeOwnersRequired: boolean;
  /** Named required status checks (CI jobs that must pass before merge). Empty when none are configured. */
  requiredStatusChecks: string[];
  /** True when GitHub requires all commits on the branch to be signed. */
  signedCommitsRequired: boolean;
  /** True when admins are bound by the protection rules too (i.e. `enforce_admins = true`). */
  enforceAdmins: boolean;
  /** True when linear history is required (no merge commits). */
  linearHistoryRequired: boolean;
  /** True when force-push is explicitly allowed (rare; generally blocked on protected branches). */
  forcePushesAllowed: boolean;
}
