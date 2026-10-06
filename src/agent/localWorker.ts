import type { ChatMessage, ToolDefinition } from '../ollama/types.js';
import { SideCarClient } from '../ollama/client.js';
import { getConfig } from '../config/settings.js';
import { runAgentLoop, type AgentCallbacks, type AgentOptions } from './loop.js';
import { getToolDefinitions } from './tools.js';

/**
 * Tools the local worker is allowed to call. Read-only by design:
 * the orchestrator delegates research and exploration to the local
 * model, but retains authority over any destructive operation. This
 * prevents a weak local model's bad judgment from silently corrupting
 * the repo via a summary the orchestrator then trusts.
 */
const WORKER_ALLOWED_TOOLS = new Set([
  'read_file',
  'search_files',
  'grep',
  'list_directory',
  'get_diagnostics',
  'find_references',
  'git_diff',
  'git_status',
  'git_log',
  // git_branch deliberately excluded: its create/switch actions mutate the
  // repo, and the delegate is promised to the orchestrator as read-only.
  'display_diagram',
  'run_command', // Safe commands only — filtered by isWorkerSafeCommand()
]);

/**
 * What the worker may run. The worker runs AUTONOMOUSLY -- no approval prompt
 * in any mode -- so this is an allowlist of whole command shapes, not of
 * prefixes. A prefix list cannot hold: `ls ; <anything>` starts with `ls `,
 * `env <cmd>` with `env`, and `find -exec`, `rg --pre`, `awk 'system()'`
 * run programs from inside an "inspection" command.
 *
 * Each pipeline stage must be one of these commands. The value is a pattern
 * over the stage's arguments that must NOT match: the flags that make an
 * otherwise read-only command write a file or execute something.
 *
 * Deliberately absent: awk/sed (both execute or write), curl/wget (a GET can
 * carry `$SECRET` in its URL), env/printenv (dump secrets to the model),
 * xxd (writes with two operands), ldd (may execute the binary it inspects).
 */
const WORKER_COMMANDS: Record<string, RegExp | null> = {
  cat: null,
  head: null,
  tail: null,
  less: null,
  more: null,
  wc: null,
  grep: null,
  egrep: null,
  fgrep: null,
  rg: /(^|\s)--pre(-glob)?(=|\s|$)/,
  ag: null,
  find: /(^|\s)-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)(\s|$)/,
  fd: /(^|\s)(-x|-X|--exec|--exec-batch)(=|\s|$)/,
  ls: null,
  tree: /(^|\s)-o(\s|$)/,
  file: null,
  stat: null,
  which: null,
  type: null,
  whereis: null,
  du: null,
  df: null,
  echo: null,
  printf: null,
  uname: null,
  ps: null,
  pgrep: null,
  lsof: null,
  netstat: null,
  ss: null,
  jq: null,
  yq: /(^|\s)(-i|--inplace)(=|\s|$)/,
  sort: /(^|\s)(-o|--output)(=|\s|$)/,
  // `uniq IN OUT` writes OUT; as a pipeline stage it takes no operands.
  uniq: /(^|\s)[^-\s]/,
  cut: null,
  tr: null,
  diff: null,
  comm: null,
  md5sum: null,
  sha256sum: null,
  sha1sum: null,
  base64: null,
  hexdump: null,
  od: null,
  strings: null,
  nm: null,
  objdump: null,
  readelf: null,
  otool: null,
};

/** Commands allowed only bare -- an argument would turn them into launchers or setters. */
const WORKER_BARE_COMMANDS = new Set(['pwd', 'whoami', 'id', 'hostname', 'date', 'uptime']);

/** Multi-word read-only invocations, with the arguments that would make them mutate. */
const WORKER_SUBCOMMANDS: Array<[string, RegExp | null]> = [
  ['cargo metadata', null],
  ['cargo tree', null],
  ['npm ls', null],
  ['npm list', null],
  ['npm view', null],
  ['npm info', null],
  ['npm outdated', null],
  ['npm audit', /(^|\s)fix(\s|$)/],
  ['npx tsc --noEmit', /(^|\s)(-b|--build|-w|--watch)(\s|$)/],
  ['pip list', null],
  ['pip show', null],
  ['pip freeze', null],
  ['go list', null],
  ['go mod graph', null],
  ['gh pr view', null],
  ['gh issue view', null],
  ['gh repo view', null],
];

/** git: read-only subcommands only, and never the flags that write or launch. */
const WORKER_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'ls-files',
  'rev-parse',
  'grep',
  'shortlog',
  'describe',
]);
const WORKER_GIT_FORBIDDEN = /(^|\s)(--output|-O|--open-files-in-pager|--ext-diff)(=|\s|$)|(^|\s)-O\S/;
/** `git branch` lists, but any operand or mutating flag creates/deletes/renames. */
const WORKER_GIT_BRANCH_FLAGS = new Set(['-a', '-r', '-v', '-vv', '--all', '--remotes', '--list', '--show-current']);

function isSafeStage(stage: string): boolean {
  // Judge the words the shell will see: quotes and escapes removed, so
  // `--p''re` or `"-exec"` cannot hide a forbidden flag.
  const words = stage.replace(/["'\\]/g, '').trim();
  if (!words) return false;
  const [cmd, ...rest] = words.split(/\s+/);
  const args = rest.join(' ');

  if (WORKER_BARE_COMMANDS.has(cmd)) return rest.length === 0;

  if (cmd === 'git') {
    const [sub, ...gitRest] = rest;
    if (sub === 'branch') return gitRest.every((a) => WORKER_GIT_BRANCH_FLAGS.has(a));
    if (!sub || !WORKER_GIT_SUBCOMMANDS.has(sub)) return false;
    return !WORKER_GIT_FORBIDDEN.test(' ' + gitRest.join(' '));
  }

  for (const [prefix, forbidden] of WORKER_SUBCOMMANDS) {
    if (words === prefix || words.startsWith(prefix + ' ')) {
      return !forbidden || !forbidden.test(words.slice(prefix.length));
    }
  }

  if (!Object.prototype.hasOwnProperty.call(WORKER_COMMANDS, cmd)) return false;
  const forbidden = WORKER_COMMANDS[cmd];
  return !forbidden || !forbidden.test(args);
}

/**
 * Check if a command is safe for the worker to execute (read-only).
 * Rejects anything that could modify files, run arbitrary code, or
 * exfiltrate data in non-obvious ways.
 */
export function isWorkerSafeCommand(command: string): boolean {
  // `2>&1` is the one redirection a read-only command needs; drop it before
  // the structural checks so it is not mistaken for a write.
  const trimmed = command.trim().replace(/(^|\s)2>&1(?=\s|$)/g, ' ');

  // No chaining (`;`, `&`, `&&`, `||`), no substitution (`$(`, backticks),
  // no variable expansion (`$VAR`, `${VAR}` -- `echo $API_KEY` hands a secret
  // to the model), no redirection, no second line. Each of these runs, writes
  // or reveals something no stage check below would see. A regex anchor such
  // as `grep 'foo$'` is unaffected.
  if (/[;&`<>\n\r]|\$[A-Za-z_{(]/.test(trimmed)) return false;

  const stages = trimmed.split('|');
  return stages.every((stage) => isSafeStage(stage));
}

const WORKER_SYSTEM_PROMPT = `You are a local research worker spawned by a frontier-model orchestrator. Your job is to investigate a focused task using the read-only tools available and return a compact, structured summary.

## Rules

- Do the task efficiently. No chit-chat, no clarifying questions.
- You have read-only tools: read_file, grep, search_files, list_directory, get_diagnostics, find_references, git_diff, git_status, git_log, display_diagram.
- You can run SAFE read-only shell commands via run_command: cat, head, tail, grep, rg, find, ls, tree, wc, file, stat, jq, sort, read-only git (status, log, diff, show, blame), etc. One command per call; pipes between these are fine, but no ; or &&, no redirection, no $VARS.
- Destructive commands (rm, mv, cp, chmod, >, >>) are blocked — don't try them.
- You CANNOT write files or edit code, and only the safe read-only commands above are allowed. If the task asks for changes, describe what *should* change — do not attempt it.
- Your final reply is the ONLY thing the orchestrator will see. Make it count.

## Output format

End with a single structured summary block. Use this shape:

\`\`\`
SUMMARY
=======
Task: <one-line restatement>
Findings:
  - <concrete fact with file:line reference>
  - <...>
Relevant files:
  - path/to/file.ts:L12-L40 — <one-line purpose>
  - <...>
Recommendations (if applicable):
  - <what the orchestrator should do next>
\`\`\`

Be factual. Quote file paths and line numbers. Never speculate without a citation.`;

export interface LocalWorkerResult {
  /** The structured summary returned to the orchestrator as a tool_result. */
  output: string;
  /** Did the worker complete without error? */
  success: boolean;
  /** Chars the worker consumed on its own backend — NOT charged to the paid budget. */
  charsConsumed: number;
  /** Worker model actually used (for telemetry / UI). */
  model: string;
}

/**
 * Filter the full tool catalog down to the read-only subset the worker
 * is allowed to see. We pass this via `AgentOptions.toolOverride` so
 * the worker never even knows delegate_task / write_file exist —
 * no wasted tokens attempting denied calls, no recursion risk.
 */
function filterToolsForWorker(allTools: ToolDefinition[]): ToolDefinition[] {
  return allTools.filter((t) => WORKER_ALLOWED_TOOLS.has(t.name));
}

/**
 * Spawn a local-model worker to complete a focused task and return
 * its summary. The worker runs on its own SideCarClient pointed at
 * Ollama (separate from the orchestrator's paid backend), so none of
 * its token consumption shows up on the Anthropic/OpenAI bill.
 */
export async function runLocalWorker(
  task: string,
  context: string | undefined,
  parentCallbacks: AgentCallbacks,
  signal: AbortSignal,
  options: AgentOptions = {},
): Promise<LocalWorkerResult> {
  const cfg = options.config ?? getConfig();
  const workerModel = cfg.delegateTaskWorkerModel || cfg.model;
  const workerBaseUrl = cfg.delegateTaskWorkerBaseUrl || 'http://localhost:11434';

  // Fresh client, isolated from the orchestrator's state. No shared
  // rate-limit store, no backend reuse, nothing to corrupt.
  const workerClient = new SideCarClient(workerModel, workerBaseUrl, 'ollama');
  workerClient.updateSystemPrompt(WORKER_SYSTEM_PROMPT);

  const prompt = context ? `Context from orchestrator:\n${context}\n\nTask: ${task}` : `Task: ${task}`;
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

  parentCallbacks.onText(`\n[delegate_task → local worker (${workerModel}): ${task}]\n`);
  options.logger?.info(`Local worker spawned: model=${workerModel} task="${task.slice(0, 80)}"`);

  let output = '';
  let charsConsumed = 0;
  const workerCallbacks: AgentCallbacks = {
    onText: (text) => {
      output += text;
    },
    onCharsConsumed: (chars) => {
      charsConsumed += chars;
    },
    onThinking: (thinking) => {
      options.logger?.debug(`[worker] thinking: ${thinking.slice(0, 100)}`);
    },
    onToolCall: (name, input, toolId) => {
      options.logger?.logToolCall(`worker:${name}`, input);
      parentCallbacks.onToolCall(`worker:${name}`, input, toolId);
    },
    onToolResult: (name, result, isError, toolId) => {
      options.logger?.logToolResult(`worker:${name}`, result, isError);
      parentCallbacks.onToolResult(`worker:${name}`, result, isError, toolId);
    },
    onDone: () => {
      options.logger?.info('Local worker completed');
    },
  };

  const workerTools = filterToolsForWorker(getToolDefinitions(options.mcpManager));

  // Worker cap: the config value is the ceiling (clampMin guarantees a
  // valid number). If the caller passed their own maxIterations, honor
  // it only when it's *lower* than the configured cap — the cap is a
  // guardrail against runaway loops, not a floor.
  const workerCap = cfg.delegateTaskMaxIterations;
  const workerMaxIterations =
    options.maxIterations !== undefined ? Math.min(options.maxIterations, workerCap) : workerCap;

  try {
    await runAgentLoop(workerClient, messages, workerCallbacks, signal, {
      ...options,
      approvalMode: 'autonomous',
      maxIterations: workerMaxIterations,
      depth: (options.depth || 0) + 1,
      toolOverride: workerTools,
      modeToolPermissions: Object.fromEntries(Array.from(WORKER_ALLOWED_TOOLS).map((n) => [n, 'allow' as const])),
      commandFilter: isWorkerSafeCommand,
    });
    parentCallbacks.onText(`\n[delegate_task completed]\n`);
    return { output: output.trim() || '(worker produced no output)', success: true, charsConsumed, model: workerModel };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    options.logger?.error(`Local worker failed: ${errorMsg}`);
    parentCallbacks.onText(`\n[delegate_task failed: ${errorMsg}]\n`);
    return { output: errorMsg, success: false, charsConsumed, model: workerModel };
  }
}
