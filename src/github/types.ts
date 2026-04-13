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
