import { GitCLI } from '../github/git.js';
import { GitHubAPI } from '../github/api.js';
import { getGitHubToken } from '../github/auth.js';
import type { PullRequest } from '../github/types.js';

// ---------------------------------------------------------------------------
// PR review posting dispatch.
//
// Fetches the diff for the open PR on the current branch and dispatches
// the agent to review it, posting findings directly to GitHub as a formal
// PR review with inline comments via `create_pr_review`.
//
// Injectable PrPostReviewUi keeps VS Code out of tests.
// ---------------------------------------------------------------------------

export interface PrPostReviewUi {
  showInfo(message: string): void;
  showError(message: string): void;
  sendToAgent(prompt: string): Promise<void>;
}

export interface PrPostReviewDeps {
  readonly ui: PrPostReviewUi;
  readonly cwd: string;
  readonly git?: GitCLI;
  readonly api?: GitHubAPI;
}

export type PrPostReviewOutcome =
  | { mode: 'detached-head' }
  | { mode: 'no-remote' }
  | { mode: 'no-pr'; branch: string }
  | { mode: 'dispatched'; pr: PullRequest }
  | { mode: 'error'; errorMessage: string };

/**
 * Build the agent prompt for doing a code review and posting the results
 * as an inline-annotated GitHub PR review via `create_pr_review`.
 */
export function buildPostReviewPrompt(pr: PullRequest, diff: string): string {
  const diffSection =
    diff.length > 0
      ? `\n\`\`\`diff\n${diff.slice(0, 40_000)}${diff.length > 40_000 ? '\n... (diff truncated)' : ''}\n\`\`\``
      : '(no diff available)';

  return (
    `Review PR #${pr.number} "${pr.title}" on branch \`${pr.headBranch}\` → \`${pr.baseBranch}\`.\n\n` +
    `Your task:\n` +
    `1. Read the diff below and any relevant source files to understand the full context.\n` +
    `2. Identify issues: bugs, security concerns, style violations, missing error handling, etc.\n` +
    `3. Call \`create_pr_review\` **once** with:\n` +
    `   - \`pr_number\`: ${pr.number}\n` +
    `   - \`body\`: a concise overall review summary\n` +
    `   - \`event\`: "COMMENT" unless you are confident the PR should be approved or changes requested\n` +
    `   - \`comments\`: an array of inline findings, each with \`path\`, \`line\`, and \`body\`\n\n` +
    `Guidelines for inline comments:\n` +
    `- Only reference lines that are part of the diff (changed lines or within 3 lines of a change).\n` +
    `- Be specific and actionable. Suggest a fix where possible.\n` +
    `- Omit praise-only comments — if you have nothing to add to a line, skip it.\n` +
    `- If the PR looks good with no significant issues, post a brief APPROVE review with an empty comments array.\n\n` +
    `PR diff:\n${diffSection}`
  );
}

/**
 * End-to-end PR review posting flow. Resolves the open PR for the
 * current branch, fetches its diff, and dispatches the agent to review
 * and post findings via `create_pr_review`.
 */
export async function postPrReview(deps: PrPostReviewDeps): Promise<PrPostReviewOutcome> {
  const git = deps.git ?? new GitCLI(deps.cwd);

  const currentBranch = (await git.getCurrentBranch()).trim();
  if (!currentBranch) {
    deps.ui.showError('HEAD is detached — check out a branch before posting a PR review.');
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

  let api = deps.api;
  if (!api) {
    let token: string;
    try {
      token = await getGitHubToken();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.ui.showError(`GitHub authentication failed: ${msg}`);
      return { mode: 'error', errorMessage: msg };
    }
    api = new GitHubAPI(token);
  }

  let prs: PullRequest[];
  try {
    prs = await api.listPullRequestsForBranch(parsed.owner, parsed.repo, currentBranch);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.ui.showError(`Failed to fetch pull requests: ${msg}`);
    return { mode: 'error', errorMessage: msg };
  }

  if (prs.length === 0) {
    deps.ui.showInfo(`No open PR found for branch "${currentBranch}".`);
    return { mode: 'no-pr', branch: currentBranch };
  }

  const pr = prs[0];

  let diff = '';
  try {
    const result = await git.diff(`origin/${pr.baseBranch}...HEAD`);
    diff = result.diff;
  } catch {
    // Diff is optional — the agent can still review from the PR title + file reads.
  }

  const prompt = buildPostReviewPrompt(pr, diff);
  await deps.ui.sendToAgent(prompt);
  deps.ui.showInfo(`SideCar: dispatched agent to review PR #${pr.number} "${pr.title}".`);
  return { mode: 'dispatched', pr };
}
