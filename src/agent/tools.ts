import { exec } from 'child_process';
import { promisify } from 'util';
import type { ToolDefinition } from '../ollama/types.js';
import type { MCPManager } from './mcpManager.js';
import { getConfig, detectProvider } from '../config/settings.js';

import type { RegisteredTool } from './tools/shared.js';
import { getRoot } from './tools/shared.js';
import {
  readFileDef,
  readFile,
  writeFileDef,
  writeFile,
  editFileDef,
  editFile,
  listDirectoryDef,
  listDirectory,
} from './tools/fs.js';
import { searchFilesDef, searchFiles, grepDef, grep, findReferencesDef, findReferences } from './tools/search.js';
import { runCommandDef, runCommand, runTestsDef, runTests } from './tools/shell.js';
import { getDiagnosticsDef, getDiagnostics } from './tools/diagnostics.js';
import {
  gitDiffDef,
  gitDiffTool,
  gitStatusDef,
  gitStatus,
  gitStageDef,
  gitStage,
  gitCommitDef,
  gitCommit,
  gitLogDef,
  gitLog,
  gitPushDef,
  gitPush,
  gitPullDef,
  gitPull,
  gitBranchDef,
  gitBranch,
  gitStashDef,
  gitStash,
} from './tools/git.js';
import { webSearchDef, webSearch, displayDiagramDef, displayDiagram } from './tools/knowledge.js';
import {
  switchBackendDef,
  switchBackend,
  getSettingDef,
  getSetting,
  updateSettingDef,
  updateSetting,
} from './tools/settings.js';

// ---------------------------------------------------------------------------
// tools.ts is the slim composition layer. Each tool category lives under
// ./tools/ (fs, search, shell, diagnostics, git, knowledge) and is wired
// into the registry here. Backward-compatible re-exports keep every
// pre-split import site (extension.ts, executor.ts, loop.ts, localWorker.ts,
// mcpManager.ts, the test suites) working without edits.
//
// If you're adding a new tool, prefer extending the relevant category file
// rather than growing this orchestrator. If the new tool doesn't fit any
// category, add a new file under ./tools/ and import it here.
// ---------------------------------------------------------------------------

// Re-export types + value-level entrypoints that pre-split callers imported
// straight from './tools.js'. Keeping these preserves the public surface.
export type { ClarifyFn, ToolExecutorContext, ToolExecutor, RegisteredTool } from './tools/shared.js';
export { ToolRuntime, getDefaultToolRuntime, disposeShellSession, setSymbolGraph } from './tools/runtime.js';
export { getDiagnostics } from './tools/diagnostics.js';

const execAsync = promisify(exec);

// --- Built-in tool registry ---

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
  // Settings tools. `alwaysRequireApproval: true` on the two mutating
  // tools ensures the user sees a modal even in autonomous mode and
  // even when `toolPermissions` sets them to `allow` — the user's
  // durable configuration never changes without an explicit click.
  { definition: getSettingDef, executor: getSetting, requiresApproval: false },
  {
    definition: switchBackendDef,
    executor: switchBackend,
    requiresApproval: true,
    alwaysRequireApproval: true,
  },
  {
    definition: updateSettingDef,
    executor: updateSetting,
    requiresApproval: true,
    alwaysRequireApproval: true,
  },
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

// --- Custom user tools (from settings.json) ---

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
