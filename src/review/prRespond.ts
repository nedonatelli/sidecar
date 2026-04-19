import { GitCLI } from '../github/git.js';
import { GitHubAPI } from '../github/api.js';
import { getGitHubToken } from '../github/auth.js';
import type { PullRequest, PrReviewThread } from '../github/types.js';
import { formatPrReviewMarkdown } from './prReview.js';

// ---------------------------------------------------------------------------
// PR review response dispatch (v0.69 chunk 3).
//
// Fetches review threads for the open PR on the current branch and
// dispatches the agent to respond to each one using reply_pr_comment
// and submit_pr_review. The entire flow is non-interactive from the
// user's perspective — the agent decides what to say based on the code
// context it reads.
//
// Injectable PrRespondUi keeps VS Code out of tests.
// ---------------------------------------------------------------------------

export interface PrRespondUi {
  showInfo(message: string): void;
  showError(message: string): void;
  sendToAgent(prompt: string): Promise<void>;
}

export interface PrRespondDeps {
  readonly ui: PrRespondUi;
  readonly cwd: string;
  readonly git?: GitCLI;
  readonly api?: GitHubAPI;
}

export type PrRespondOutcome =
  | { mode: 'detached-head' }
  | { mode: 'no-remote' }
  | { mode: 'no-pr'; branch: string }
  | { mode: 'no-comments'; pr: PullRequest }
  | { mode: 'dispatched'; pr: PullRequest; threadCount: number }
  | { mode: 'error'; errorMessage: string };

/**
 * Build the agent prompt for responding to PR review threads. Includes
 * the full formatted review markdown plus explicit instructions for which
 * tools to use and how to structure replies.
 */
export function buildRespondPrompt(pr: PullRequest, threads: PrReviewThread[]): string {
  const review = formatPrReviewMarkdown(pr, threads);
  return (
    `PR #${pr.number} "${pr.title}" on branch \`${pr.headBranch}\` has ${threads.length} review thread(s) waiting for a response.\n\n` +
    `For each thread below:\n` +
    `1. Read the file and line referenced in the diff hunk (use \`read_file\` if needed for full context).\n` +
    `2. Decide whether the reviewer's concern is valid:\n` +
    `   - If valid: make the appropriate code change, then call \`reply_pr_comment\` explaining what you changed.\n` +
    `   - If not applicable: call \`reply_pr_comment\` with a concise explanation of why the existing approach is correct.\n` +
    `3. After addressing all threads, call \`submit_pr_review\` with a brief summary of what was done.\n\n` +
    `Use pr_number=${pr.number} for all tool calls. The comment_id for each thread is the number in parentheses after "Thread" in the headings below.\n\n` +
    `---\n\n` +
    review
  );
}

/**
 * Fetch the open PR's review threads and dispatch the agent to respond.
 * Returns a typed outcome so callers can surface the right status to the user.
 */
export async function respondToPrComments(deps: PrRespondDeps): Promise<PrRespondOutcome> {
  const git = deps.git ?? new GitCLI(deps.cwd);

  const currentBranch = (await git.getCurrentBranch()).trim();
  if (!currentBranch) {
    deps.ui.showError('HEAD is detached — check out a branch before responding to PR comments.');
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

  let threads: PrReviewThread[];
  try {
    threads = await api.getPRReviewThreads(owner, repo, pr.number);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.ui.showError(`Failed to fetch review comments for PR #${pr.number}: ${message}`);
    return { mode: 'error', errorMessage: message };
  }

  if (threads.length === 0) {
    deps.ui.showInfo(`PR #${pr.number} has no review comments to respond to.`);
    return { mode: 'no-comments', pr };
  }

  const prompt = buildRespondPrompt(pr, threads);

  try {
    await deps.ui.sendToAgent(prompt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.ui.showError(`Failed to dispatch agent: ${message}`);
    return { mode: 'error', errorMessage: message };
  }

  deps.ui.showInfo(`Agent dispatched to respond to ${threads.length} review thread(s) on PR #${pr.number}.`);
  return { mode: 'dispatched', pr, threadCount: threads.length };
}
