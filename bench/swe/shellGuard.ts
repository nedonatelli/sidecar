import { execFileSync } from 'node:child_process';
import type { RegisteredTool, ToolExecutorContext } from '../../src/agent/tools/shared.js';

/** The tools that run commands in the agent's persistent shell. */
export const SHELL_GUARD_TOOLS: readonly string[] = ['run_command', 'run_tests'];

/** The slice of ShellSession the guard needs. */
export interface GuardShell {
  execute(
    command: string,
    options?: { timeout?: number },
  ): Promise<{ stdout: string; exitCode: number; timedOut?: boolean }>;
}

/** The clone root as a POSIX shell spells it after `cd` (e.g. Git Bash's /c/...), or null. */
export type RootResolver = (root: string) => string | null;

const PROBE_TIMEOUT_MS = 30_000;

function singleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Ask a SEPARATE bash, not the agent's shell, how it spells the clone root.
 * Anything run inside the agent's session is visible to the agent: bash numbers
 * its error messages by the session's input line, so one extra command turned
 * `bash: line 1: rg: command not found` into `line 4` and sent three canary runs
 * down different paths.
 */
export const resolveRootWithBash: RootResolver = (root) => {
  try {
    const out = execFileSync('bash', ['-c', 'cd -- "$1" && pwd -P', '_', root.replace(/\\/g, '/')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROBE_TIMEOUT_MS,
    }).trim();
    return out.startsWith('/') ? out : null;
  } catch {
    return null;
  }
};

// Builtins that change the shell's OWN working directory. A program the shell
// runs cannot change it -- only these, run in the session itself. A `cd` inside
// a subshell counts too: harmless (the probe finds nothing) and simpler than
// parsing shell grammar.
const DIRECTORY_CHANGERS = /(^|[\s;&|({`])(cd|pushd|popd|source|exec|eval)(?=$|[\s;&|)])|(^|[;&|({]\s*)\.\s/;

/** Could this command leave the session in a different directory? False positives only cost a probe. */
export function mayChangeDirectory(command: string): boolean {
  return DIRECTORY_CHANGERS.test(command);
}

/** The note appended to a result whose command left the clone. */
export function returnedNote(left: string): string {
  return (
    `\n\n[harness] This command left the shell in ${left}, outside the repository. ` +
    `The shell has been moved back to the repository root; later commands run from there.`
  );
}

/**
 * Keeps the agent's shell inside the task clone (#196).
 *
 * The product's shell session keeps its working directory between commands on
 * purpose (shellSession.ts: cwd is "legitimate persistence"), and the harness
 * added nothing on top. So one `cd /tmp` sent every later command to /tmp, and
 * a `cd / && find .` scanned the host's whole disk -- 297 s of a 351 s run.
 *
 * After a command that could change directory, this asks the shell where it is.
 * Inside the clone -- the root or any subdirectory -- nothing happens, so a
 * `cd src` persists exactly as in the product. Outside it, the shell is moved
 * back to the root and the result says so. Every other command passes through
 * untouched: the guard sends nothing to the session, so a run that never
 * changes directory is byte-identical to an unguarded one.
 *
 * It contains a session, not a command: `cd / && find .` still runs to
 * completion inside that one command. Isolating the host is a separate
 * decision (#196).
 */
export class ShellRootGuard {
  private rootPwd: string | null | undefined;

  constructor(
    private readonly root: string,
    private readonly resolveRoot: RootResolver = resolveRootWithBash,
  ) {}

  private getRoot(): string | null {
    if (this.rootPwd === undefined) this.rootPwd = this.resolveRoot(this.root);
    return this.rootPwd;
  }

  /** After `command` ran: the note to append, or '' when the shell is still inside the clone. */
  async afterCommand(shell: GuardShell, command: string): Promise<string> {
    if (!mayChangeDirectory(command)) return '';
    const root = this.getRoot();
    if (!root) return '';
    const r = await shell.execute('pwd -P', { timeout: PROBE_TIMEOUT_MS });
    const here = r.stdout.trim();
    if (r.timedOut || r.exitCode !== 0 || !here) return '';
    if (here === root || here.startsWith(root.endsWith('/') ? root : `${root}/`)) return '';
    await shell.execute(`cd -- ${singleQuote(root)}`, { timeout: PROBE_TIMEOUT_MS });
    return returnedNote(here);
  }
}

/**
 * `tools` with run_command / run_tests wrapped by `guard`. Takes the tools
 * already chosen for extraTools (e.g. the stable-output copies) and falls back
 * to the registry for any guarded tool not among them.
 */
export function shellGuardTools(
  tools: readonly RegisteredTool[],
  find: (name: string) => RegisteredTool | undefined,
  guard: ShellRootGuard,
  getShell: (context?: ToolExecutorContext) => GuardShell | undefined = (context) =>
    context?.toolRuntime?.getShellSession(context?.config),
): RegisteredTool[] {
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  for (const name of SHELL_GUARD_TOOLS) {
    const tool = byName.get(name) ?? find(name);
    if (!tool) continue;
    byName.set(name, {
      ...tool,
      executor: async (input, context) => {
        const output = await tool.executor(input, context);
        const command = typeof input.command === 'string' ? input.command : '';
        const shell = command ? getShell(context) : undefined;
        return shell ? output + (await guard.afterCommand(shell, command)) : output;
      },
    });
  }
  return [...byName.values()];
}
