import type { ToolDefinition } from '../../ollama/types.js';
import { GitCLI } from '../../github/git.js';
import { GitHubAPI } from '../../github/api.js';
import { getGitHubToken } from '../../github/auth.js';
import { resolveRoot, type ToolExecutorContext, type RegisteredTool } from './shared.js';

// ---------------------------------------------------------------------------
// GitHub write tools (v0.69 chunk 3).
//
// Two tools that let the agent close the feedback loop on PR review comments:
//  - reply_pr_comment: post a reply to a specific inline thread
//  - submit_pr_review: post a top-level review summary
//
// Both tools derive owner/repo from the git remote so the agent doesn't
// need to be told which repo it's working in — it's always the current one.
// ---------------------------------------------------------------------------

async function resolveRepo(cwd: string): Promise<{ owner: string; repo: string; token: string } | string> {
  const git = new GitCLI(cwd);
  const remoteUrl = await git.getRemoteUrl();
  if (!remoteUrl) return 'No "origin" remote configured.';
  const parsed = GitHubAPI.parseRepo(remoteUrl);
  if (!parsed) return `origin remote isn't a GitHub repo (${remoteUrl}).`;
  const token = await getGitHubToken();
  return { ...parsed, token };
}

// ---------------------------------------------------------------------------
// reply_pr_comment
// ---------------------------------------------------------------------------

export const replyPrCommentDef: ToolDefinition = {
  name: 'reply_pr_comment',
  description:
    'Post a reply to a specific inline PR review comment thread on GitHub. ' +
    'Use after reading the code at the referenced location and deciding how to respond. ' +
    'Either describe the code change you made to address the concern, or explain why the concern does not apply. ' +
    'The reply is posted immediately — do not call this speculatively. ' +
    'pr_number and comment_id are available from the review context passed to you at the start of this task. ' +
    'Example: `reply_pr_comment(pr_number=42, comment_id=10, body="Good catch — I\'ve tightened the validation at line 44.")`.',
  input_schema: {
    type: 'object',
    properties: {
      pr_number: { type: 'number', description: 'Pull request number.' },
      comment_id: {
        type: 'number',
        description: 'ID of the root comment in the thread to reply to (the first comment, not a reply).',
      },
      body: { type: 'string', description: 'Reply text in markdown.' },
    },
    required: ['pr_number', 'comment_id', 'body'],
  },
};

export async function replyPrComment(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const prNumber = input.pr_number as number | undefined;
  const commentId = input.comment_id as number | undefined;
  const body = input.body as string | undefined;

  if (!prNumber || !commentId || !body) {
    return 'reply_pr_comment requires pr_number, comment_id, and body.';
  }

  const cwd = resolveRoot(context);
  const repoResult = await resolveRepo(cwd);
  if (typeof repoResult === 'string') return repoResult;

  const { owner, repo, token } = repoResult;
  const api = new GitHubAPI(token);

  try {
    const reply = await api.replyToPRComment(owner, repo, prNumber, commentId, body);
    return `Reply posted to PR #${prNumber} thread (comment ${commentId}): ${reply.url}`;
  } catch (err) {
    return `Failed to post reply: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// submit_pr_review
// ---------------------------------------------------------------------------

export const submitPrReviewDef: ToolDefinition = {
  name: 'submit_pr_review',
  description:
    'Submit a top-level PR review on GitHub — a general summary comment attached to the pull request as a whole, ' +
    'not to a specific line. Use after addressing all inline threads to give the reviewer an overview of what you did. ' +
    'event=COMMENT posts a plain comment; APPROVE signals the PR is ready to merge; REQUEST_CHANGES signals it is not. ' +
    'Default event is COMMENT — only use APPROVE or REQUEST_CHANGES when the situation clearly warrants it. ' +
    'Example: `submit_pr_review(pr_number=42, body="Addressed all three threads — see inline replies.", event="COMMENT")`.',
  input_schema: {
    type: 'object',
    properties: {
      pr_number: { type: 'number', description: 'Pull request number.' },
      body: { type: 'string', description: 'Review summary in markdown.' },
      event: {
        type: 'string',
        enum: ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'],
        description: 'Review event type. Default: COMMENT.',
      },
    },
    required: ['pr_number', 'body'],
  },
};

export async function submitPrReview(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const prNumber = input.pr_number as number | undefined;
  const body = input.body as string | undefined;
  const event = (input.event as 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' | undefined) ?? 'COMMENT';

  if (!prNumber || !body) {
    return 'submit_pr_review requires pr_number and body.';
  }

  const cwd = resolveRoot(context);
  const repoResult = await resolveRepo(cwd);
  if (typeof repoResult === 'string') return repoResult;

  const { owner, repo, token } = repoResult;
  const api = new GitHubAPI(token);

  try {
    const review = await api.submitPRReview(owner, repo, prNumber, body, event);
    return `PR review submitted (id ${review.id}, state ${review.state}): ${review.htmlUrl}`;
  } catch (err) {
    return `Failed to submit PR review: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const githubTools: RegisteredTool[] = [
  { definition: replyPrCommentDef, executor: replyPrComment, requiresApproval: true },
  { definition: submitPrReviewDef, executor: submitPrReview, requiresApproval: true },
];
