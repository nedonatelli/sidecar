import { workspace, languages, Uri } from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { ToolDefinition } from '../ollama/types.js';
import type { MCPManager } from './mcpManager.js';
import { getConfig } from '../config/settings.js';
import { scanFile, formatIssues } from './securityScanner.js';
import { GitCLI } from '../github/git.js';

const execAsync = promisify(exec);

export interface ToolExecutor {
  (input: Record<string, unknown>): Promise<string>;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  executor: ToolExecutor;
  requiresApproval: boolean;
}

function getRoot(): string {
  return workspace.workspaceFolders?.[0]?.uri.fsPath || '';
}

function getRootUri(): Uri {
  return workspace.workspaceFolders![0].uri;
}

// --- Tool Definitions ---

const readFileDef: ToolDefinition = {
  name: 'read_file',
  description: 'Read the contents of a file at the given path (relative to project root).',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative file path' },
    },
    required: ['path'],
  },
};

const writeFileDef: ToolDefinition = {
  name: 'write_file',
  description: 'Create or overwrite a file with the given content.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative file path' },
      content: { type: 'string', description: 'File content to write' },
    },
    required: ['path', 'content'],
  },
};

const editFileDef: ToolDefinition = {
  name: 'edit_file',
  description: 'Edit an existing file by replacing a search string with a replacement string.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative file path' },
      search: { type: 'string', description: 'Exact text to find in the file' },
      replace: { type: 'string', description: 'Text to replace it with' },
    },
    required: ['path', 'search', 'replace'],
  },
};

const searchFilesDef: ToolDefinition = {
  name: 'search_files',
  description: 'Search for files matching a glob pattern in the workspace. Returns a list of matching file paths.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.test.js")' },
    },
    required: ['pattern'],
  },
};

const grepDef: ToolDefinition = {
  name: 'grep',
  description: 'Search file contents for a text pattern. Returns matching lines with file paths and line numbers.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Text or regex pattern to search for' },
      path: { type: 'string', description: 'Optional: limit search to this file or directory' },
    },
    required: ['pattern'],
  },
};

const runCommandDef: ToolDefinition = {
  name: 'run_command',
  description: 'Execute a shell command in the project root directory. Returns stdout and stderr.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run' },
    },
    required: ['command'],
  },
};

const listDirectoryDef: ToolDefinition = {
  name: 'list_directory',
  description: 'List the contents of a directory. Returns file and folder names.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative directory path (empty or "." for project root)' },
    },
    required: [],
  },
};

// --- Tool Executors ---

async function readFile(input: Record<string, unknown>): Promise<string> {
  const filePath = input.path as string;
  const fileUri = Uri.joinPath(getRootUri(), filePath);
  const bytes = await workspace.fs.readFile(fileUri);
  return Buffer.from(bytes).toString('utf-8');
}

async function writeFile(input: Record<string, unknown>): Promise<string> {
  const filePath = input.path as string;
  const content = input.content as string;
  const fileUri = Uri.joinPath(getRootUri(), filePath);
  // Create parent directories
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') {
    await workspace.fs.createDirectory(Uri.joinPath(getRootUri(), dir));
  }
  await workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));
  return `File written: ${filePath}`;
}

async function editFile(input: Record<string, unknown>): Promise<string> {
  const filePath = input.path as string;
  const search = input.search as string;
  const replace = input.replace as string;
  const fileUri = Uri.joinPath(getRootUri(), filePath);
  const bytes = await workspace.fs.readFile(fileUri);
  const text = Buffer.from(bytes).toString('utf-8');
  if (!text.includes(search)) {
    return `Error: Search text not found in ${filePath}`;
  }
  const newText = text.replace(search, replace);
  await workspace.fs.writeFile(fileUri, Buffer.from(newText, 'utf-8'));
  return `File edited: ${filePath}`;
}

async function searchFiles(input: Record<string, unknown>): Promise<string> {
  const pattern = input.pattern as string;
  const uris = await workspace.findFiles(
    pattern,
    `**/{node_modules,.git,out,dist,.venv,venv,__pycache__,.next}/**`,
    50,
  );
  if (uris.length === 0) return 'No files found.';
  const root = getRoot();
  return uris.map((u) => path.relative(root, u.fsPath)).join('\n');
}

async function grep(input: Record<string, unknown>): Promise<string> {
  const pattern = input.pattern as string;
  const searchPath = (input.path as string) || '.';
  const cwd = getRoot();
  try {
    const { stdout } = await execAsync(`grep -rn --include="*" "${pattern.replace(/"/g, '\\"')}" "${searchPath}"`, {
      cwd,
      timeout: 15_000,
      maxBuffer: 512 * 1024,
    });
    // Limit output
    const lines = stdout.split('\n').slice(0, 50);
    return lines.join('\n') || 'No matches found.';
  } catch (err) {
    const error = err as { stdout?: string; code?: number };
    if (error.code === 1) return 'No matches found.';
    return error.stdout || 'Grep failed.';
  }
}

async function runCommand(input: Record<string, unknown>): Promise<string> {
  const command = input.command as string;
  const cwd = getRoot();
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    return (stdout + (stderr ? '\nSTDERR:\n' + stderr : '')).trim() || '(no output)';
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return `Command failed:\n${error.stderr || error.stdout || error.message || 'Unknown error'}`;
  }
}

async function listDirectory(input: Record<string, unknown>): Promise<string> {
  const dirPath = (input.path as string) || '.';
  const dirUri = Uri.joinPath(getRootUri(), dirPath);
  const entries = await workspace.fs.readDirectory(dirUri);
  return entries.map(([name, type]) => `${type === 2 ? '📁 ' : '📄 '}${name}`).join('\n');
}

const getDiagnosticsDef: ToolDefinition = {
  name: 'get_diagnostics',
  description:
    'Get compiler errors, warnings, and linting issues from VS Code. Returns diagnostics for a specific file or all files if no path given.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Optional: relative file path to get diagnostics for. Omit for all files.' },
    },
    required: [],
  },
};

const runTestsDef: ToolDefinition = {
  name: 'run_tests',
  description:
    'Run the project test suite. Optionally specify a test file or pattern. Returns test output with pass/fail results.',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'Test command to run (e.g. "npm test", "pytest", "go test ./..."). If omitted, tries common test runners.',
      },
      file: { type: 'string', description: 'Optional: specific test file to run' },
    },
    required: [],
  },
};

async function getDiagnostics(input: Record<string, unknown>): Promise<string> {
  const filePath = input.path as string | undefined;
  const root = getRoot();

  if (filePath) {
    const fileUri = Uri.joinPath(getRootUri(), filePath);
    const diags = languages.getDiagnostics(fileUri);
    const results = diags.map((d) => {
      const line = d.range.start.line + 1;
      const severity = ['Error', 'Warning', 'Info', 'Hint'][d.severity] || 'Unknown';
      return `${filePath}:${line} [${severity}] ${d.message}`;
    });

    // Append security scan results
    const securityIssues = await scanFile(filePath);
    const securityOutput = formatIssues(securityIssues);
    if (securityOutput) results.push(securityOutput);

    return results.length > 0 ? results.join('\n') : `No diagnostics for ${filePath}`;
  }

  // All diagnostics
  const allDiags = languages.getDiagnostics();
  const results: string[] = [];
  for (const [uri, diags] of allDiags) {
    if (diags.length === 0) continue;
    const relPath = root ? path.relative(root, uri.fsPath) : uri.fsPath;
    if (relPath.includes('node_modules')) continue;
    for (const d of diags) {
      const line = d.range.start.line + 1;
      const severity = ['Error', 'Warning', 'Info', 'Hint'][d.severity] || 'Unknown';
      results.push(`${relPath}:${line} [${severity}] ${d.message}`);
    }
  }
  return results.length > 0 ? results.slice(0, 100).join('\n') : 'No diagnostics found.';
}

async function runTests(input: Record<string, unknown>): Promise<string> {
  let command = input.command as string | undefined;
  const file = input.file as string | undefined;
  const cwd = getRoot();

  if (!command) {
    // Auto-detect test runner
    try {
      const pkgBytes = await workspace.fs.readFile(Uri.joinPath(getRootUri(), 'package.json'));
      const pkg = JSON.parse(Buffer.from(pkgBytes).toString('utf-8'));
      if (pkg.scripts?.test) {
        command = 'npm test';
      }
    } catch {
      /* no package.json */
    }

    if (!command) {
      // Check for common test files/configs
      const checks: [string, string][] = [
        ['pytest.ini', 'pytest'],
        ['setup.py', 'pytest'],
        ['pyproject.toml', 'pytest'],
        ['Cargo.toml', 'cargo test'],
        ['go.mod', 'go test ./...'],
        ['build.gradle', './gradlew test'],
        ['build.gradle.kts', './gradlew test'],
      ];
      for (const [configFile, testCmd] of checks) {
        try {
          await workspace.fs.stat(Uri.joinPath(getRootUri(), configFile));
          command = testCmd;
          break;
        } catch {
          /* not found */
        }
      }
    }

    if (!command) {
      return 'Could not detect test runner. Specify a command (e.g. "npm test", "pytest").';
    }
  }

  if (file) {
    command += ` ${file}`;
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return (stdout + (stderr ? '\nSTDERR:\n' + stderr : '')).trim() || '(no output)';
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    // Test failures often exit non-zero but still have useful output
    const output = (error.stdout || '') + (error.stderr ? '\nSTDERR:\n' + error.stderr : '');
    return output.trim() || `Test command failed: ${error.message || 'Unknown error'}`;
  }
}

// --- Git Tools (backed by GitCLI) ---

const gitDiffDef: ToolDefinition = {
  name: 'git_diff',
  description:
    'Get the git diff for the current workspace. Shows staged and unstaged changes. Optionally compare between two refs.',
  input_schema: {
    type: 'object',
    properties: {
      ref1: { type: 'string', description: 'Optional: first ref (e.g. "HEAD~3", "main").' },
      ref2: { type: 'string', description: 'Optional: second ref to compare against ref1.' },
    },
    required: [],
  },
};

async function gitDiffTool(input: Record<string, unknown>): Promise<string> {
  try {
    const git = new GitCLI();
    const result = await git.diff(input.ref1 as string | undefined, input.ref2 as string | undefined);
    return `${result.summary}\n\n${result.diff}`;
  } catch (err) {
    return `git diff failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const gitStatusDef: ToolDefinition = {
  name: 'git_status',
  description: 'Show the working tree status: staged, unstaged, and untracked files.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

async function gitStatus(): Promise<string> {
  try {
    return await new GitCLI().status();
  } catch (err) {
    return `git status failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const gitStageDef: ToolDefinition = {
  name: 'git_stage',
  description: 'Stage files for commit. Can stage specific files or all changes.',
  input_schema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files to stage (relative paths). If omitted, stages all modified and new files.',
      },
    },
    required: [],
  },
};

async function gitStage(input: Record<string, unknown>): Promise<string> {
  try {
    return await new GitCLI().stage(input.files as string[] | undefined);
  } catch (err) {
    return `git stage failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const gitCommitDef: ToolDefinition = {
  name: 'git_commit',
  description:
    'Create a git commit with the currently staged changes. Automatically appends a Co-Authored-By trailer for SideCar. Stage files first with git_stage.',
  input_schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Commit message. Follow conventional commits format (type: description).',
      },
    },
    required: ['message'],
  },
};

async function gitCommit(input: Record<string, unknown>): Promise<string> {
  try {
    return await new GitCLI().commit(input.message as string);
  } catch (err) {
    return `git commit failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const gitLogDef: ToolDefinition = {
  name: 'git_log',
  description: 'Show recent commit history.',
  input_schema: {
    type: 'object',
    properties: {
      count: { type: 'number', description: 'Number of commits to show. Default: 10.' },
    },
    required: [],
  },
};

async function gitLog(input: Record<string, unknown>): Promise<string> {
  try {
    const git = new GitCLI();
    const commits = await git.log((input.count as number) || 10);
    if (commits.length === 0) return 'No commits found.';
    return commits.map((c) => `${c.hash} ${c.message} (${c.author}, ${c.date})`).join('\n');
  } catch (err) {
    return `git log failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const gitPushDef: ToolDefinition = {
  name: 'git_push',
  description: 'Push commits to the remote repository. Optionally set upstream for new branches.',
  input_schema: {
    type: 'object',
    properties: {
      setUpstream: {
        type: 'boolean',
        description: 'If true, sets the upstream tracking branch (for new branches). Default: false.',
      },
    },
    required: [],
  },
};

async function gitPush(input: Record<string, unknown>): Promise<string> {
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

const gitPullDef: ToolDefinition = {
  name: 'git_pull',
  description: 'Pull changes from the remote repository.',
  input_schema: {
    type: 'object',
    properties: {
      rebase: { type: 'boolean', description: 'If true, pull with rebase instead of merge. Default: false.' },
    },
    required: [],
  },
};

async function gitPull(input: Record<string, unknown>): Promise<string> {
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

const gitBranchDef: ToolDefinition = {
  name: 'git_branch',
  description: 'List, create, or switch branches.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: "list" (default), "create", or "switch".',
      },
      name: { type: 'string', description: 'Branch name (required for create/switch).' },
    },
    required: [],
  },
};

async function gitBranch(input: Record<string, unknown>): Promise<string> {
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

const gitStashDef: ToolDefinition = {
  name: 'git_stash',
  description: 'Stash or restore working directory changes.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: "push" (default), "pop", "apply", "list", or "drop".',
      },
      message: { type: 'string', description: 'Optional message for push.' },
      index: { type: 'number', description: 'Stash index for pop/apply/drop (default: 0).' },
    },
    required: [],
  },
};

async function gitStash(input: Record<string, unknown>): Promise<string> {
  try {
    return await new GitCLI().stash((input.action as string) || 'push', {
      message: input.message as string | undefined,
      index: input.index as number | undefined,
    });
  } catch (err) {
    return `git stash failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// --- Registry ---

export const TOOL_REGISTRY: RegisteredTool[] = [
  { definition: readFileDef, executor: readFile, requiresApproval: false },
  { definition: writeFileDef, executor: writeFile, requiresApproval: true },
  { definition: editFileDef, executor: editFile, requiresApproval: true },
  { definition: searchFilesDef, executor: searchFiles, requiresApproval: false },
  { definition: grepDef, executor: grep, requiresApproval: false },
  { definition: runCommandDef, executor: runCommand, requiresApproval: true },
  { definition: listDirectoryDef, executor: listDirectory, requiresApproval: false },
  { definition: getDiagnosticsDef, executor: getDiagnostics, requiresApproval: false },
  { definition: runTestsDef, executor: runTests, requiresApproval: true },
  { definition: gitDiffDef, executor: gitDiffTool, requiresApproval: false },
  { definition: gitStatusDef, executor: gitStatus, requiresApproval: false },
  { definition: gitStageDef, executor: gitStage, requiresApproval: true },
  { definition: gitCommitDef, executor: gitCommit, requiresApproval: true },
  { definition: gitLogDef, executor: gitLog, requiresApproval: false },
  { definition: gitPushDef, executor: gitPush, requiresApproval: true },
  { definition: gitPullDef, executor: gitPull, requiresApproval: true },
  { definition: gitBranchDef, executor: gitBranch, requiresApproval: true },
  { definition: gitStashDef, executor: gitStash, requiresApproval: true },
];

export const SPAWN_AGENT_DEFINITION: ToolDefinition = {
  name: 'spawn_agent',
  description:
    'Spawn a sub-agent to handle a specific task in parallel. The sub-agent has access to all the same tools. Use this for complex tasks that can be broken into independent parts.',
  input_schema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Clear description of what the sub-agent should accomplish' },
      context: { type: 'string', description: 'Optional: additional context or file contents to provide' },
    },
    required: ['task'],
  },
};

function getCustomToolRegistry(): RegisteredTool[] {
  const configs = getConfig().customTools;
  return configs.map((cfg) => ({
    definition: {
      name: `custom_${cfg.name}`,
      description: `[Custom] ${cfg.description}`,
      input_schema: {
        type: 'object' as const,
        properties: { input: { type: 'string', description: 'Input to pass to the tool' } },
        required: ['input'],
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const cwd = getRoot();
      const userInput = (input.input as string) || '';
      const env = { ...process.env, SIDECAR_INPUT: userInput } as Record<string, string>;
      const { stdout, stderr } = await execAsync(cfg.command, { cwd, timeout: 30_000, env, maxBuffer: 1024 * 1024 });
      return (stdout + (stderr ? '\nSTDERR:\n' + stderr : '')).trim() || '(no output)';
    },
    requiresApproval: true,
  }));
}

export function getToolDefinitions(mcpManager?: MCPManager): ToolDefinition[] {
  const builtIn = [...TOOL_REGISTRY.map((t) => t.definition), SPAWN_AGENT_DEFINITION];
  const custom = getCustomToolRegistry().map((t) => t.definition);
  const mcp = mcpManager ? mcpManager.getToolDefinitions() : [];
  return [...builtIn, ...custom, ...mcp];
}

export function findTool(name: string, mcpManager?: MCPManager): RegisteredTool | undefined {
  const builtin = TOOL_REGISTRY.find((t) => t.definition.name === name);
  if (builtin) return builtin;
  const custom = getCustomToolRegistry().find((t) => t.definition.name === name);
  if (custom) return custom;
  return mcpManager?.getTool(name);
}
