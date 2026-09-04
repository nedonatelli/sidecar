import type { ToolResultContentBlock, ToolUseContentBlock } from '../../ollama/types.js';

/**
 * Collapse a `run_command` result that repeats one already in this run.
 *
 * The prompt pruner caps every tool result at
 * `promptPruning.maxToolResultTokens` (4,000 by default), but it never DEDUPES
 * shell output: `run_command` is marked `nondeterministicOutput`, which exempts
 * it. That exemption is right in general — a test command run after an edit must
 * show its new result — but it is keyed on the TOOL, not on whether anything
 * could actually have changed.
 *
 * Measured over 100 SWE-bench task-runs: 63 of them re-ran an identical command,
 * up to 6 times, and every one of those groups sat under cycle detection's
 * default threshold of 10 repeats, so nothing caught them. On django-16816 four
 * identical `runtests.py … admin_utils` invocations walked the context from
 * 15,799 to 48,195 tokens — re-reading output the model already had.
 *
 * So the condition is not "is this tool nondeterministic" but "could this
 * invocation produce something new". If the command is byte-identical, its
 * output is byte-identical, and no file has been written since it last ran, then
 * the model has already seen this and a second full copy buys nothing.
 *
 * The command still EXECUTES — only the duplicate text is replaced with a
 * pointer. That keeps side effects and exit codes intact, and means a command
 * whose output legitimately changed (a timestamp, a flaky test) is never
 * collapsed, because the hash differs.
 */
export interface CommandRunRecord {
  /** Value of the run's mutation counter when this command last ran. */
  mutations: number;
  /** Hash of the result text, so a changed output is never treated as a repeat. */
  hash: string;
  /** Iteration it last ran on, for the pointer message. */
  iteration: number;
}

/** Cheap, stable, non-cryptographic — this only has to detect "same bytes". */
function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${h >>> 0}:${s.length}`;
}

export interface CollapseOutcome {
  results: ToolResultContentBlock[];
  /** Commands collapsed this turn, for logging. */
  collapsed: string[];
}

export function collapseRepeatedCommandResults(
  results: readonly ToolResultContentBlock[],
  toolUses: readonly ToolUseContentBlock[],
  seen: Map<string, CommandRunRecord>,
  mutations: number,
  iteration: number,
): CollapseOutcome {
  const byId = new Map(toolUses.map((t) => [t.id, t]));
  const collapsed: string[] = [];

  const out = results.map((r) => {
    const use = byId.get(r.tool_use_id);
    if (!use || use.name !== 'run_command') return r;

    const command = String((use.input as { command?: unknown } | undefined)?.command ?? '');
    if (!command) return r;

    const text = typeof r.content === 'string' ? r.content : String(r.content ?? '');
    const hash = hashText(text);
    const prior = seen.get(command);

    // Same command, same bytes, and nothing written since it last ran.
    if (prior && prior.hash === hash && prior.mutations === mutations) {
      collapsed.push(command);
      return {
        ...r,
        content:
          `[identical to the same command run at iteration ${prior.iteration}; no file has been ` +
          `written since, so the output is unchanged and is not repeated here. ` +
          `Re-run it after making an edit if you need a fresh result.]`,
      };
    }

    seen.set(command, { mutations, hash, iteration });
    return r;
  });

  return { results: out, collapsed };
}
