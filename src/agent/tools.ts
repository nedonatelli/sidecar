import { workspace, languages, Uri } from 'vscode';
import * as path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import type { ToolDefinition } from '../ollama/types.js';
import type { MCPManager } from './mcpManager.js';
import { getConfig, detectProvider } from '../config/settings.js';
import { scanFile, formatIssues } from './securityScanner.js';
import { GitCLI } from '../github/git.js';
import { ShellSession } from '../terminal/shellSession.js';
import { searchWeb, formatSearchResults, checkInternetConnectivity } from './webSearch.js';
import type { SymbolGraph } from '../config/symbolGraph.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Tool runtime — cohesive container for tool-execution state that used to
// live as loose module-level singletons (persistent shell session + symbol
// graph index). One object means:
//   - single dispose point
//   - single injection seam (for sub-agents or tests)
//   - obvious ownership: extension owns one; tests can construct their own
//
// Each tool executor reads from `ctx.runtime ?? getDefaultToolRuntime()`, so
// extension activation populates the default instance while tests and
// future parallel agent contexts can still pass their own.
// ---------------------------------------------------------------------------
export class ToolRuntime {
  private shell: ShellSession | null = null;
  symbolGraph: SymbolGraph | null = null;

  /**
   * Lazily-constructed persistent shell session. State (cwd, env vars,
   * aliases) survives across tool calls — important so that `cd src/ && ls`
   * followed by `pwd` reports the new cwd.
   */
  getShellSession(): ShellSession {
    if (this.shell && this.shell.isAlive) return this.shell;
    const config = getConfig();
    const maxOutput = (config.shellMaxOutputMB || 10) * 1024 * 1024;
    this.shell = new ShellSession(getRoot(), undefined, maxOutput);
    return this.shell;
  }

  /** Tear down the persistent shell; safe to call repeatedly. */
  dispose(): void {
    this.shell?.dispose();
    this.shell = null;
  }
}

const defaultRuntime = new ToolRuntime();

/** Access the process-wide default ToolRuntime. Extension owns this one. */
export function getDefaultToolRuntime(): ToolRuntime {
  return defaultRuntime;
}

function getShellSession(): ShellSession {
  return defaultRuntime.getShellSession();
}

/** Call on extension deactivate to clean up the shell process. */
export function disposeShellSession(): void {
  defaultRuntime.dispose();
}

/** Optional context passed to tool executors for streaming and cancellation. */
export type ClarifyFn = (question: string, options: string[], allowCustom?: boolean) => Promise<string | undefined>;

export interface ToolExecutorContext {
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
  clarifyFn?: ClarifyFn;
  /** Per-tool permission overrides from the active custom mode. Merged with global toolPermissions (mode wins). */
  modeToolPermissions?: Record<string, 'allow' | 'deny' | 'ask'>;
}

export interface ToolExecutor {
  (input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string>;
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
  const folder = workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('No workspace folder open. Open a folder or workspace first.');
  }
  return folder.uri;
}

// --- Tool Definitions ---

const readFileDef: ToolDefinition = {
  name: 'read_file',
  description:
    'Read the full contents of a file at the given relative path. ' +
    'Use when you already know the filename and need to see its current contents before editing or analyzing it. ' +
    'Not for searching file contents — use `grep` for text matches, `search_files` for glob filename matches, or `list_directory` to explore a folder first. ' +
    'Binary files (images, PDFs, compiled artifacts) return unreadable output; prefer `list_directory` to confirm the file type first. ' +
    'Example: `read_file(path="src/utils.ts")`.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative file path from the project root' },
    },
    required: ['path'],
  },
};

const writeFileDef: ToolDefinition = {
  name: 'write_file',
  description:
    'Create a new file, or overwrite an existing file completely, with the given content. ' +
    'Use when creating a brand-new file or when replacing >50% of an existing file. ' +
    'Not for surgical changes to an existing file — use `edit_file` for small targeted edits, which is safer because it leaves the rest of the file untouched and reviewable. ' +
    '**Overwrites existing content silently** — call `read_file` first if there is any chance the file already exists and you need to preserve parts of it. ' +
    'Example: `write_file(path="src/hello.ts", content="export const hello = () => \'hi\';")`.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative file path from the project root' },
      content: { type: 'string', description: 'Full file content to write' },
    },
    required: ['path', 'content'],
  },
};

const editFileDef: ToolDefinition = {
  name: 'edit_file',
  description:
    'Edit an existing file by replacing an exact search string with a replacement. ' +
    'Use for surgical changes — renaming a function, updating a single line, adding an import. ' +
    'Not for creating a file or doing a full rewrite — use `write_file` for those. ' +
    'Not for multi-location changes in one call — call `edit_file` once per location, each with a unique search string. ' +
    'The `search` argument must match exactly one location in the file; include enough surrounding context to guarantee uniqueness, otherwise the tool returns an error listing the match count. ' +
    'Example: `edit_file(path="src/utils.ts", search="function greet(name: string)", replace="function greet(name: string, greeting = \'Hello\')")`.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative file path from the project root' },
      search: {
        type: 'string',
        description:
          'Exact text to find in the file. Must be unique — include enough surrounding context to match only one location. Only the first match is replaced; if the search text appears multiple times the call returns an error.',
      },
      replace: { type: 'string', description: 'Text to replace the search match with' },
    },
    required: ['path', 'search', 'replace'],
  },
};

const searchFilesDef: ToolDefinition = {
  name: 'search_files',
  description:
    'Search for files matching a glob pattern in the workspace. Returns a list of matching file paths. ' +
    'Examples: "**/*.ts" for all TypeScript files, "src/**/test*.js" for test files under src/, "**/package.json" for all package manifests.',
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
  description:
    'Search file contents for a text pattern (string or regex). Returns matching lines with file paths and line numbers. ' +
    'Examples: grep "TODO" to find all TODOs, grep "function handleSubmit" to locate a function, grep "import.*express" path="src/" to find express imports under src/.',
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
  description:
    'Execute a shell command in a persistent shell session. Environment variables, aliases, and working directory changes persist between calls. ' +
    'Examples: "npm test", "git status", "python main.py". ' +
    'For long-running processes, set background=true to get a command ID, then call again with just command_id to check output. ' +
    'The command and command_id parameters are mutually exclusive — provide one or the other, not both.',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to run. Mutually exclusive with command_id.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in seconds (default: 120). Use higher values for builds/installs.',
      },
      background: { type: 'boolean', description: 'If true, run in background and return an ID to check later.' },
      command_id: {
        type: 'string',
        description:
          'Check on a background command by its ID (returned from a previous background call). Mutually exclusive with command.',
      },
    },
    required: [],
  },
};

const listDirectoryDef: ToolDefinition = {
  name: 'list_directory',
  description:
    'List the files and folders in a directory, one entry per line with type markers. ' +
    'Use when orienting yourself in an unfamiliar project, or when you need to confirm a file exists before reading it. ' +
    'Not for finding files by pattern (use `search_files` for globs like `**/*.test.ts`) or for searching contents (use `grep`). ' +
    'Empty path or `.` lists the project root. ' +
    'Example: `list_directory(path="src/agent")`.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative directory path from the project root (empty or "." for project root)',
      },
    },
    required: [],
  },
};

// --- Path validation ---

/** Reject obviously invalid file paths that indicate the model hallucinated. */
function validateFilePath(filePath: string): string | null {
  if (!filePath || filePath.trim().length === 0) {
    return 'Error: file path is empty.';
  }
  // Reject paths with backticks, control chars, or that look like prose
  if (/[`\x00-\x1f]/.test(filePath)) {
    return `Error: invalid characters in file path: ${filePath.slice(0, 80)}`;
  }
  // Reject paths containing spaces that are clearly not file names
  // (e.g., "... ```) that contain diagram content")
  if (filePath.length > 80) {
    return `Error: file path too long (${filePath.length} chars): ${filePath.slice(0, 80)}...`;
  }
  // Reject paths that don't have at least one valid-looking segment
  const segments = filePath.split(/[\\/]/);
  for (const seg of segments) {
    if (seg.length > 60) {
      return `Error: path segment too long, likely not a real file name: ${seg.slice(0, 60)}...`;
    }
  }
  // Block path traversal outside workspace
  if (filePath.includes('..')) {
    return `Error: path traversal ("..") is not allowed: ${filePath}`;
  }
  if (path.isAbsolute(filePath)) {
    return `Error: absolute paths are not allowed. Use a path relative to the workspace root.`;
  }
  return null; // valid
}

// --- Sensitive file detection ---

const SENSITIVE_PATTERNS = [
  /^\.env($|\.)/i, // .env, .env.local, .env.production
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /credentials\.json$/i,
  /secrets?\.(json|ya?ml|toml)$/i,
  /\.secret$/i,
  /token\.json$/i,
  /service.account\.json$/i,
];

/**
 * Paths under these prefixes are SideCar's own internal state. Writes
 * to them are rejected so a prompt-injected agent can't erase the
 * audit log, poison persistent memories, or corrupt the cache. Reads
 * are still allowed — the agent can legitimately consult its own
 * memory or audit trail.
 *
 * Human-editable areas (SIDECAR.md, plans/, specs/, scratchpad/) are
 * intentionally NOT listed — those are normal working files.
 */
const PROTECTED_WRITE_PREFIXES = [
  '.sidecar/logs/', // repudiation: audit log must not be erasable
  '.sidecar/memory/', // poisoning: persistent memories must not be forgeable
  '.sidecar/sessions/', // tampering: session history must not be rewritable
  '.sidecar/cache/', // corruption: cache invariants would break
];

function isSensitiveFile(filePath: string): boolean {
  const basename = filePath.split(/[\\/]/).pop() || '';
  return SENSITIVE_PATTERNS.some((p) => p.test(basename));
}

/**
 * Check whether a write to the given path should be rejected because
 * it targets SideCar's protected internal state. Returns an error
 * message if blocked, or null if the write is allowed.
 *
 * Paths are normalised to use forward slashes so the same prefix
 * check works for Windows-style input.
 */
function isProtectedWritePath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized === '.sidecar/settings.json') {
    return `Refusing to write SideCar's own settings file (${filePath}). Ask the user to edit it directly.`;
  }
  for (const prefix of PROTECTED_WRITE_PREFIXES) {
    if (normalized.startsWith(prefix) || normalized.startsWith('./' + prefix)) {
      return (
        `Refusing to write under ${prefix} — this path is SideCar's internal state ` +
        `(audit log, persistent memory, session history, or cache) and must not be modified by the agent. ` +
        `If you need to reset this state, ask the user to do it directly.`
      );
    }
  }
  return null;
}

/**
 * POSIX-shell-safe single-quoting. Any `'` in the input is escaped as
 * `'\''` which ends the current quoted string, emits a literal quote,
 * and opens a new quoted string. Safe even for paths containing
 * metacharacters like `$`, `` ` ``, `;`, `&`, `|`, space, newline.
 *
 * Used by `run_tests` to safely interpolate a model-supplied `file`
 * argument into a shell command. Note: on Windows, cmd.exe doesn't
 * interpret single quotes the same way. ShellSession uses bash on
 * non-Windows and cmd.exe on Windows; for the Windows case we additionally
 * reject metacharacters below instead of relying on quoting.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Reject paths that contain shell metacharacters — belt-and-suspenders on top of `validateFilePath`. */
function hasShellMetachar(value: string): boolean {
  return /[\n\r;&|`$<>()!*?[\]{}"'\\]/.test(value);
}

// --- Tool Executors ---

async function readFile(input: Record<string, unknown>): Promise<string> {
  const filePath = input.path as string;
  const pathError = validateFilePath(filePath);
  if (pathError) return pathError;
  if (isSensitiveFile(filePath)) {
    return `Warning: "${filePath}" appears to contain secrets or credentials. Reading this file would send its contents to the LLM provider. Use read_file on a non-sensitive file instead, or ask the user to provide the needed information directly.`;
  }
  const fileUri = Uri.joinPath(getRootUri(), filePath);
  const bytes = await workspace.fs.readFile(fileUri);
  return Buffer.from(bytes).toString('utf-8');
}

async function writeFile(input: Record<string, unknown>): Promise<string> {
  const filePath = input.path as string;
  const pathError = validateFilePath(filePath);
  if (pathError) return pathError;
  const protectedError = isProtectedWritePath(filePath);
  if (protectedError) return protectedError;
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
  const pathError = validateFilePath(filePath);
  if (pathError) return pathError;
  const protectedError = isProtectedWritePath(filePath);
  if (protectedError) return protectedError;
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
    200,
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
    // Use execFile with args array to prevent shell injection
    const args = ['-rn', '--include=*', pattern, searchPath];
    const { stdout } = await execFileAsync('grep', args, {
      cwd,
      timeout: 15_000,
      maxBuffer: 512 * 1024,
    });
    // Limit output
    const lines = stdout.split('\n').slice(0, 200);
    return lines.join('\n') || 'No matches found.';
  } catch (err) {
    const error = err as { stdout?: string; code?: number };
    if (error.code === 1) return 'No matches found.';
    return error.stdout || 'Grep failed.';
  }
}

async function runCommand(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const command = input.command as string;

  // Check on a background command
  if (input.command_id) {
    const session = getShellSession();
    const status = session.checkBackground(input.command_id as string);
    if (!status) return `No background command found with ID: ${input.command_id}`;
    const header = status.done
      ? `Background command finished (exit code: ${status.exitCode})`
      : `Background command still running`;
    return `${header}\n\nOutput:\n${status.output || '(no output yet)'}`;
  }

  // Start a background command
  if (input.background) {
    const session = getShellSession();
    const id = session.executeBackground(command);
    return `Background command started with ID: ${id}\nUse run_command with command_id="${id}" to check on it.`;
  }

  // Normal execution through the persistent shell session
  const session = getShellSession();
  const config = getConfig();
  const timeoutSec = (input.timeout as number) || config.shellTimeout || 120;
  try {
    const result = await session.execute(command, {
      timeout: timeoutSec * 1000,
      onOutput: context?.onOutput,
      signal: context?.signal,
    });
    const status = result.exitCode !== 0 ? `\n(exit code: ${result.exitCode})` : '';
    return result.stdout.trim() + status || '(no output)';
  } catch (err) {
    const error = err as { message?: string };
    return `Command failed:\n${error.message || 'Unknown error'}`;
  }
}

async function listDirectory(input: Record<string, unknown>): Promise<string> {
  const dirPath = (input.path as string) || '.';
  // `.` is the workspace root itself — skip validation for the empty
  // path, otherwise run the same relative-path guard every other file
  // tool uses. Cycle-2 audit: this used to accept raw paths without
  // validateFilePath, so a crafted input like `../../..` or an
  // absolute path could at least attempt a readDirectory outside
  // the workspace boundary. VS Code's fs layer enforces workspace
  // trust independently, but belt-and-suspenders is the right shape.
  if (dirPath !== '.' && dirPath !== '') {
    const pathError = validateFilePath(dirPath);
    if (pathError) return pathError;
  }
  const dirUri = Uri.joinPath(getRootUri(), dirPath);
  const entries = await workspace.fs.readDirectory(dirUri);
  return entries.map(([name, type]) => `${type === 2 ? '📁 ' : '📄 '}${name}`).join('\n');
}

const getDiagnosticsDef: ToolDefinition = {
  name: 'get_diagnostics',
  description:
    "Fetch compiler errors, warnings, and lint issues from VS Code's language services for a file or the whole workspace. " +
    'Use after every `write_file` / `edit_file` to verify your change type-checks — per the operating rules, this is mandatory for any code edit. ' +
    "Also use before starting a task to understand what is already broken in the file, or before a final hand-off to confirm you've left the workspace clean. " +
    'Not for running tests (use `run_tests`) or for custom lint commands (use `run_command "npm run lint"` if the editor integration isn\'t picking them up). ' +
    'Omit `path` to get a project-wide summary. ' +
    'Example after an edit: `get_diagnostics(path="src/utils.ts")`.',
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
    'Run the project test suite with auto-detection of the test runner (npm test, pytest, cargo test, go test, gradle test). ' +
    'Use after fixing a bug or landing a new feature — per the operating rules, every bug fix finishes with `run_tests`. ' +
    'Not for arbitrary shell commands (use `run_command`) or for fetching type errors (use `get_diagnostics`). ' +
    'Prefer this over `run_command "npm test"` so the detection logic handles whichever runner the project uses. ' +
    "Pass `file` to narrow to a single test file when you've already isolated the failure. " +
    'Example: `run_tests(file="tests/auth.test.ts")`.',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'Optional: explicit test command to run (e.g. "npm test -- --coverage", "pytest -k myfunc"). Omit to auto-detect from project config files.',
      },
      file: {
        type: 'string',
        description:
          'Optional: relative path to a single test file to run (e.g. "tests/auth.test.ts"). Appended to the detected or provided command.',
      },
    },
    required: [],
  },
};

export async function getDiagnostics(input: Record<string, unknown>): Promise<string> {
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
    // Defend against shell injection via the `file` parameter. The model
    // can (intentionally or via prompt injection) submit
    // `file: "foo.test.ts; rm -rf ~"`, and an unquoted interpolation
    // would execute both. Validate as a relative path first, then
    // reject anything containing shell metacharacters, then single-quote
    // the final value for POSIX shells.
    const pathError = validateFilePath(file);
    if (pathError) return `Invalid file path for run_tests: ${pathError}`;
    if (hasShellMetachar(file)) {
      return `Invalid file path for run_tests: "${file}" contains shell metacharacters. Use a plain relative path.`;
    }
    command += ` ${shellQuote(file)}`;
  }

  // Use persistent shell session for test execution
  const session = getShellSession();
  const config = getConfig();
  const timeoutSec = config.shellTimeout || 120;
  try {
    const result = await session.execute(command, { timeout: timeoutSec * 1000 });
    const status = result.exitCode !== 0 ? `\n(exit code: ${result.exitCode})` : '';
    return result.stdout.trim() + status || '(no output)';
  } catch (err) {
    const error = err as { message?: string };
    return `Test command failed: ${error.message || 'Unknown error'}`;
  }
}

// --- Git Tools (backed by GitCLI) ---

const gitDiffDef: ToolDefinition = {
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

async function gitStatus(): Promise<string> {
  try {
    return await new GitCLI().status();
  } catch (err) {
    return `git status failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const gitStageDef: ToolDefinition = {
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

async function gitCommit(input: Record<string, unknown>): Promise<string> {
  try {
    return await new GitCLI().commit(input.message as string);
  } catch (err) {
    return `git commit failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const gitLogDef: ToolDefinition = {
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

const displayDiagramDef: ToolDefinition = {
  name: 'display_diagram',
  description:
    'Extract a diagram code block (mermaid, graphviz, plantuml, dot) from a markdown file and return it for rendering in chat. ' +
    'Use when the user asks "show me the diagram in docs/architecture.md" or when you want to reference an existing diagram while explaining code. ' +
    'Not for generating new diagrams — to draw something new, emit a ```mermaid code block directly in your chat response (SideCar renders it inline). ' +
    'Use `index` to select a specific diagram when a file contains more than one. ' +
    'Example: `display_diagram(path="docs/agent-loop-diagram.md", index=0)`.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative file path to the markdown file containing diagrams',
      },
      index: {
        type: 'number',
        description:
          'Zero-based index of the diagram block when the file contains multiple. Default: 0 (first diagram).',
      },
    },
    required: ['path'],
  },
};

async function displayDiagram(input: Record<string, unknown>): Promise<string> {
  const filePath = input.path as string;
  const diagramIndex = input.index as number;
  const effectiveIndex = diagramIndex ?? 0;

  const pathError = validateFilePath(filePath);
  if (pathError) return pathError;

  try {
    const fileUri = Uri.joinPath(getRootUri(), filePath);
    const bytes = await workspace.fs.readFile(fileUri);
    const content = Buffer.from(bytes).toString('utf-8');

    // Parse markdown to find diagram blocks
    // This regex looks for code blocks with diagram content (mermaid, graphviz, plantuml, etc)
    const diagramRegex = /```(mermaid|graphviz|plantuml|dot)\n([\s\S]*?)\n```/g;
    const diagrams: { type: string; content: string }[] = [];
    let match;

    while ((match = diagramRegex.exec(content)) !== null) {
      diagrams.push({ type: match[1], content: match[2] });
    }

    if (diagrams.length === 0) {
      return `No diagrams found in ${filePath}`;
    }

    if (effectiveIndex >= diagrams.length) {
      return `Diagram index ${effectiveIndex} out of range. Only ${diagrams.length} diagrams found.`;
    }

    const selectedDiagram = diagrams[effectiveIndex];
    return `Diagram ${effectiveIndex} from ${filePath}:\n\n\`\`\`${selectedDiagram.type}\n${selectedDiagram.content}\n\`\`\``;
  } catch (err) {
    return `Error reading diagram from ${filePath}: ${err instanceof Error ? err.message : 'Unknown error'}`;
  }
}

// --- Symbol graph integration ---
// The symbol graph lives on the default ToolRuntime (see top of file).
// Extension activation calls setSymbolGraph() to wire the real indexer
// in; tests pass a mock directly.

export function setSymbolGraph(graph: SymbolGraph | null): void {
  defaultRuntime.symbolGraph = graph;
}

const findReferencesDef: ToolDefinition = {
  name: 'find_references',
  description:
    'Find every reference to a symbol (function, class, type, variable) across the workspace using the tree-sitter symbol graph. ' +
    'Returns the definition location, files that import the defining module, and every usage site with file:line. ' +
    'Use before refactoring to understand blast radius, to find callers of a function, or to check whether a symbol is even used anywhere. ' +
    'Prefer this over `grep "functionName"` when you want semantic results — it won\'t match comments, strings, or unrelated identifiers with the same name, and it shows the export chain. ' +
    'Not for free-text search (use `grep`) or for finding files by name (use `search_files`). ' +
    'Example: `find_references(symbol="handleUserMessage")`, or `find_references(symbol="User", file="src/models/")` to scope to a subtree.',
  input_schema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Name of the symbol to find references for (function, class, type, variable)',
      },
      file: {
        type: 'string',
        description: 'Optional: restrict search to references involving this file or directory (as definer or user).',
      },
    },
    required: ['symbol'],
  },
};

async function findReferences(input: Record<string, unknown>): Promise<string> {
  const graph = defaultRuntime.symbolGraph;
  if (!graph) {
    return 'Symbol graph is not available. The workspace may still be indexing.';
  }

  const symbolName = (input.symbol as string) || '';
  const filterFile = input.file as string | undefined;

  if (!symbolName) return 'Error: symbol name is required.';

  // Look up definitions
  let definitions = graph.lookupSymbol(symbolName);
  if (filterFile) {
    definitions = definitions.filter((d) => d.filePath === filterFile || d.filePath.includes(filterFile));
  }

  if (definitions.length === 0) {
    return `No symbol named "${symbolName}" found in the index.`;
  }

  const parts: string[] = [];

  // Show definitions
  parts.push(`## Definitions of "${symbolName}"\n`);
  for (const def of definitions.slice(0, 10)) {
    parts.push(
      `- ${def.exported ? 'export ' : ''}${def.type} **${def.qualifiedName}** — ${def.filePath}:${def.startLine + 1}`,
    );
  }

  // Show dependents (files that import the defining file)
  const allDependents = new Set<string>();
  for (const def of definitions) {
    for (const dep of graph.getDependents(def.filePath)) {
      allDependents.add(dep);
    }
  }
  if (allDependents.size > 0) {
    parts.push(`\n## Files importing the defining module(s)\n`);
    const depList = [...allDependents].slice(0, 20);
    for (const dep of depList) {
      parts.push(`- ${dep}`);
    }
    if (allDependents.size > 20) {
      parts.push(`- ... and ${allDependents.size - 20} more`);
    }
  }

  // Find actual usage sites
  const references = graph.findReferences(symbolName);
  const filtered = filterFile
    ? references.filter((r) => r.file === filterFile || r.file.includes(filterFile))
    : references;

  if (filtered.length > 0) {
    parts.push(`\n## Usage sites (${filtered.length} references)\n`);
    for (const ref of filtered.slice(0, 30)) {
      parts.push(`- ${ref.file}:${ref.line} — \`${ref.context}\``);
    }
    if (filtered.length > 30) {
      parts.push(`- ... and ${filtered.length - 30} more`);
    }
  }

  // Truncate to 5000 chars
  let result = parts.join('\n');
  if (result.length > 5000) {
    result = result.slice(0, 4950) + '\n... (truncated)';
  }

  return result;
}

// --- Web search ---

const webSearchDef: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the web via DuckDuckGo and return titles, URLs, and snippets. ' +
    'Use to find current documentation, solutions to error messages, library API references, or any information not in the local codebase. ' +
    'Not for looking things up inside the workspace (use `grep` / `search_files` / `read_file`). ' +
    'Not for exfiltrating secrets: queries that contain credential-shaped substrings (API keys, JWTs, private-key headers) are blocked with an error, because the query becomes part of the URL logged by the search engine. ' +
    'Example: `web_search(query="typescript satisfies operator vs type assertion")`, `web_search(query="node.js AggregateError example")`.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Search query. Keep it specific — a few technical terms works better than a full sentence. Example: "react useEffect cleanup function", "python asyncio timeout".',
      },
    },
    required: ['query'],
  },
};

let internetChecked = false;
let internetAvailable = true;

async function webSearch(input: Record<string, unknown>): Promise<string> {
  const query = (input.query as string) || '';
  if (!query) return 'Error: search query is required.';

  // Check internet connectivity once per session
  if (!internetChecked) {
    internetChecked = true;
    internetAvailable = await checkInternetConnectivity();
    if (!internetAvailable) {
      return '⚠️ No internet connection detected. Web search is unavailable. Try resolving the issue using local files, documentation, or project context instead.';
    }
  } else if (!internetAvailable) {
    // Retry connectivity on subsequent calls in case connection was restored
    internetAvailable = await checkInternetConnectivity();
    if (!internetAvailable) {
      return '⚠️ Still offline. Web search is unavailable.';
    }
  }

  try {
    const results = await searchWeb(query);
    if (results.length === 0) {
      return `No results found for: "${query}". Try rephrasing the query.`;
    }
    return `Web search results for "${query}":\n\n${formatSearchResults(results)}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
      return '⚠️ Search timed out. The internet connection may be slow or unavailable.';
    }
    return `Search failed: ${msg}`;
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
  { definition: displayDiagramDef, executor: displayDiagram, requiresApproval: false },
  { definition: findReferencesDef, executor: findReferences, requiresApproval: false },
  { definition: webSearchDef, executor: webSearch, requiresApproval: false },
  {
    definition: {
      name: 'ask_user',
      description:
        'Ask the user a clarifying question with suggested options they can pick from. ' +
        'Use when a request is genuinely ambiguous and the alternatives have meaningfully different outcomes. ' +
        "Not for clearly-stated requests — per the operating rules, proceed directly on those and don't ask permission for every small action. " +
        'Not for decisions the agent can make safely from context (file naming, test framework choice when one is already in use, code style matching the surrounding file). ' +
        'Example: `ask_user(question="Which auth flow should the callback use?", options=["OAuth code exchange", "Implicit (deprecated)", "Password grant"], allow_custom=true)`.',
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask the user' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Suggested options for the user to choose from (2-5 options)',
          },
          allow_custom: {
            type: 'boolean',
            description: 'Whether the user can type a custom response instead of picking an option. Default: true',
          },
        },
        required: ['question', 'options'],
      },
    },
    // Executor is a placeholder — ask_user is handled specially in executor.ts
    executor: async () => 'ask_user should be handled by the executor, not called directly',
    requiresApproval: false,
  },
];

/**
 * `delegate_task` — offload read-only research to a local Ollama worker.
 * Only exposed to the model when the active backend is paid (Anthropic,
 * OpenAI). On local-first setups it's a no-op and intentionally hidden
 * so the orchestrator doesn't waste tokens describing it.
 *
 * The worker runs on a separate SideCarClient instance pointed at
 * localhost:11434, with a read-only tool subset. Its token usage does
 * not touch the frontier model's bill.
 */
export const DELEGATE_TASK_DEFINITION: ToolDefinition = {
  name: 'delegate_task',
  description:
    'Offload a focused, read-only research task to a local Ollama worker model, saving tokens on this paid backend. ' +
    'The worker can read files, grep, search, list directories, inspect diagnostics, find references, and query git — but CANNOT write, edit, run commands, or make changes. It returns a structured summary. ' +
    'IDEAL use cases: "Find all callers of the deprecated authenticate() function", "Read the three files in src/agent/ and summarize how tool execution flows", "Grep for any TODO comments related to caching and list them with file:line". ' +
    'BAD use cases: tasks requiring code changes, tasks needing user interaction, tasks where you need the exact raw bytes of a file (the worker summarizes), tasks that are trivially small (< 500 tokens of tool output). ' +
    'Use this liberally for codebase exploration on large repos — every delegated file read is a token you do not pay for.',
  input_schema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description:
          'Clear, self-contained description of what the worker should investigate. Include file paths or symbol names when you have them.',
      },
      context: {
        type: 'string',
        description:
          'Optional: additional context from prior turns the worker needs to understand the task (e.g. constraints, what has been tried).',
      },
    },
    required: ['task'],
  },
};

export const SPAWN_AGENT_DEFINITION: ToolDefinition = {
  name: 'spawn_agent',
  description:
    'Spawn a sub-agent to handle a specific, self-contained task in parallel. The sub-agent has access to all tools but runs with a reduced iteration limit (max 15). ' +
    'Good use cases: "Write unit tests for src/utils/parser.ts", "Refactor the authentication middleware to use async/await", "Search the codebase for all usages of the deprecated API and list them". ' +
    'Bad use cases: tasks requiring back-and-forth with the user, tasks that depend on the result of another sub-agent. ' +
    'Sub-agents cannot spawn further sub-agents beyond 3 levels deep.',
  input_schema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description:
          'Clear, self-contained description of what the sub-agent should accomplish. Include file paths and specific requirements.',
      },
      context: {
        type: 'string',
        description: 'Optional: additional context, file contents, or constraints the sub-agent needs to know.',
      },
    },
    required: ['task'],
  },
};

let _customToolCache: RegisteredTool[] | null = null;
let _customToolConfigSnapshot: string | null = null;

function getCustomToolRegistry(): RegisteredTool[] {
  const configs = getConfig().customTools;
  const snapshot = JSON.stringify(configs);
  if (_customToolCache && _customToolConfigSnapshot === snapshot) {
    return _customToolCache;
  }
  _customToolCache = configs.map((cfg) => ({
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
  _customToolConfigSnapshot = snapshot;
  return _customToolCache;
}

export function getToolDefinitions(mcpManager?: MCPManager): ToolDefinition[] {
  const cfg = getConfig();
  const builtIn: ToolDefinition[] = [...TOOL_REGISTRY.map((t) => t.definition), SPAWN_AGENT_DEFINITION];

  // Only advertise delegate_task when we're paying per token AND the
  // user hasn't opted out. Pointless on local-only setups — both
  // orchestrator and worker would run the same Ollama backend.
  const provider = detectProvider(cfg.baseUrl, cfg.provider);
  if (cfg.delegateTaskEnabled && (provider === 'anthropic' || provider === 'openai')) {
    builtIn.push(DELEGATE_TASK_DEFINITION);
  }

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
