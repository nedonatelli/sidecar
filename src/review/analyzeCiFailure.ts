import { GitCLI } from '../github/git.js';
import { GitHubAPI } from '../github/api.js';
import { getGitHubToken } from '../github/auth.js';
import { extractFailures, formatFailuresMarkdown, type FailureBlock } from './ciFailure.js';
import type { WorkflowRun, WorkflowJob } from '../github/types.js';

// ---------------------------------------------------------------------------
// CI Failure orchestrator (v0.68 chunk 4).
//
// Pulls the latest failed workflow run for the current branch, fetches
// each failed job's log, extracts structured failure blocks via the
// chunk 4 parser, and hands the rendered markdown to an injectable UI
// for preview + optional "Send to agent for fix" action.
//
// Every touchpoint with vscode.* goes through the `AnalyzeCiUi`
// interface so tests don't need a VS Code mock.
// ---------------------------------------------------------------------------

export interface AnalyzeCiUi {
  showInfo(message: string): void;
  showError(message: string): void;
  /** Opens a markdown preview in a new editor tab. No-op on cancel. */
  openPreview(content: string, title: string): Promise<void>;
  /**
   * Ask the user what to do with the failure summary. Returns the
   * picked label or undefined on dismiss.
   */
  showConfirm(message: string, options: readonly string[]): Promise<string | undefined>;
  /**
   * Kick off an agent turn with the failure summary. Implementation
   * typically calls the chat view's `steerEnqueue` / new-message flow.
   */
  sendToAgent(prompt: string): Promise<void>;
}

export interface AnalyzeCiDeps {
  readonly ui: AnalyzeCiUi;
  readonly cwd: string;
  readonly git?: GitCLI;
  readonly api?: GitHubAPI;
}

export type AnalyzeCiOutcome =
  | { mode: 'no-runs' }
  | { mode: 'no-failures'; latestRun: WorkflowRun }
  | { mode: 'no-remote' }
  | { mode: 'detached-head' }
  | { mode: 'rendered'; run: WorkflowRun; blocks: FailureBlock[]; sentToAgent: boolean }
  | { mode: 'error'; errorMessage: string };

/**
 * End-to-end CI failure analysis. Returns a typed outcome so the
 * caller can surface the result via toast, log, or chain further
 * actions.
 */
export async function analyzeCiFailure(deps: AnalyzeCiDeps): Promise<AnalyzeCiOutcome> {
  const git = deps.git ?? new GitCLI(deps.cwd);

  const currentBranch = (await git.getCurrentBranch()).trim();
  if (!currentBranch) {
    deps.ui.showError('HEAD is detached — check out a branch before analyzing CI.');
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

  let runs: WorkflowRun[];
  try {
    runs = await api.listWorkflowRuns(owner, repo, currentBranch, 10);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.ui.showError(`Failed to list workflow runs: ${message}`);
    return { mode: 'error', errorMessage: message };
  }

  if (runs.length === 0) {
    deps.ui.showInfo(`No workflow runs found for branch ${currentBranch}.`);
    return { mode: 'no-runs' };
  }

  // Find the latest completed run with a failing conclusion. We
  // intentionally skip in-progress runs — analyzing half-complete
  // logs produces misleading output.
  const latestFailed = runs.find(
    (r) => r.status === 'completed' && (r.conclusion === 'failure' || r.conclusion === 'timed_out'),
  );

  if (!latestFailed) {
    const latest = runs[0];
    deps.ui.showInfo(
      `Latest run on ${currentBranch} is ${latest.conclusion ?? latest.status} (#${latest.runNumber}) — no failing run to analyze.`,
    );
    return { mode: 'no-failures', latestRun: latest };
  }

  let jobs: WorkflowJob[];
  try {
    jobs = await api.listWorkflowJobs(owner, repo, latestFailed.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.ui.showError(`Failed to list jobs for run #${latestFailed.runNumber}: ${message}`);
    return { mode: 'error', errorMessage: message };
  }

  const failedJobs = jobs.filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out');
  if (failedJobs.length === 0) {
    deps.ui.showInfo(`Run #${latestFailed.runNumber} is marked failed but no job failures were found.`);
    return { mode: 'no-failures', latestRun: latestFailed };
  }

  // Pull logs for each failed job + extract failure blocks. Log fetch
  // may return null (expired / deleted) or throw (transient); in
  // either case we include the job in output with a placeholder so
  // the user sees every failed job even if some logs are unreadable.
  const allBlocks: FailureBlock[] = [];
  const sectionParts: string[] = [];
  for (const job of failedJobs) {
    sectionParts.push(`## Job: ${job.name}`);
    if (job.url) sectionParts.push(`URL: ${job.url}`);
    let log: string | null;
    try {
      log = await api.getJobLogs(owner, repo, job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sectionParts.push(`_Could not fetch logs: ${message}_`);
      continue;
    }
    if (log === null) {
      sectionParts.push('_Logs unavailable (expired or deleted)._');
      continue;
    }
    const blocks = extractFailures(log);
    if (blocks.length === 0) {
      // Fallback: include the tail of the log so the user isn't left
      // empty-handed when no `##[error]` markers were emitted.
      const tail = log.split(/\r?\n/).slice(-40).join('\n');
      sectionParts.push('_No `##[error]` markers found. Last 40 log lines:_');
      sectionParts.push('```');
      sectionParts.push(tail);
      sectionParts.push('```');
      continue;
    }
    allBlocks.push(...blocks);
    sectionParts.push(formatFailuresMarkdown(blocks));
  }

  const preview =
    `# CI Failure — Run #${latestFailed.runNumber}\n\n` +
    `Branch: \`${latestFailed.headBranch}\` — ${latestFailed.url}\n\n` +
    sectionParts.join('\n\n');

  await deps.ui.openPreview(preview, `CI failure — run #${latestFailed.runNumber}`);

  // Offer to route to the agent. Users who want to read the summary
  // and fix manually just dismiss.
  const choice = await deps.ui.showConfirm(
    `Analyzed ${failedJobs.length} failed job(s) in run #${latestFailed.runNumber}. Send to the agent for a fix?`,
    ['Send to agent', 'Dismiss'],
  );
  let sentToAgent = false;
  if (choice === 'Send to agent') {
    const agentPrompt =
      `CI run #${latestFailed.runNumber} failed on branch \`${latestFailed.headBranch}\`. ` +
      `Please analyze the failure below and fix the underlying cause.\n\n` +
      preview;
    try {
      await deps.ui.sendToAgent(agentPrompt);
      sentToAgent = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.ui.showError(`Failed to send to agent: ${message}`);
    }
  }

  return { mode: 'rendered', run: latestFailed, blocks: allBlocks, sentToAgent };
}
