import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import type { ToolDefinition } from '../../ollama/types.js';
import { GitCLI } from '../../github/git.js';
import { GitHubAPI } from '../../github/api.js';
import { getGitHubToken } from '../../github/auth.js';
import { canPushDirect, summarizeProtection, formatProtectionMarkdown } from '../../github/branchProtection.js';
import { resolveRoot, formatToolError, type ToolExecutorContext, type RegisteredTool } from './shared.js';
import { compressGitDiff } from './compression.js';
import { getDefaultAuditBuffer } from '../audit/auditBuffer.js';
import { shouldBufferCommits } from './auditHelper.js';
import { getConfig } from '../../config/settings.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Git tools: thin wrappers over GitCLI. Keeping the full family grouped
// here makes it easy to reason about which subcommands we expose vs. the
// ones left behind run_command for deliberate reasons (e.g. --force push,
// amend, branch delete — each of which needs the confirmation gate).

export const gitDiffDef: ToolDefinition = {
  name: 'git_diff',
  description:
    'Show the git diff for the current workspace — staged + unstaged changes by default, or a comparison between two refs when both are given. ' +
    'Use to understand what a user has been working on, to draft a commit message, or to review changes before staging. Prefer this over `run_command "git diff"` for structured output. ' +
    'Not for file-level changes the agent itself just made — the review-mode shadow store and the pending-changes TreeView cover those. ' +
    'Examples: `git_diff()` for working tree, `git_diff(ref1="HEAD~3")` for the last three commits, `git_diff(ref1="main", ref2="feature/x")` to compare branches.',
  input_schema: {
    type: 'object',
    properties: {
      ref1: { type: 'string', description: 'Optional: first ref (e.g. "HEAD~3", "main", a commit SHA).' },
      ref2: {
        type: 'string',
        description:
          'Optional: second ref to compare against ref1. If omitted with ref1 set, diffs ref1 against the working tree.',
      },
    },
    required: [],
  },
  nondeterministicOutput: true,
};

export async function gitDiffTool(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  try {
    const git = new GitCLI(context?.cwd);
    const result = await git.diff(input.ref1 as string | undefined, input.ref2 as string | undefined);
    // Drop blob hashes and redundant diff --git preambles — these
    // carry no information the model uses when reasoning about a
    // change, so there's no cost to stripping them.
    return `${result.summary}\n\n${compressGitDiff(result.diff)}`;
  } catch (err) {
    return `git diff failed: ${formatToolError(err)}`;
  }
}

export const gitStatusDef: ToolDefinition = {
  name: 'git_status',
  description:
    'Show the working tree status: which files are staged, modified, or untracked. ' +
    'Use as the first step before committing — pair with `git_diff` to see the actual content changes, then `git_stage` + `git_commit`. ' +
    'Also useful for answering "what have I been working on" before the user commits. ' +
    'Not a replacement for `git_diff` — status shows filenames, diff shows content.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
  nondeterministicOutput: true,
};

export async function gitStatus(_input?: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  try {
    return await new GitCLI(context?.cwd).status();
  } catch (err) {
    return `git status failed: ${formatToolError(err)}`;
  }
}

export const gitStageDef: ToolDefinition = {
  name: 'git_stage',
  description:
    'Stage files for the next commit — specific paths, or every modified/new file if `files` is omitted. ' +
    'Use before `git_commit`. Prefer explicit file lists over staging-everything so the user reviews what ships. ' +
    'Not for unstaging (there is no unstage tool — ask the user to handle that manually). ' +
    'Examples: `git_stage(files=["src/a.ts", "src/b.ts"])` for specific files, `git_stage()` to stage all changes.',
  input_schema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Files to stage (relative paths from the project root). If omitted, stages all modified and new files.',
      },
    },
    required: [],
  },
};

export async function gitStage(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  try {
    return await new GitCLI(context?.cwd).stage(input.files as string[] | undefined);
  } catch (err) {
    return `git stage failed: ${formatToolError(err)}`;
  }
}

export const gitCommitDef: ToolDefinition = {
  name: 'git_commit',
  description:
    'Create a git commit from the currently staged changes. Automatically appends a Co-Authored-By trailer for SideCar. ' +
    "Use after `git_stage`. The user must have explicitly asked for a commit — per the operating rules, don't auto-commit as part of a larger task unless the user says so. " +
    'Not for unstaged changes (call `git_stage` first). Not for amending (call `run_command "git commit --amend"` directly when that\'s what the user actually wants). ' +
    'Follow conventional-commits format. Example: `git_commit(message="fix: handle null callback in UserCard")`.',
  input_schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description:
          'Commit message in conventional-commits format ("fix: …", "feat: …", "refactor: …"). Can span multiple lines for a body; first line is the subject.',
      },
    },
    required: ['message'],
  },
};

export async function gitCommit(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  try {
    // When a client is available (agent-loop path), stamp the commit with
    // X-AI-Model trailers so the record carries which model(s) authored it.
    // Direct callers (tests, one-off scripts) pass no client and get the
    // plain Co-Authored-By block.
    const extraTrailers = context?.client?.buildModelTrailers();
    const message = input.message as string;

    // Audit Mode v0.61 a.4: divert to the buffer and return a success
    // response the agent can reason about. The commit executes for
    // real when the user accepts the buffer via the review flow.
    if (shouldBufferCommits(context)) {
      await getDefaultAuditBuffer().queueCommit(message, extraTrailers);
      return `Commit queued in audit buffer: ${message.split('\n')[0]} (executes on accept)`;
    }

    return await new GitCLI(context?.cwd).commit(message, extraTrailers);
  } catch (err) {
    return `git commit failed: ${formatToolError(err)}`;
  }
}

export const gitLogDef: ToolDefinition = {
  name: 'git_log',
  description:
    'Show recent commit history — hash, message, author, date. ' +
    'Use when the user asks "what changed recently" or when you need context on how a file evolved before editing it. ' +
    'Not for full diffs (pair with `git_diff(ref1="<hash>")` for content). ' +
    'Defaults to the last 10 commits. Example: `git_log(count=20)` for the last 20.',
  input_schema: {
    type: 'object',
    properties: {
      count: { type: 'number', description: 'Number of commits to show. Default: 10.' },
    },
    required: [],
  },
  nondeterministicOutput: true,
};

export async function gitLog(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  try {
    const git = new GitCLI(context?.cwd);
    const commits = await git.log(Math.min(Math.max(1, (input.count as number) || 10), 200));
    if (commits.length === 0) return 'No commits found.';
    return commits.map((c) => `${c.hash} ${c.message} (${c.author}, ${c.date})`).join('\n');
  } catch (err) {
    return `git log failed: ${formatToolError(err)}`;
  }
}

export const gitPushDef: ToolDefinition = {
  name: 'git_push',
  description:
    'Push local commits on the current branch to the remote. ' +
    "Use only when the user has explicitly asked to push — pushing is irreversible from the agent's side and visible to collaborators. " +
    'Pass `setUpstream=true` when pushing a newly-created branch for the first time (git otherwise errors with "The current branch has no upstream"). ' +
    'Not for force-push — call `run_command "git push --force-with-lease"` explicitly, and expect the irrecoverable-operation confirmation gate to fire. ' +
    'Example: `git_push()` for an existing branch, `git_push(setUpstream=true)` for a new one.',
  input_schema: {
    type: 'object',
    properties: {
      setUpstream: {
        type: 'boolean',
        description: 'If true, sets the upstream tracking branch for a newly-created branch. Default: false.',
      },
    },
    required: [],
  },
};

export async function gitPush(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const config = getConfig();
  const git = new GitCLI(context?.cwd);

  if (config.branchProtectionEnabled) {
    try {
      const currentBranch = await git.getCurrentBranch();
      if (currentBranch) {
        const remoteUrl = await git.getRemoteUrl();
        if (remoteUrl) {
          const parsed = GitHubAPI.parseRepo(remoteUrl);
          if (parsed) {
            const token = await getGitHubToken().catch(() => null);
            if (token) {
              const api = new GitHubAPI(token);
              const protection = await api
                .getBranchProtection(parsed.owner, parsed.repo, currentBranch)
                .catch(() => null);
              if (!canPushDirect(protection)) {
                const summary = formatProtectionMarkdown(summarizeProtection(protection));
                return (
                  `Branch protection check: \`${currentBranch}\` requires a pull request — direct push is blocked.\n\n` +
                  summary +
                  `\n\nPush aborted. Create a PR from this branch instead of pushing directly.`
                );
              }
              if (config.branchProtectionWarnEvenIfPassing && protection) {
                const lines = summarizeProtection(protection);
                if (lines.length > 0) {
                  const pushResult = input.setUpstream ? await git.push('origin', currentBranch) : await git.push();
                  return `${pushResult}\n\nBranch protection on \`${currentBranch}\`:\n${formatProtectionMarkdown(lines)}`;
                }
              }
            }
          }
        }
      }
    } catch {
      // Non-fatal — if the protection check fails for any reason, fall through to the push.
    }
  }

  try {
    if (input.setUpstream) {
      const branch = await git.getCurrentBranch();
      return await git.push('origin', branch);
    }
    return await git.push();
  } catch (err) {
    return `git push failed: ${formatToolError(err)}`;
  }
}

export const gitPullDef: ToolDefinition = {
  name: 'git_pull',
  description:
    'Pull changes from the remote on the current branch. ' +
    'Use when the user explicitly asks to sync with remote or when a push was rejected because the branch is behind. ' +
    'If pull results in merge conflicts, surface them and ask the user to resolve — the agent does not have a reliable conflict-resolution workflow. ' +
    'Pass `rebase=true` to rebase local commits on top of the remote instead of merging (cleaner history when you know nobody else has your commits). ' +
    'Example: `git_pull()` for a plain merge pull, `git_pull(rebase=true)` for a rebase pull.',
  input_schema: {
    type: 'object',
    properties: {
      rebase: { type: 'boolean', description: 'If true, pull with rebase instead of merge. Default: false (merge).' },
    },
    required: [],
  },
};

export async function gitPull(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  try {
    // GitCLI.pull doesn't support --rebase flag yet, so handle it here
    if (input.rebase) {
      const { stdout, stderr } = await execAsync('git pull --rebase', {
        cwd: resolveRoot(context),
        timeout: 60_000,
      });
      return (stdout + '\n' + stderr).trim() || 'Pull complete.';
    }
    return await new GitCLI(context?.cwd).pull();
  } catch (err) {
    return `git pull failed: ${formatToolError(err)}`;
  }
}

export const gitBranchDef: ToolDefinition = {
  name: 'git_branch',
  description:
    'Manage git branches: list all, create a new one, or switch to an existing one. ' +
    'Use when starting a new feature (`create`), moving between work streams (`switch`), or checking what branches exist (`list`). ' +
    'Not for deleting branches — no delete action is exposed here on purpose; call `run_command "git branch -d <name>"` if the user asks, and expect the irrecoverable-operation gate. ' +
    'Examples: `git_branch(action="list")`, `git_branch(action="create", name="feature/oauth")`, `git_branch(action="switch", name="main")`.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'create', 'switch'],
        description:
          'Action to perform. "list" shows all branches, "create" makes a new branch, "switch" checks out an existing one. Default: "list".',
      },
      name: { type: 'string', description: 'Branch name (required for `create` and `switch`).' },
    },
    required: [],
  },
  nondeterministicOutput: true,
};

export async function gitBranch(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const action = (input.action as string) || 'list';
  const name = input.name as string | undefined;
  try {
    const git = new GitCLI(context?.cwd);
    switch (action) {
      case 'create': {
        if (!name) return 'Error: branch name required for create.';
        return await git.createBranch(name);
      }
      case 'switch': {
        if (!name) return 'Error: branch name required for switch.';
        return await git.switchBranch(name);
      }
      default: {
        const branches = await git.listBranches(true);
        return branches.join('\n') || 'No branches found.';
      }
    }
  } catch (err) {
    return `git branch failed: ${formatToolError(err)}`;
  }
}

export const gitStashDef: ToolDefinition = {
  name: 'git_stash',
  description:
    'Stash the current working-tree changes or restore a previously-stashed state. ' +
    'Use when the user wants to park in-progress work to switch branches cleanly, or to try a different approach without losing the current one. ' +
    'Actions: `push` saves current changes and resets the working tree; `pop` restores the most recent stash and drops it; `apply` restores without dropping; `list` shows saved stashes; `drop` removes a stash. ' +
    'Examples: `git_stash(action="push", message="WIP: auth refactor")`, `git_stash(action="pop")`, `git_stash(action="list")`.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['push', 'pop', 'apply', 'list', 'drop'],
        description: 'Action to perform. Default: "push" (save current changes).',
      },
      message: { type: 'string', description: 'Optional message attached to a `push` stash for later identification.' },
      index: { type: 'number', description: 'Stash index for `pop`/`apply`/`drop`. Default: 0 (most recent stash).' },
    },
    required: [],
  },
  nondeterministicOutput: true,
};

export async function gitStash(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  try {
    return await new GitCLI(context?.cwd).stash((input.action as string) || 'push', {
      message: input.message as string | undefined,
      index: input.index as number | undefined,
    });
  } catch (err) {
    return `git stash failed: ${formatToolError(err)}`;
  }
}

export const gitSearchHistoryDef: ToolDefinition = {
  name: 'git_search_history',
  description:
    'Semantically search git history to find when something was introduced, changed, or removed. ' +
    'Supports three search modes: `message` searches commit messages (good for feature names, ticket refs, author intent); ' +
    "`content` searches the actual code changes using git's pickaxe — finds the exact commit that added or deleted a string, function name, or symbol; " +
    '`both` runs both searches and deduplicates. ' +
    'Use this to answer "when was X added?", "who removed Y?", "which commit broke Z?", or "find the auth refactor" — ' +
    'pair with `git_diff(ref1="<hash>")` to inspect a matched commit\'s full changes. ' +
    'Optionally scope to a file or directory with `path`. ' +
    'Examples: `git_search_history(query="rate limiting")` — finds commits mentioning rate limiting; ' +
    '`git_search_history(query="RateLimitError", search_type="content")` — finds the commit that introduced that symbol; ' +
    '`git_search_history(query="auth middleware", path="src/middleware/")` — scoped to a directory.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search term — a keyword, symbol name, feature name, or phrase.',
      },
      search_type: {
        type: 'string',
        enum: ['message', 'content', 'both'],
        description:
          '`message`: search commit messages (grep). `content`: search code changes (pickaxe -S). `both`: run both and deduplicate. Default: "both".',
      },
      max_results: {
        type: 'number',
        description: 'Maximum commits to return per search type. Default: 20.',
      },
      path: {
        type: 'string',
        description: 'Optional file or directory path to restrict the search scope.',
      },
    },
    required: ['query'],
  },
  nondeterministicOutput: true,
};

export async function gitSearchHistory(
  input: Record<string, unknown>,
  context?: ToolExecutorContext,
): Promise<string> {
  try {
    const query = (input.query as string | undefined)?.trim();
    if (!query) return 'Error: query is required.';

    const searchType = (input.search_type as string | undefined) ?? 'both';
    const maxResults = Math.min(Number(input.max_results) || 20, 100);
    const pathArg = (input.path as string | undefined)?.trim();

    const root = resolveRoot(context);
    const logFormat = '--pretty=format:%H|%as|%an|%s';

    // Use execFile (not execAsync) so all arguments are passed as separate
    // array elements — never shell-interpolated. This prevents command
    // injection via LLM-controlled `query` or `path` values.
    const runGit = async (args: string[]): Promise<string> => {
      const { stdout } = await execFileAsync('git', ['-C', root, ...args], { maxBuffer: 2 * 1024 * 1024 });
      return stdout.trim();
    };

    const parseCommits = (raw: string): Array<{ hash: string; date: string; author: string; subject: string }> => {
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash = '', date = '', author = '', ...rest] = line.split('|');
          return { hash, date, author, subject: rest.join('|') };
        });
    };

    // Build the optional path suffix as separate args after the '--' separator.
    const pathArgs: string[] = pathArg ? ['--', pathArg] : [];

    const seen = new Set<string>();
    const results: Array<{ hash: string; date: string; author: string; subject: string; via: string }> = [];

    if (searchType === 'message' || searchType === 'both') {
      const raw = await runGit([
        'log',
        '--all',
        `-${maxResults}`,
        logFormat,
        `--grep=${query}`,
        '--regexp-ignore-case',
        ...pathArgs,
      ]).catch(() => '');
      for (const c of parseCommits(raw)) {
        if (!seen.has(c.hash)) {
          seen.add(c.hash);
          results.push({ ...c, via: 'message' });
        }
      }
    }

    if (searchType === 'content' || searchType === 'both') {
      const raw = await runGit(['log', '--all', `-${maxResults}`, logFormat, '-S', query, ...pathArgs]).catch(() => '');
      for (const c of parseCommits(raw)) {
        if (!seen.has(c.hash)) {
          seen.add(c.hash);
          results.push({ ...c, via: 'content' });
        }
      }
    }

    if (results.length === 0) {
      return `No commits found matching "${query}"${pathArg ? ` in ${pathArg}` : ''}.`;
    }

    const lines = results.map(
      (c) => `${c.hash.slice(0, 9)}  ${c.date}  ${c.author}\n  ${c.subject}\n  [matched via: ${c.via}]`,
    );
    return `Found ${results.length} commit${results.length === 1 ? '' : 's'} matching "${query}":\n\n${lines.join('\n\n')}`;
  } catch (err) {
    return `git_search_history failed: ${formatToolError(err)}`;
  }
}

export const gitTools: RegisteredTool[] = [
  { definition: gitDiffDef, executor: gitDiffTool, requiresApproval: false },
  { definition: gitStatusDef, executor: gitStatus, requiresApproval: false },
  { definition: gitStageDef, executor: gitStage, requiresApproval: true },
  { definition: gitCommitDef, executor: gitCommit, requiresApproval: true },
  { definition: gitLogDef, executor: gitLog, requiresApproval: false },
  { definition: gitSearchHistoryDef, executor: gitSearchHistory, requiresApproval: false },
  { definition: gitPushDef, executor: gitPush, requiresApproval: true },
  { definition: gitPullDef, executor: gitPull, requiresApproval: true },
  { definition: gitBranchDef, executor: gitBranch, requiresApproval: true },
  { definition: gitStashDef, executor: gitStash, requiresApproval: true },
];
