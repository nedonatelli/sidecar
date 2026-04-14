import { exec } from 'child_process';
import { promisify } from 'util';
import type { ToolDefinition } from '../../ollama/types.js';
import { GitCLI } from '../../github/git.js';
import { getRoot } from './shared.js';
import { compressGitDiff } from './compression.js';

const execAsync = promisify(exec);

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
};

export async function gitDiffTool(input: Record<string, unknown>): Promise<string> {
  try {
    const git = new GitCLI();
    const result = await git.diff(input.ref1 as string | undefined, input.ref2 as string | undefined);
    // Drop blob hashes and redundant diff --git preambles — these
    // carry no information the model uses when reasoning about a
    // change, so there's no cost to stripping them.
    return `${result.summary}\n\n${compressGitDiff(result.diff)}`;
  } catch (err) {
    return `git diff failed: ${err instanceof Error ? err.message : String(err)}`;
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
};

export async function gitStatus(): Promise<string> {
  try {
    return await new GitCLI().status();
  } catch (err) {
    return `git status failed: ${err instanceof Error ? err.message : String(err)}`;
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

export async function gitStage(input: Record<string, unknown>): Promise<string> {
  try {
    return await new GitCLI().stage(input.files as string[] | undefined);
  } catch (err) {
    return `git stage failed: ${err instanceof Error ? err.message : String(err)}`;
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

export async function gitCommit(input: Record<string, unknown>): Promise<string> {
  try {
    return await new GitCLI().commit(input.message as string);
  } catch (err) {
    return `git commit failed: ${err instanceof Error ? err.message : String(err)}`;
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
};

export async function gitLog(input: Record<string, unknown>): Promise<string> {
  try {
    const git = new GitCLI();
    const commits = await git.log((input.count as number) || 10);
    if (commits.length === 0) return 'No commits found.';
    return commits.map((c) => `${c.hash} ${c.message} (${c.author}, ${c.date})`).join('\n');
  } catch (err) {
    return `git log failed: ${err instanceof Error ? err.message : String(err)}`;
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

export async function gitPush(input: Record<string, unknown>): Promise<string> {
  try {
    const git = new GitCLI();
    if (input.setUpstream) {
      const branch = await git.getCurrentBranch();
      return await git.push('origin', branch);
    }
    return await git.push();
  } catch (err) {
    return `git push failed: ${err instanceof Error ? err.message : String(err)}`;
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

export async function gitPull(input: Record<string, unknown>): Promise<string> {
  try {
    // GitCLI.pull doesn't support --rebase flag yet, so handle it here
    if (input.rebase) {
      const { stdout, stderr } = await execAsync('git pull --rebase', {
        cwd: getRoot(),
        timeout: 60_000,
      });
      return (stdout + '\n' + stderr).trim() || 'Pull complete.';
    }
    return await new GitCLI().pull();
  } catch (err) {
    return `git pull failed: ${err instanceof Error ? err.message : String(err)}`;
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
};

export async function gitBranch(input: Record<string, unknown>): Promise<string> {
  const action = (input.action as string) || 'list';
  const name = input.name as string | undefined;
  try {
    const git = new GitCLI();
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
    return `git branch failed: ${err instanceof Error ? err.message : String(err)}`;
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
};

export async function gitStash(input: Record<string, unknown>): Promise<string> {
  try {
    return await new GitCLI().stash((input.action as string) || 'push', {
      message: input.message as string | undefined,
      index: input.index as number | undefined,
    });
  } catch (err) {
    return `git stash failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
