import { exec } from 'child_process';
import { promisify } from 'util';
import type { SideCarClient } from '../ollama/client.js';
import type { ChatMessage } from '../ollama/types.js';
import { GitCLI } from '../github/git.js';
import { GitHubAPI } from '../github/api.js';
import { getGitHubToken } from '../github/auth.js';
import {
  summarizeProtection,
  formatProtectionMarkdown,
  type ProtectionSummaryLine,
} from '../github/branchProtection.js';
import { fetchBranchRangeDiff } from './diffSource.js';
import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Draft Pull Request from current branch (v0.68 chunk 2).
//
// One command replaces the three-step manual dance most users do today:
// `git push -u origin HEAD` + craft title/body + `gh pr create`. This
// module orchestrates:
//
//   1. Resolve base branch (config → origin/HEAD → fallback chain)
//   2. Resolve current branch (not detached, not the base)
//   3. Fetch the branch-range diff via chunk 1's primitive
//   4. Generate title + body from the diff (template-aware when a
//      .github/pull_request_template.md is present — passes the
//      template shape to the model so it fills sections in place)
//   5. Show the generated body in a preview tab + confirm modal
//   6. Push the branch to origin
//   7. Call GitHubAPI.createPR with draft: config.draftByDefault
//
// Fully testable through an injected UI. Every git call funnels
// through `GitCLI` or a tight set of exec invocations the tests can
// intercept via vi.mock('child_process').
// ---------------------------------------------------------------------------

const execAsync = promisify(exec);

export interface DraftPrConfig {
  readonly draftByDefault: boolean;
  /** 'auto' resolves via `git symbolic-ref refs/remotes/origin/HEAD` → fallback chain. Otherwise used verbatim. */
  readonly baseBranch: 'auto' | string;
  /** 'auto' reads .github/pull_request_template.md when present; 'ignore' skips; absolute path reads that file. */
  readonly template: 'auto' | 'ignore' | string;
}

export interface DraftPrUi {
  /** Free-form single-line text input. Returns the final value or undefined on cancel. */
  showInputBox(prompt: string, value?: string): Promise<string | undefined>;
  /** Modal confirm-with-labels. Returns the picked label or undefined on dismiss. */
  showConfirm(message: string, options: readonly string[]): Promise<string | undefined>;
  showInfo(message: string): void;
  showError(message: string): void;
  /** Opens a markdown preview of `content` in a new editor tab. No-op on cancel. */
  openPreview(content: string, title: string): Promise<void>;
}

export interface DraftPrDeps {
  readonly ui: DraftPrUi;
  readonly client: SideCarClient;
  readonly cwd: string;
  readonly config: DraftPrConfig;
  /**
   * Injection seam for tests that don't want to wire up real GitCLI.
   * Production code omits this and the handler constructs a fresh
   * `GitCLI` scoped to `cwd`.
   */
  readonly git?: GitCLI;
  /**
   * Injection seam for tests. Production omits; handler constructs a
   * fresh `GitHubAPI` with the token from `getGitHubToken()`.
   */
  readonly api?: GitHubAPI;
}

export type DraftPrOutcome =
  | { mode: 'created'; prNumber: number; prUrl: string; draft: boolean }
  | { mode: 'cancelled'; reason: 'user-cancelled' | 'title-cancelled' | 'detached-head' | 'on-base-branch' }
  | { mode: 'no-changes' }
  | { mode: 'no-remote' }
  | { mode: 'error'; errorMessage: string };

/**
 * End-to-end Draft PR flow. Returns a typed outcome; the caller
 * (palette command or slash command handler) decides whether to
 * surface the result via toast, log, or both.
 */
export async function runDraftPullRequest(deps: DraftPrDeps): Promise<DraftPrOutcome> {
  const git = deps.git ?? new GitCLI(deps.cwd);

  // Resolve current branch. `getCurrentBranch()` returns empty string
  // on detached HEAD, not the commit sha — so an empty result is our
  // detached signal.
  const currentBranch = (await git.getCurrentBranch()).trim();
  if (!currentBranch) {
    deps.ui.showError('HEAD is detached — check out a branch before opening a PR.');
    return { mode: 'cancelled', reason: 'detached-head' };
  }

  // Resolve base branch (config override → origin/HEAD → fallback).
  let baseBranch = deps.config.baseBranch;
  if (baseBranch === 'auto') {
    baseBranch = (await resolveOriginHeadBranch(deps.cwd)) ?? 'main';
  }
  if (currentBranch === baseBranch) {
    deps.ui.showError(`You're on the base branch (${baseBranch}). Switch to a feature branch and try again.`);
    return { mode: 'cancelled', reason: 'on-base-branch' };
  }

  // Resolve remote origin to owner/repo for the GitHub API call.
  const remoteUrl = await git.getRemoteUrl();
  if (!remoteUrl) {
    deps.ui.showError('No "origin" remote configured. Add a GitHub remote before using Create Pull Request.');
    return { mode: 'no-remote' };
  }
  const parsed = GitHubAPI.parseRepo(remoteUrl);
  if (!parsed) {
    deps.ui.showError(`origin remote isn't a GitHub repo (${remoteUrl}).`);
    return { mode: 'no-remote' };
  }
  const { owner, repo } = parsed;

  // Fetch branch-range diff via chunk 1's primitive.
  const diffResult = await fetchBranchRangeDiff(baseBranch, { cwd: deps.cwd });
  if (diffResult.error) {
    deps.ui.showError(`Failed to compute diff against ${baseBranch}: ${diffResult.error}`);
    return { mode: 'error', errorMessage: diffResult.error };
  }
  if (diffResult.isEmpty) {
    deps.ui.showInfo(`No changes against ${baseBranch}. Nothing to open a PR for.`);
    return { mode: 'no-changes' };
  }

  // Fetch branch-protection rules for the base. Non-fatal — a token
  // without `repo` scope or a missing branch just means we can't
  // surface the rules, not that the flow should fail. The GitHub API
  // returns null for unprotected branches; errors we swallow and
  // note in telemetry-friendly log only.
  let protectionLines: readonly ProtectionSummaryLine[] = [];
  try {
    const api = deps.api ?? new GitHubAPI(await getGitHubToken());
    const protection = await api.getBranchProtection(owner, repo, baseBranch);
    protectionLines = summarizeProtection(protection);
  } catch {
    // Intentionally swallow — "couldn't fetch protection" shouldn't
    // block the PR creation. Users with protected bases typically
    // find out immediately when `createPR` later succeeds anyway.
  }

  // Load template if configured + present.
  const template = await loadTemplate(deps.cwd, deps.config.template);

  // Generate title + body via the active LLM. Body respects the
  // template when present; falls back to a standard section list.
  let generated: { title: string; body: string };
  try {
    generated = await generateTitleAndBody(deps.client, diffResult.diff, template, currentBranch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.ui.showError(`Failed to generate PR summary: ${message}`);
    return { mode: 'error', errorMessage: message };
  }

  // Preview body in an editor tab so the user can read the full
  // generated markdown before committing to it. Prepend the branch-
  // protection summary so the user sees "PR required / CI checks
  // required / signed commits required" before submitting. The
  // summary is prefixed to the preview only — NOT folded into the
  // PR body itself, since those rules are policy on the base branch
  // rather than content that belongs in the PR description.
  const protectionMarkdown = formatProtectionMarkdown(protectionLines);
  const previewBody = protectionMarkdown
    ? `> **Branch protection on \`${baseBranch}\`**\n>\n${protectionMarkdown
        .split('\n')
        .map((l) => '> ' + l)
        .join('\n')}\n\n---\n\n${generated.body}`
    : generated.body;
  await deps.ui.openPreview(previewBody, `PR body preview — ${currentBranch}`);

  // Confirm loop: Submit as draft / Edit title / Cancel. Edit-title
  // pops an input box and returns here; other options terminate.
  let finalTitle = generated.title;
  while (true) {
    const choice = await deps.ui.showConfirm(`Open draft PR "${finalTitle}" (${currentBranch} → ${baseBranch})?`, [
      'Submit',
      'Edit title',
      'Cancel',
    ]);
    if (choice === 'Submit') break;
    if (choice === 'Edit title') {
      const edited = await deps.ui.showInputBox('PR title', finalTitle);
      if (edited === undefined) {
        return { mode: 'cancelled', reason: 'title-cancelled' };
      }
      const trimmed = edited.trim();
      if (trimmed.length === 0) {
        deps.ui.showError('PR title cannot be empty.');
        continue;
      }
      finalTitle = trimmed;
      continue;
    }
    // Cancel, dismiss, anything else.
    return { mode: 'cancelled', reason: 'user-cancelled' };
  }

  // Push the branch to origin. `-u` sets upstream tracking so
  // subsequent `git push` calls from the same branch succeed
  // without arguments.
  try {
    await git.pushWithUpstream('origin', 'HEAD');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.ui.showError(`Failed to push ${currentBranch} to origin: ${message}`);
    return { mode: 'error', errorMessage: message };
  }

  // Call GitHub API to create the PR.
  const api = deps.api ?? new GitHubAPI(await getGitHubToken());
  const draft = deps.config.draftByDefault;
  try {
    const pr = await api.createPR(owner, repo, finalTitle, currentBranch, baseBranch, generated.body, draft);
    const label = draft ? 'Draft PR' : 'PR';
    deps.ui.showInfo(`${label} #${pr.number} opened: ${pr.url}`);
    return { mode: 'created', prNumber: pr.number, prUrl: pr.url, draft };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.ui.showError(`Failed to create PR: ${message}`);
    return { mode: 'error', errorMessage: message };
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Read the default branch on origin via `git symbolic-ref
 * refs/remotes/origin/HEAD`. Returns `main` / `master` / whatever
 * origin points at, or `null` when the ref isn't set (fresh clones
 * usually have it; ad-hoc clones may not).
 */
async function resolveOriginHeadBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd,
      maxBuffer: 256 * 1024,
    });
    // Output shape: "refs/remotes/origin/main"
    const match = stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Load a PR template when configured + present. Returns `null`
 * otherwise. Checks both the lowercase + uppercase conventional
 * paths GitHub honors.
 */
async function loadTemplate(cwd: string, mode: DraftPrConfig['template']): Promise<string | null> {
  if (mode === 'ignore') return null;
  if (mode === 'auto') {
    const candidates = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md'];
    for (const rel of candidates) {
      const full = path.join(cwd, rel);
      try {
        return await fs.promises.readFile(full, 'utf-8');
      } catch {
        // File missing — try next candidate.
      }
    }
    return null;
  }
  // Explicit path — treat as absolute or cwd-relative.
  const resolved = path.isAbsolute(mode) ? mode : path.join(cwd, mode);
  try {
    return await fs.promises.readFile(resolved, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Generate `{ title, body }` from a diff via the active LLM. The
 * model is instructed to fill the template in place when present,
 * or produce a standard-section body otherwise. Returns the first
 * line of the response as the title if the model returns a single
 * block instead of two separate outputs — matches how `summarizePR`
 * already prompts.
 */
async function generateTitleAndBody(
  client: SideCarClient,
  diff: string,
  template: string | null,
  currentBranch: string,
): Promise<{ title: string; body: string }> {
  const templateSection = template
    ? `\n\nThe repository ships a pull request template. Fill the template for this change — preserve its H2 headings and structure; add content under each section. Content for sections that don't apply to this change can be left as short "(n/a)" notes.\n\nTemplate:\n\`\`\`markdown\n${template}\n\`\`\`\n`
    : '\n\nWhen there is no template, use sections: **Summary**, **Changes**, **Testing**, **Reviewer focus**.\n';

  const messages: ChatMessage[] = [
    {
      role: 'user',
      content:
        `Generate a pull request title + body for the branch \`${currentBranch}\`.\n\n` +
        `Output EXACTLY two parts separated by a single blank line:\n\n` +
        `1. The title on the first line — one sentence, imperative mood, under 70 chars.\n` +
        `2. The body starting on the third line — markdown, ready to paste into a GitHub PR.` +
        templateSection +
        `\nHere is the branch-range diff:\n\n\`\`\`diff\n${diff}\n\`\`\``,
    },
  ];

  client.updateSystemPrompt(
    'You are a pull-request summarizer. Keep the title crisp and the body concrete. No preamble, no meta commentary — just the title line, a blank line, then the body.',
  );
  const rawResult = await client.complete(messages, 2048);
  const raw = rawResult.trim();

  // Split on the first blank line. If there isn't one (model returned
  // title-only or a dense paragraph), treat the first line as title
  // and the rest as body.
  const blankSplit = raw.match(/^([^\n]+)\n\s*\n([\s\S]*)$/);
  if (blankSplit) {
    return { title: blankSplit[1].trim(), body: blankSplit[2].trim() };
  }
  const firstLineEnd = raw.indexOf('\n');
  if (firstLineEnd === -1) {
    return { title: raw, body: '' };
  }
  return {
    title: raw.slice(0, firstLineEnd).trim(),
    body: raw.slice(firstLineEnd + 1).trim(),
  };
}
