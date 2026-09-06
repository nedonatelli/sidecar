// The syntax completion-gate component. This is the GATE (decides to inject a
// reprompt when edited code fails to parse); the low-level parse primitives it
// calls — runSyntaxGate / buildSyntaxReprompt / hasCheckableFiles — live in
// ../syntaxGate.ts. Kept in its own module (not gate.ts) so the registry and the
// loop's cycle-bail rescue can both import it without a cycle through gate.ts.
import * as path from 'path';
import { runSyntaxGate, buildSyntaxReprompt, hasCheckableFiles } from '../syntaxGate.js';
import { getRoot } from '../../tools/shared.js';
import { runVerificationCommand } from '../../tools/shell.js';
import type { getConfig } from '../../../config/settings.js';
import type { AgentCallbacks } from '../../loop.js';
import type { LoopState } from '../state.js';
import type { CompletionGate } from './types.js';

const MAX_SYNTAX_GATE_INJECTIONS = 2;

/**
 * Deterministic syntax gate: every edited file must PARSE. Runs the in-process
 * tree-sitter check + the shell py_compile / node --check on each edited file
 * (only spawns a shell when a shell-checkable file was actually edited). On a
 * genuine parse failure it injects a reprompt naming the file + error and
 * returns `'injected'`; otherwise `'clean'` (nothing broken) or `'skip'`
 * (disabled, budget spent, or no checkable files).
 *
 * Shared by two callers so a broken file is caught on BOTH termination paths:
 *   - the completion-gate registry (clean-finish / empty-response path), and
 *   - the cycle-detection bail (loop.ts) — a stuck model that thrashed into a
 *     bail with a broken file on disk gets the concrete parse error as a
 *     directed, cycle-breaking task instead of shipping the broken file.
 * Bounded by MAX_SYNTAX_GATE_INJECTIONS across both callers. Both the
 * `completionGate.enabled` master and the gate's own `syntaxGate.enabled` flag
 * are honored here so the cycle-bail caller respects them without duplicating
 * the check.
 */
export async function maybeInjectSyntaxGate(
  state: LoopState,
  config: ReturnType<typeof getConfig>,
  signal: AbortSignal,
  callbacks: AgentCallbacks,
): Promise<'injected' | 'clean' | 'skip'> {
  const { gateState, logger } = state;
  // Once the syntax gate has spent its injection budget it's no longer driving
  // fixes, so stop exempting its fix-target files from cycle detection —
  // further repetition on them is genuine thrash again.
  if ((gateState.syntaxGateInjections ?? 0) >= MAX_SYNTAX_GATE_INJECTIONS) {
    gateState.syntaxGateFixTargets?.clear();
    return 'skip';
  }
  if (config.completionGateEnabled === false || config.syntaxGateEnabled === false) return 'skip';

  const editedList = [...gateState.editedFiles];
  if (!hasCheckableFiles(editedList)) {
    // Observability: a non-empty edit set with no parse-checkable file (e.g.
    // only .ts/.md edits) is expected — but log it so a missing-.py case is
    // visible in the SideCar output channel rather than silent.
    if (editedList.length > 0) {
      logger?.info(`Syntax gate: no parse-checkable files among edited [${editedList.join(', ')}]`);
    }
    return 'skip';
  }

  const root = getRoot();
  try {
    // Run the parse-check through the agent's terminal-first executor (the
    // same path run_tests uses), NOT a raw ShellSession. A raw ShellSession
    // spawns a no-profile shell whose minimal PATH made bare `python3` hang
    // (macOS CLT prompt) → the check timed out at 15s and the gate silently
    // passed a broken file. The integrated terminal uses the login-shell PATH.
    // Resolve to absolute paths so the check is cwd-independent.
    const toCheck = editedList.map((f) => (root && !path.isAbsolute(f) ? path.join(root, f) : f));
    logger?.info(`Syntax gate: checking ${toCheck.length} file(s) — ${toCheck.join(', ')}`);
    const failures = await runSyntaxGate(
      toCheck,
      async (cmd) => {
        const r = await runVerificationCommand(cmd, 15_000, signal);
        if (r.timedOut) logger?.warn(`Syntax gate: parse-check timed out (15s) — ${cmd}`);
        return { exitCode: r.exitCode, output: r.output };
      },
      // Reader for the in-process (tree-sitter) parse check — no shell.
      async (file) => {
        try {
          const { workspace, Uri } = await import('vscode');
          const bytes = await workspace.fs.readFile(Uri.file(file));
          return Buffer.from(bytes).toString('utf-8');
        } catch {
          return null;
        }
      },
    );
    if (failures.length > 0) {
      gateState.syntaxGateInjections = (gateState.syntaxGateInjections ?? 0) + 1;
      // Mark these files as gate-supervised fix targets so the write-target
      // cycle detector doesn't bail the model mid-fix — iterating on a file
      // the gate flagged as unparseable is progress, not thrash.
      gateState.syntaxGateFixTargets = new Set(failures.map((f) => f.file));
      logger?.info(`Syntax gate fired — ${failures.length} edited file(s) fail to parse`);
      callbacks.onText('\n\n🧩 Edited code fails to parse — fixing syntax errors...\n');
      state.messages.push({
        role: 'user',
        content: [{ type: 'text' as const, text: buildSyntaxReprompt(failures) }],
      });
      return 'injected';
    }
    logger?.info('Syntax gate: all checked files parse cleanly');
    // Files now parse — drop the cycle-detector exemption so later, unrelated
    // thrash on the same file is no longer immune.
    gateState.syntaxGateFixTargets?.clear();
    return 'clean';
  } catch (err) {
    // The gate is best-effort: a shell/runtime hiccup must not block the loop.
    logger?.warn(`Syntax gate skipped: ${err instanceof Error ? err.message : String(err)}`);
    return 'skip';
  }
}

/** Registry member: runs the syntax gate; maps its `'clean'` outcome to `'skip'`. */
export const syntaxGate: CompletionGate = {
  name: 'syntax',
  enabled: (config) => config.completionGateEnabled !== false && config.syntaxGateEnabled !== false,
  maybeInject: async (state, ctx) => {
    const outcome = await maybeInjectSyntaxGate(state, ctx.config, ctx.signal, ctx.callbacks);
    return outcome === 'injected' ? 'injected' : 'skip';
  },
};
