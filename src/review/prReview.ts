import { GitCLI } from '../github/git.js';
import { GitHubAPI } from '../github/api.js';
import { getGitHubToken } from '../github/auth.js';
import type { PullRequest, PrReviewThread, PrReviewComment } from '../github/types.js';

// ---------------------------------------------------------------------------
// PR Review comment display (v0.69 chunk 2).
//
// Fetches inline review comments for the open PR on the current branch,
// formats them as structured markdown, and opens a preview so the
// developer can read them without leaving the editor. Optionally routes
// the full context to the agent for an automated response pass.
//
// Every touchpoint with vscode.* goes through the `PrReviewUi` interface
// so tests don't need a VS Code mock.
// ---------------------------------------------------------------------------

export interface PrReviewUi {
  showInfo(message: string): void;
  showError(message: string): void;
  openPreview(content: string, title: string): Promise<void>;
  showConfirm(message: string, options: readonly string[]): Promise<string | undefined>;
  sendToAgent(prompt: string): Promise<void>;
}

export interface PrReviewDeps {
  readonly ui: PrReviewUi;
  readonly cwd: string;
  readonly git?: GitCLI;
  readonly api?: GitHubAPI;
}

export type PrReviewOutcome =
  | { mode: 'detached-head' }
  | { mode: 'no-remote' }
  | { mode: 'no-pr'; branch: string }
  | { mode: 'no-comments'; pr: PullRequest }
  | { mode: 'rendered'; pr: PullRequest; threads: PrReviewThread[]; sentToAgent: boolean }
  | { mode: 'error'; errorMessage: string };

/**
 * End-to-end PR review comment display. Resolves the open PR for the
 * current branch, fetches inline review threads, and opens a structured
 * markdown preview — then optionally routes the full context to the agent.
 */
export async function reviewPrComments(deps: PrReviewDeps): Promise<PrReviewOutcome> {
  const git = deps.git ?? new GitCLI(deps.cwd);

  const currentBranch = (await git.getCurrentBranch()).trim();
  if (!currentBranch) {
    deps.ui.showError('HEAD is detached — check out a branch before reviewing PR comments.');
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

  // Take the first (most recent) matching PR. Multiple PRs for the
  // same branch are rare; the user can use the command again after
  // closing an older one.
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
    deps.ui.showInfo(`PR #${pr.number} has no review comments yet.`);
    return { mode: 'no-comments', pr };
  }

  const preview = formatPrReviewMarkdown(pr, threads);
  await deps.ui.openPreview(preview, `PR #${pr.number} review — ${pr.title}`);

  const choice = await deps.ui.showConfirm(
    `PR #${pr.number} has ${threads.length} review thread(s). Send to the agent for a response pass?`,
    ['Send to agent', 'Dismiss'],
  );
  let sentToAgent = false;
  if (choice === 'Send to agent') {
    const agentPrompt =
      `PR #${pr.number} "${pr.title}" on branch \`${pr.headBranch}\` has ${threads.length} review thread(s). ` +
      `Please read each comment and either address it with a code change or reply explaining why it doesn't apply.\n\n` +
      preview;
    try {
      await deps.ui.sendToAgent(agentPrompt);
      sentToAgent = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.ui.showError(`Failed to send to agent: ${message}`);
    }
  }

  return { mode: 'rendered', pr, threads, sentToAgent };
}

/**
 * Render a PR's review threads as compact markdown, grouped by file.
 * Suitable for an editor preview or as a chat turn context block.
 */
export function formatPrReviewMarkdown(pr: PullRequest, threads: PrReviewThread[]): string {
  const parts: string[] = [
    `# PR Review — #${pr.number}: ${pr.title}`,
    ``,
    `Branch: \`${pr.headBranch}\` → \`${pr.baseBranch}\` — ${pr.url}`,
    `**${threads.length} review thread(s)**`,
    ``,
  ];

  // Group threads by file path for a readable, file-structured layout.
  const byFile = new Map<string, PrReviewThread[]>();
  for (const thread of threads) {
    const existing = byFile.get(thread.path);
    if (existing) {
      existing.push(thread);
    } else {
      byFile.set(thread.path, [thread]);
    }
  }

  for (const [filePath, fileThreads] of byFile) {
    parts.push(`## ${filePath}`, ``);
    for (const thread of fileThreads) {
      const lineLabel = thread.line !== null ? ` (line ${thread.line})` : '';
      parts.push(`### Thread${lineLabel}`, ``);
      parts.push('```diff');
      parts.push(thread.diffHunk);
      parts.push('```', ``);
      for (const comment of thread.comments) {
        parts.push(formatComment(comment));
      }
      parts.push('');
    }
  }

  return parts.join('\n');
}

function formatComment(c: PrReviewComment): string {
  const date = c.createdAt.slice(0, 10);
  const indent = c.inReplyToId !== null ? '> ' : '';
  return `${indent}**${c.author}** (${date}):\n${indent}${c.body.replace(/\n/g, `\n${indent}`)}\n`;
}
