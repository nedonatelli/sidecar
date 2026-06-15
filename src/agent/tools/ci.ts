import { GitCLI } from '../../github/git.js';
import { GitHubAPI } from '../../github/api.js';
import { getGitHubToken } from '../../github/auth.js';
import { getConfig } from '../../config/settings.js';
import { parseJobLog } from '../../ci/logParser.js';
import { resolveRoot, formatToolError, type ToolExecutorContext, type RegisteredTool } from './shared.js';
import type { ToolDefinition } from '../../ollama/types.js';

// ---------------------------------------------------------------------------
// analyze_ci_failure
//
// Finds the most recent failed GitHub Actions run on the current branch,
// downloads the logs for each failed job (capped at maxLogBytes), strips
// ANSI and GHA timestamp noise, and returns a markdown summary of exactly
// which steps failed and why — ready for the agent to diagnose and fix.
//
// Deliberately scoped to diagnosis only: no branch creation, no commits,
// no pushes. The agent uses the returned context to decide what to change
// and calls the standard edit/git tools itself.
// ---------------------------------------------------------------------------

/** Match a job name against a single glob pattern. Supports * and ? wildcards. */
function matchesGlob(name: string, pattern: string): boolean {
  if (pattern === '*') return true;
  const escaped = pattern
    .split(/(\*+|\?)/)
    .map((seg, i) => (i % 2 === 0 ? seg.replace(/[.+^${}()|[\]\\]/g, '\\$&') : seg === '?' ? '[^/]' : '.*'))
    .join('');
  return new RegExp(`^${escaped}$`, 'i').test(name);
}

function jobMatchesFilter(jobName: string, filter: string[]): boolean {
  return filter.length === 0 || filter.some((p) => matchesGlob(jobName, p));
}

export const analyzeCiFailureDef: ToolDefinition = {
  name: 'analyze_ci_failure',
  description:
    'Fetch and parse the GitHub Actions log for the most recent failed CI run on the current branch. ' +
    'Returns a structured markdown summary of which jobs and steps failed, with the relevant log ' +
    'trimmed to the failure context (ANSI stripped, timestamps removed, test-runner failures windowed). ' +
    'Use this when CI is red to understand what broke before deciding how to fix it. ' +
    'Requires a GitHub token with `actions:read` scope. ' +
    'Example: `analyze_ci_failure()` — analyzes all failed jobs. ' +
    '`analyze_ci_failure(job_filter=["test"])` — scopes to jobs whose names match "test".',
  input_schema: {
    type: 'object',
    properties: {
      job_filter: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Glob patterns matched against CI job names (case-insensitive). ' +
          'Only jobs matching at least one pattern are analyzed. ' +
          'Defaults to ["*"] (all failed jobs). Supports * wildcard. ' +
          'Examples: ["test"], ["lint", "build"], ["*test*"].',
      },
    },
    required: [],
  },
  nondeterministicOutput: true,
};

export async function analyzeCiFailureTool(
  input: Record<string, unknown>,
  context?: ToolExecutorContext,
): Promise<string> {
  const config = getConfig();
  if (!config.ciAnalysisEnabled) {
    return 'CI failure analysis is disabled. Set sidecar.ci.analysis.enabled to true in settings.';
  }

  const rawFilter = input.job_filter;
  const jobFilter: string[] =
    Array.isArray(rawFilter) && rawFilter.every((s) => typeof s === 'string')
      ? (rawFilter as string[])
      : config.ciAnalysisJobFilter;

  const maxLogBytes = config.ciAnalysisMaxLogBytes;
  const cwd = resolveRoot(context);
  const git = new GitCLI(cwd);

  const branch = await git.getCurrentBranch().catch(() => '');
  if (!branch) return 'HEAD is detached — check out a branch first.';

  const remoteUrl = await git.getRemoteUrl();
  if (!remoteUrl) return 'No "origin" remote configured.';
  const parsed = GitHubAPI.parseRepo(remoteUrl);
  if (!parsed) return `origin remote isn't a GitHub repo (${remoteUrl}).`;
  const { owner, repo } = parsed;

  let token: string;
  try {
    token = await getGitHubToken();
  } catch {
    return 'No GitHub token found. Configure a Personal Access Token with actions:read scope via "SideCar: Set GitHub Token".';
  }

  const api = new GitHubAPI(token);

  try {
    const runs = await api.listWorkflowRuns(owner, repo, branch, 10);
    const failedRun = runs.find(
      (r) => r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'startup_failure',
    );

    if (!failedRun) {
      const hint =
        runs.length > 0
          ? `Latest run: **${runs[0].name}** — ${runs[0].status}${runs[0].conclusion ? ` (${runs[0].conclusion})` : ''}`
          : 'No runs found for this branch.';
      return `No failed CI runs found for branch \`${branch}\`.\n${hint}`;
    }

    const allJobs = await api.listWorkflowJobs(owner, repo, failedRun.id);
    const failedJobs = allJobs.filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out');

    if (failedJobs.length === 0) {
      return (
        `Run #${failedRun.runNumber} failed but no individual jobs show a failure conclusion yet.\n` +
        `This can happen when the run is still in progress or when a job was cancelled. Try again shortly.\n` +
        `Run URL: ${failedRun.url}`
      );
    }

    const isWildcard = jobFilter.length === 0 || (jobFilter.length === 1 && jobFilter[0] === '*');
    const targetJobs = isWildcard ? failedJobs : failedJobs.filter((j) => jobMatchesFilter(j.name, jobFilter));

    if (targetJobs.length === 0) {
      const names = failedJobs.map((j) => `\`${j.name}\``).join(', ');
      const patterns = jobFilter.map((f) => `"${f}"`).join(', ');
      return `No failed jobs matched filter [${patterns}]. Failed jobs on this run: ${names}.`;
    }

    const out: string[] = [
      `## CI Failure Analysis`,
      ``,
      `**Branch:** \`${branch}\``,
      `**Workflow:** ${failedRun.name}  **Run:** #${failedRun.runNumber}`,
      `**URL:** ${failedRun.url}`,
      ``,
    ];

    for (const job of targetJobs) {
      out.push(`---`);
      out.push(`### Failed job: \`${job.name}\``);
      out.push(``);

      // Surface step-level metadata even if the log fetch fails.
      const failedStepNames = job.steps.filter((s) => s.conclusion === 'failure').map((s) => s.name);
      if (failedStepNames.length > 0) {
        out.push(`**Failed steps:** ${failedStepNames.map((n) => `\`${n}\``).join(', ')}`);
        out.push(``);
      }

      const rawLog = await api.getJobLogs(owner, repo, job.id);
      if (!rawLog) {
        out.push(`_Log unavailable (expired or insufficient token permissions)._`);
        out.push(``);
        continue;
      }

      const parsed2 = parseJobLog(rawLog, maxLogBytes);

      if (parsed2.truncated) {
        const mbCap = (maxLogBytes / 1_000_000).toFixed(0);
        out.push(`_Log exceeded ${mbCap} MB — showing tail only._`);
        out.push(``);
      }

      if (parsed2.failedSteps.length === 0) {
        out.push(`_Could not extract individual step failures — the log may not use standard GHA step markers._`);
        out.push(`_Raw line count: ${parsed2.rawLineCount}. Check the run URL above for the full output._`);
        out.push(``);
        continue;
      }

      for (const step of parsed2.failedSteps) {
        out.push(`**Step:** \`${step.name}\``);
        out.push(`\`\`\``);
        out.push(step.errorLines.join('\n'));
        out.push(`\`\`\``);
        out.push(``);
      }
    }

    return out.join('\n');
  } catch (err) {
    return `Failed to analyze CI: ${formatToolError(err)}`;
  }
}

export const ciTools: RegisteredTool[] = [
  { definition: analyzeCiFailureDef, executor: analyzeCiFailureTool, requiresApproval: false },
];
