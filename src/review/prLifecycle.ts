import { GitCLI } from '../github/git.js';
import { GitHubAPI } from '../github/api.js';
import { getGitHubToken } from '../github/auth.js';
import type { PullRequest, CheckRun } from '../github/types.js';

// ---------------------------------------------------------------------------
// PR lifecycle commands (v0.69 chunk 4).
//
// markPrReady — convert a draft PR to ready-for-review.
// checkPrCi   — snapshot the CI check runs for the PR's head SHA.
//
// Both orchestrators share the injectable-UI pattern used throughout
// the review/ modules so tests bypass VS Code APIs.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// mark-ready
// ---------------------------------------------------------------------------

export interface PrMarkReadyUi {
  showInfo(message: string): void;
  showError(message: string): void;
}

export interface PrMarkReadyDeps {
  readonly ui: PrMarkReadyUi;
  readonly cwd: string;
  readonly git?: GitCLI;
  readonly api?: GitHubAPI;
}

export type PrMarkReadyOutcome =
  | { mode: 'detached-head' }
  | { mode: 'no-remote' }
  | { mode: 'no-pr'; branch: string }
  | { mode: 'already-ready'; pr: PullRequest }
  | { mode: 'marked-ready'; pr: PullRequest }
  | { mode: 'error'; errorMessage: string };

export async function markPrReady(deps: PrMarkReadyDeps): Promise<PrMarkReadyOutcome> {
  const git = deps.git ?? new GitCLI(deps.cwd);

  const currentBranch = (await git.getCurrentBranch()).trim();
  if (!currentBranch) {
    deps.ui.showError('HEAD is detached — check out a branch first.');
    return { mode: 'detached-head' };
  }

  const remoteUrl = await git.getRemoteUrl();
  if (!remoteUrl) {
    deps.ui.showError('No "origin" remote configured.');
    return { mode: 'no-remote' };
  }
  const parsed = GitHubAPI.parseRepo(remoteUrl);
  if (!parsed) {
    deps.ui.showError(`origin remote isn't a GitHub repo (${remoteUrl}).`);
    return { mode: 'no-remote' };
  }
  const { owner, repo } = parsed;

  const api = deps.api ?? new GitHubAPI(await getGitHubToken());

  let prs: PullRequest[];
  try {
    prs = await api.listPullRequestsForBranch(owner, repo, currentBranch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.ui.showError(`Failed to list pull requests: ${message}`);
    return { mode: 'error', errorMessage: message };
  }

  if (prs.length === 0) {
    deps.ui.showInfo(`No open PR found for branch ${currentBranch}.`);
    return { mode: 'no-pr', branch: currentBranch };
  }

  const pr = prs[0];

  if (!pr.draft) {
    deps.ui.showInfo(`PR #${pr.number} is already ready for review.`);
    return { mode: 'already-ready', pr };
  }

  let updated: PullRequest;
  try {
    updated = await api.markPrReadyForReview(owner, repo, pr.number);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.ui.showError(`Failed to mark PR ready: ${message}`);
    return { mode: 'error', errorMessage: message };
  }

  deps.ui.showInfo(`PR #${updated.number} "${updated.title}" is now ready for review.`);
  return { mode: 'marked-ready', pr: updated };
}

// ---------------------------------------------------------------------------
// CI check snapshot
// ---------------------------------------------------------------------------

export interface PrCiUi {
  showInfo(message: string): void;
  showError(message: string): void;
  openPreview(content: string, title: string): Promise<void>;
  sendToAgent(prompt: string): Promise<void>;
}

export interface PrCiDeps {
  readonly ui: PrCiUi;
  readonly cwd: string;
  readonly git?: GitCLI;
  readonly api?: GitHubAPI;
}

export type PrCiOutcome =
  | { mode: 'detached-head' }
  | { mode: 'no-remote' }
  | { mode: 'no-pr'; branch: string }
  | { mode: 'no-checks'; pr: PullRequest }
  | { mode: 'rendered'; pr: PullRequest; runs: CheckRun[]; allPassed: boolean }
  | { mode: 'error'; errorMessage: string };

export function formatCheckRunsMarkdown(pr: PullRequest, runs: CheckRun[]): string {
  const passed = runs.filter((r) => r.conclusion === 'success' || r.conclusion === 'skipped').length;
  const failed = runs.filter(
    (r) => r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'action_required',
  ).length;
  const pending = runs.filter((r) => r.status !== 'completed').length;

  const summaryIcon = failed > 0 ? '❌' : pending > 0 ? '⏳' : '✅';
  const summaryLine =
    failed > 0
      ? `${failed} check(s) failed`
      : pending > 0
        ? `${pending} check(s) in progress`
        : `All ${passed} check(s) passed`;

  const parts: string[] = [
    `# CI Checks — PR #${pr.number}: ${pr.title}`,
    ``,
    `Branch: \`${pr.headBranch}\` — head SHA: \`${pr.headSha.slice(0, 8)}\``,
    ``,
    `${summaryIcon} **${summaryLine}**`,
    ``,
    `| Check | Status | Conclusion |`,
    `|-------|--------|------------|`,
  ];

  for (const run of runs) {
    const conclusion = run.conclusion ?? (run.status === 'completed' ? 'neutral' : '—');
    parts.push(`| ${run.name} | ${run.status} | ${conclusion} |`);
  }

  return parts.join('\n');
}

export async function checkPrCi(deps: PrCiDeps): Promise<PrCiOutcome> {
  const git = deps.git ?? new GitCLI(deps.cwd);

  const currentBranch = (await git.getCurrentBranch()).trim();
  if (!currentBranch) {
    deps.ui.showError('HEAD is detached — check out a branch first.');
    return { mode: 'detached-head' };
  }

  const remoteUrl = await git.getRemoteUrl();
  if (!remoteUrl) {
    deps.ui.showError('No "origin" remote configured.');
    return { mode: 'no-remote' };
  }
  const parsed = GitHubAPI.parseRepo(remoteUrl);
  if (!parsed) {
    deps.ui.showError(`origin remote isn't a GitHub repo (${remoteUrl}).`);
    return { mode: 'no-remote' };
  }
  const { owner, repo } = parsed;

  const api = deps.api ?? new GitHubAPI(await getGitHubToken());

  let prs: PullRequest[];
  try {
    prs = await api.listPullRequestsForBranch(owner, repo, currentBranch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.ui.showError(`Failed to list pull requests: ${message}`);
    return { mode: 'error', errorMessage: message };
  }

  if (prs.length === 0) {
    deps.ui.showInfo(`No open PR found for branch ${currentBranch}.`);
    return { mode: 'no-pr', branch: currentBranch };
  }

  const pr = prs[0];

  let runs: CheckRun[];
  try {
    runs = await api.getPRCheckRuns(owner, repo, pr.headSha);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.ui.showError(`Failed to fetch CI checks for PR #${pr.number}: ${message}`);
    return { mode: 'error', errorMessage: message };
  }

  if (runs.length === 0) {
    deps.ui.showInfo(`PR #${pr.number} has no CI checks yet.`);
    return { mode: 'no-checks', pr };
  }

  const preview = formatCheckRunsMarkdown(pr, runs);
  await deps.ui.openPreview(preview, `PR #${pr.number} CI checks`);

  const allPassed = runs.every(
    (r) => r.status === 'completed' && (r.conclusion === 'success' || r.conclusion === 'skipped'),
  );

  if (!allPassed) {
    const failedNames = runs
      .filter((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out')
      .map((r) => r.name);
    if (failedNames.length > 0) {
      const prompt =
        `PR #${pr.number} "${pr.title}" has ${failedNames.length} failing CI check(s): ` +
        `${failedNames.join(', ')}. ` +
        `Please investigate the failures — fetch the workflow run logs if needed — ` +
        `and fix the underlying issues.\n\n` +
        preview;
      try {
        await deps.ui.sendToAgent(prompt);
      } catch {
        // best-effort: if agent dispatch fails, the preview is already open
      }
    }
  }

  return { mode: 'rendered', pr, runs, allPassed };
}
