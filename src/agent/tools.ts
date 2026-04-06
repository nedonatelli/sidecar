import { workspace, languages, Uri } from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { ToolDefinition } from '../ollama/types.js';
import type { MCPManager } from './mcpManager.js';
import { getConfig } from '../config/settings.js';
import { scanFile, formatIssues } from './securityScanner.js';

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

const getGitDiffDef: ToolDefinition = {
  name: 'get_git_diff',
  description:
    'Get the git diff for the current workspace. Shows staged and unstaged changes. Optionally compare against a specific ref.',
  input_schema: {
    type: 'object',
    properties: {
      ref: {
        type: 'string',
        description: 'Optional: git ref to diff against (e.g. "HEAD~3", "main"). Defaults to HEAD.',
      },
    },
    required: [],
  },
};

async function getGitDiff(input: Record<string, unknown>): Promise<string> {
  const ref = (input.ref as string) || 'HEAD';
  const cwd = getRoot();
  try {
    const { stdout } = await execAsync(`git diff ${ref}`, { cwd, maxBuffer: 2 * 1024 * 1024 });
    if (!stdout.trim()) {
      const staged = await execAsync('git diff --cached', { cwd, maxBuffer: 2 * 1024 * 1024 });
      return staged.stdout.trim() || 'No changes found.';
    }
    return stdout;
  } catch (err) {
    return `Git diff failed: ${err instanceof Error ? err.message : String(err)}`;
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
  { definition: getGitDiffDef, executor: getGitDiff, requiresApproval: false },
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
