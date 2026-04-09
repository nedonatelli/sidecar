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

export interface GitHubReleaseAsset {
  name: string;
  size: number;
  downloadUrl: string;
  downloadCount: number;
}
