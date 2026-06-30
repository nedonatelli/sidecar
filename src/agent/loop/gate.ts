import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';
import type { getConfig } from '../../config/settings.js';
import type { AgentCallbacks, AgentOptions } from '../loop.js';
import {
  recordToolCall as recordGateToolCall,
  checkCompletionGate,
  buildGateInjection,
  buildNoReadReprompt,
  buildNoShellReprompt,
  buildNoFileWriteReprompt,
  buildNoGroundingReprompt,
  buildUnverifiedClaimReprompt,
  buildBehavioralVerificationReprompt,
} from '../completionGate.js';
import { runSyntaxGate, buildSyntaxReprompt, hasCheckableFiles } from './syntaxGate.js';
import { getRoot } from '../tools/shared.js';
import { runVerificationCommand } from '../tools/shell.js';
import { getDefaultToolRuntime } from '../tools/runtime.js';
import type { SymbolGraph, ImpactedItem } from '../../config/symbolGraph.js';
import { findNumericalKernels, uncontractedKernels, type NumericalKernel } from '../numericalContracts.js';
import * as fs from 'fs';
import * as path from 'path';
import type { LoopState } from './state.js';

const IMPACT_REASON_NOUNS: Record<ImpactedItem['reason'], [string, string]> = {
  calls: ['caller', 'callers'],
  'type-use': ['type user', 'type users'],
  subtype: ['subtype', 'subtypes'],
  imports: ['importer', 'importers'],
};
const IMPACT_ADVISORY_MAX_SYMBOLS = 8;

/** One edited exported symbol and its resolved cross-file dependents. */
interface SymbolImpact {
  symbol: string;
  items: ImpactedItem[];
}

/**
 * For each exported symbol in the edited files, the import-resolved dependents
 * that live OUTSIDE the edited files. Resolving against each symbol's own file
 * means a same-named symbol elsewhere never inflates the result. Shared by the
 * advisory (counts) and the gate (block decision + reprompt).
 */
function gatherImpact(graph: SymbolGraph, editedFiles: ReadonlySet<string>, root: string): SymbolImpact[] {
  const relativize = (f: string): string => (root && path.isAbsolute(f) ? path.relative(root, f) : f);
  const editedRel = new Set<string>();
  for (const f of editedFiles) editedRel.add(relativize(f));

  const out: SymbolImpact[] = [];
  for (const rel of editedRel) {
    for (const sym of graph.getSymbolsInFile(rel)) {
      if (!sym.exported) continue;
      const external = graph
        .impactOf([{ name: sym.name, file: rel }], { maxDepth: 1 })
        .filter((i) => !editedRel.has(relativize(i.file)));
      if (external.length > 0) out.push({ symbol: sym.name, items: external });
    }
  }
  return out;
}

function countParts(items: ImpactedItem[]): string {
  const counts = new Map<ImpactedItem['reason'], number>();
  for (const item of items) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  const parts: string[] = [];
  for (const reason of ['calls', 'type-use', 'subtype', 'imports'] as ImpactedItem['reason'][]) {
    const n = counts.get(reason);
    if (!n) continue;
    const [one, many] = IMPACT_REASON_NOUNS[reason];
    parts.push(`${n} ${n === 1 ? one : many}`);
  }
  return parts.join(', ');
}

/**
 * Build a one-line-per-symbol, non-blocking advisory listing downstream
 * dependents of the exported symbols in the edited files. Returns null when
 * nothing exported was touched or nothing external depends on it.
 */
export function buildImpactAdvisory(graph: SymbolGraph, editedFiles: ReadonlySet<string>, root: string): string | null {
  const impact = gatherImpact(graph, editedFiles, root);
  if (impact.length === 0) return null;
  const lines = impact.slice(0, IMPACT_ADVISORY_MAX_SYMBOLS).map((si) => `   • ${si.symbol} — ${countParts(si.items)}`);
  return (
    '\n\n🌐 Change-impact (advisory) — edited exported symbols have downstream dependents:\n' +
    lines.join('\n') +
    '\n   Verify these still hold; call `analyze_impact` for specifics.\n'
  );
}

/** Blocking-gate reprompt: name the unverified dependents and demand the agent
 *  run a test that covers them before finishing. */
function buildImpactGateReprompt(impact: SymbolImpact[]): string {
  const lines = impact.slice(0, IMPACT_ADVISORY_MAX_SYMBOLS).map((si) => {
    const examples = si.items.slice(0, 5).map((i) => (i.line ? `${i.file}:${i.line}` : i.file));
    return `   • ${si.symbol} — ${countParts(si.items)} (e.g. ${examples.join(', ')})`;
  });
  return [
    'Before finishing: you changed exported symbol(s) that have cross-file dependents you have not verified:',
    '',
    ...lines,
    '',
    'Run the project tests — or a test that exercises these call sites / type users — to confirm the change ' +
      'does not break them. If they are genuinely unaffected, run the tests anyway to prove it, then finish.',
  ].join('\n');
}

// --- Numerical-contract gate (§5 vertical) ---------------------------------
// Uses the code graph's type-flow edges to find edited numerical kernels (array/
// quantity-typed functions) that declare no shape/dtype/unit contract. Source is
// read fresh from disk so a contract the agent just added is seen.

function gatherUncontractedKernels(
  graph: SymbolGraph,
  editedFiles: ReadonlySet<string>,
  root: string,
): NumericalKernel[] {
  const relativize = (f: string): string => (root && path.isAbsolute(f) ? path.relative(root, f) : f);
  const editedRel = new Set<string>();
  for (const f of editedFiles) editedRel.add(relativize(f));
  const readSource = (f: string): string | undefined => {
    try {
      return fs.readFileSync(root && !path.isAbsolute(f) ? path.join(root, f) : f, 'utf-8');
    } catch {
      return graph.getFileContent(f);
    }
  };
  return uncontractedKernels(findNumericalKernels(graph, readSource, { fileFilter: (f) => editedRel.has(f) }));
}

function kernelLines(bare: readonly NumericalKernel[]): string[] {
  return bare
    .slice(0, IMPACT_ADVISORY_MAX_SYMBOLS)
    .map((k) => `   • ${k.name} (${k.file}:${k.startLine}) — ${k.roles.join('/')} typed as a bare array`);
}

function buildNumericalAdvisory(bare: readonly NumericalKernel[]): string {
  return (
    '\n\n📐 Numerical contracts (advisory) — edited kernels with no shape/dtype/unit contract:\n' +
    kernelLines(bare).join('\n') +
    '\n   Add a shaped type, a shape/dtype assertion, or a docstring shape spec; or call `check_numerical_contracts`.\n'
  );
}

function buildNumericalGateReprompt(bare: readonly NumericalKernel[]): string {
  return [
    'Before finishing: you edited numerical kernel(s) whose array contracts are unstated:',
    '',
    ...kernelLines(bare),
    '',
    'Give each a shape/dtype contract — a shaped type annotation (e.g. `npt.NDArray[np.float64]` or nptyping ' +
      '`Shape[...]`), an `assert arr.shape == …` / dtype check, or a docstring shape spec — so the array invariants ' +
      'are verifiable, then finish.',
  ].join('\n');
}

/** Bounded retries for the syntax gate, mirroring MAX_GATE_INJECTIONS. */
const MAX_SYNTAX_GATE_INJECTIONS = 2;

// ---------------------------------------------------------------------------
// Completion gate — post-turn policy, two entry points.
//
// The completion gate tracks which files the agent edited and which
// verification commands (lint, tests) it ran across a turn. When the
// agent tries to terminate without verifying its edits, the gate
// injects a synthetic user message demanding verification, forcing
// the loop to continue.
//
// Two call sites in runAgentLoop:
//
//   1. `recordGateToolUses` — after tool execution, feeds every
//      tool call and result into `gateState` so the tracker knows
//      what was edited and what was verified. Called once per turn.
//
//   2. `maybeInjectCompletionGate` — on the empty-response branch
//      (agent emitted no tools this turn), checks whether the gate
//      should fire. If it should, pushes the injection into history
//      and returns `'injected'` so the orchestrator knows to
//      `continue` the loop instead of breaking. If the gate is
//      disabled, has already fired MAX_GATE_INJECTIONS times, or
//      found nothing to verify, returns `'skip'`.
//
// Bounded to MAX_GATE_INJECTIONS attempts per run so a model that
// can't or won't verify doesn't loop forever — after the cap, the
// gate logs a warning and allows termination with unverified edits.
// ---------------------------------------------------------------------------

const MAX_GATE_INJECTIONS = 2;

/** Bounded re-fire for the behavioral-verification gate. Two attempts: one to
 * prompt a real test, one more if the first was hollow (mock that never imports
 * the module). After that the loop proceeds so a model that can't comply isn't
 * stuck. */
const MAX_BEHAVIORAL_VERIFICATION_INJECTIONS = 2;

/**
 * Feed every tool use + result pair into the gate state so it can
 * track which files were edited and which verification commands
 * have run. Called once per turn, after tool execution finishes.
 *
 * Null / missing results are skipped — a rejected tool promise
 * produces a synthetic error result in the parallel-execution
 * handler, so this helper always sees a result in each slot when
 * execution completed normally.
 */
export function recordGateToolUses(
  state: LoopState,
  pendingToolUses: ToolUseContentBlock[],
  toolResults: ToolResultContentBlock[],
): void {
  for (let idx = 0; idx < pendingToolUses.length; idx++) {
    const tr = toolResults[idx];
    if (tr) recordGateToolCall(state.gateState, pendingToolUses[idx], tr);
  }
}

/** Outcome of the empty-response gate check. */
export type GateOutcome = 'injected' | 'skip';

/**
 * Decide whether the empty-response branch should fire the completion
 * gate. Returns `'injected'` when the gate pushed a synthetic user
 * message into history (orchestrator should `continue` instead of
 * `break`), `'skip'` otherwise.
 *
 * Skip conditions (any): abort signal fired, plan-mode turn-one
 * return, completion gate disabled in config, no edited files to
 * verify, injection cap already exhausted, or the
 * `checkCompletionGate` check came back clean. When the cap is
 * exhausted we also log a warning on the way out so users can tell
 * the gate gave up.
 */
export async function maybeInjectCompletionGate(
  state: LoopState,
  config: ReturnType<typeof getConfig>,
  options: AgentOptions,
  signal: AbortSignal,
  callbacks: AgentCallbacks,
): Promise<GateOutcome> {
  const { gateState, logger } = state;

  if (signal.aborted || options.approvalMode === 'plan') return 'skip';

  // Check: file mentioned in user request but no read tool called for it yet.
  // Fires at most once per run to avoid looping on models that can't comply.
  if (!gateState.noReadRepromptFired && config.completionGateEnabled !== false) {
    const reprompt = buildNoReadReprompt(state.messages, gateState.editedFiles, gateState.currentUserRequest);
    if (reprompt) {
      gateState.noReadRepromptFired = true;
      logger?.info('No-read gate fired — file mentioned but no read tool called for it');
      callbacks.onText('\n\n📂 Reading file before answering...\n');
      state.messages.push({ role: 'user', content: [{ type: 'text' as const, text: reprompt }] });
      return 'injected';
    }
  }

  // Check: workspace metric query (file count, line count, version, etc.) but
  // no shell command was run. Fires at most once per run.
  if (!gateState.noShellRepromptFired && config.completionGateEnabled !== false) {
    const reprompt = buildNoShellReprompt(state.messages, gateState.currentUserRequest);
    if (reprompt) {
      gateState.noShellRepromptFired = true;
      logger?.info('No-shell gate fired — workspace metric query answered without a shell command');
      callbacks.onText('\n\n🔍 Running shell command to get live data...\n');
      state.messages.push({ role: 'user', content: [{ type: 'text' as const, text: reprompt }] });
      return 'injected';
    }
  }

  // Check: open-ended review/evaluation of the codebase or design, but no
  // grounding tool was ever called. Fires at most once per run.
  if (!gateState.noGroundingRepromptFired && config.completionGateEnabled !== false) {
    const reprompt = buildNoGroundingReprompt(state.messages, gateState.currentUserRequest);
    if (reprompt) {
      gateState.noGroundingRepromptFired = true;
      logger?.info('No-grounding gate fired — codebase review answered without reading any code');
      callbacks.onText('\n\n🔎 Reading the code before reviewing it...\n');
      state.messages.push({ role: 'user', content: [{ type: 'text' as const, text: reprompt }] });
      return 'injected';
    }
  }

  // Check: analysis/review answer cites paths that don't resolve, or hedges an
  // unverified claim. Fires at most once per run. (Scaffolding roadmap V1.)
  if (!gateState.unverifiedClaimRepromptFired && config.completionGateEnabled !== false) {
    const reprompt = await buildUnverifiedClaimReprompt(state.messages, undefined, gateState.currentUserRequest);
    if (reprompt) {
      gateState.unverifiedClaimRepromptFired = true;
      logger?.info('Unverified-claim gate fired — review cited a nonexistent path or an unverified claim');
      callbacks.onText('\n\n🧾 Verifying citations before finishing...\n');
      state.messages.push({ role: 'user', content: [{ type: 'text' as const, text: reprompt }] });
      return 'injected';
    }
  }

  // Check: file explicitly named in user request with write intent, but never written to.
  // Fires at most once per run; uses a gentle "if required, make them now" framing so
  // the model can skip it when the file genuinely wasn't part of the task.
  if (!gateState.noFileWriteRepromptFired && config.completionGateEnabled !== false) {
    const reprompt = await buildNoFileWriteReprompt(
      state.messages,
      gateState.editedFiles,
      gateState.currentUserRequest,
    );
    if (reprompt) {
      gateState.noFileWriteRepromptFired = true;
      logger?.info('No-file-write gate fired — named file(s) not written');
      callbacks.onText('\n\n📝 Checking named files were written...\n');
      state.messages.push({ role: 'user', content: [{ type: 'text' as const, text: reprompt }] });
      return 'injected';
    }
  }

  // Check: the agent edited behavioral code but ran no test that actually
  // exercises it — including a HOLLOW test that never imports the module under
  // test (it asserts against an inline mock). Launching/compiling can't catch a
  // functional bug. Bounded re-fire so a model that games it with a hollow test
  // gets told once more; gentle framing so a static-check-sufficient fix skips it.
  if (
    (gateState.behavioralVerificationInjections ?? 0) < MAX_BEHAVIORAL_VERIFICATION_INJECTIONS &&
    config.completionGateEnabled !== false
  ) {
    const reprompt = await buildBehavioralVerificationReprompt(
      gateState.currentUserRequest ?? '',
      gateState.editedFiles,
      {
        testsRunForFiles: gateState.testsRunForFiles,
        passingTestFiles: gateState.passingTestFiles,
        projectTestsPassed: gateState.projectTestsPassed,
      },
      undefined,
      state.lastFailureOutput,
    );
    if (reprompt) {
      gateState.behavioralVerificationInjections = (gateState.behavioralVerificationInjections ?? 0) + 1;
      logger?.info('Behavioral-verification gate fired — no test that actually exercises the edited behavior');
      callbacks.onText('\n\n🧪 Writing a test to confirm the fix actually works...\n');
      state.messages.push({ role: 'user', content: [{ type: 'text' as const, text: reprompt }] });
      return 'injected';
    }
  }

  // Syntax gate: edited code must PARSE before the agent can finish. Runs the
  // language's cheap parse-check (py_compile / node --check) on each edited
  // file. Only spawns a shell when a parse-checkable file was actually edited,
  // so .ts-only / no-edit turns never touch the shell. Bounded.
  const editedList = [...gateState.editedFiles];
  // Once the syntax gate has spent its injection budget it's no longer driving
  // fixes, so stop exempting its fix-target files from cycle detection —
  // further repetition on them is genuine thrash again.
  if ((gateState.syntaxGateInjections ?? 0) >= MAX_SYNTAX_GATE_INJECTIONS) {
    gateState.syntaxGateFixTargets?.clear();
  }
  if (config.completionGateEnabled !== false && (gateState.syntaxGateInjections ?? 0) < MAX_SYNTAX_GATE_INJECTIONS) {
    if (!hasCheckableFiles(editedList)) {
      // Observability: a non-empty edit set with no parse-checkable file (e.g.
      // only .ts/.md edits) is expected — but log it so a missing-.py case is
      // visible in the SideCar output channel rather than silent.
      if (editedList.length > 0) {
        logger?.info(`Syntax gate: no parse-checkable files among edited [${editedList.join(', ')}]`);
      }
    } else {
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
        const failures = await runSyntaxGate(toCheck, async (cmd) => {
          const r = await runVerificationCommand(cmd, 15_000, signal);
          if (r.timedOut) logger?.warn(`Syntax gate: parse-check timed out (15s) — ${cmd}`);
          return { exitCode: r.exitCode, output: r.output };
        });
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
      } catch (err) {
        // The gate is best-effort: a shell/runtime hiccup must not block the loop.
        logger?.warn(`Syntax gate skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Opt-in change-impact gate (hard block, bounded to once per run). Promotes
  // the advisory to a block when the edited exported symbols have import-resolved
  // cross-file dependents AND no test passed this run to cover them. Gated by
  // `sidecar.codeGraph.impactGate` (default off) because impact is resolved but
  // not yet AST-exact — opting in trades a stricter gate for occasional
  // over-blocking. When it fires it supersedes the advisory for this turn.
  if (config.impactGateEnabled && (gateState.impactGateInjections ?? 0) < 1 && gateState.editedFiles.size > 0) {
    const verifiedThisRun = gateState.projectTestsPassed || gateState.passingTestFiles.size > 0;
    if (!verifiedThisRun) {
      const graph = getDefaultToolRuntime().symbolGraph;
      if (graph && graph.fileCount() > 0) {
        try {
          const impact = gatherImpact(graph, gateState.editedFiles, getRoot());
          // Only block on resolved (import-bound) impact, never name-only.
          if (impact.some((si) => si.items.some((i) => i.resolved))) {
            gateState.impactGateInjections = 1;
            gateState.impactAdvisoryFired = true; // the block carries the same info
            logger?.info(
              `Change-impact gate fired — ${impact.length} edited exported symbol(s) with unverified dependents`,
            );
            callbacks.onText('\n\n🌐 Verifying downstream dependents before completion...\n');
            state.messages.push({
              role: 'user',
              content: [{ type: 'text' as const, text: buildImpactGateReprompt(impact) }],
            });
            return 'injected';
          }
        } catch (err) {
          logger?.warn(`Change-impact gate skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // Non-blocking change-impact advisory: once per run, surface the downstream
  // dependents of the exported symbols the agent edited. Purely informational —
  // it never injects a message or blocks completion, so even when the gate is
  // off the agent still sees what depends on its edits.
  if (!gateState.impactAdvisoryFired && gateState.editedFiles.size > 0) {
    gateState.impactAdvisoryFired = true;
    const graph = getDefaultToolRuntime().symbolGraph;
    if (graph && graph.fileCount() > 0) {
      try {
        const advisory = buildImpactAdvisory(graph, gateState.editedFiles, getRoot());
        if (advisory) {
          logger?.info('Change-impact advisory surfaced for edited exported symbols');
          callbacks.onText(advisory);
        }
      } catch (err) {
        logger?.warn(`Change-impact advisory skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Numerical-contract gate + advisory (§5 vertical). Self-scoping: only fires
  // when edited files contain numerical kernels lacking a contract, so
  // non-scientific edits are unaffected. Advisory always; opt-in hard block via
  // `sidecar.numericalContracts.gate`. Unlike the impact gate this does not
  // depend on tests — an unstated array contract is a gap regardless.
  {
    const needBlock =
      config.numericalContractGateEnabled === true && (gateState.numericalContractGateInjections ?? 0) < 1;
    const needAdvisory = !gateState.numericalContractAdvisoryFired;
    if (gateState.editedFiles.size > 0 && (needBlock || needAdvisory)) {
      const graph = getDefaultToolRuntime().symbolGraph;
      if (graph && graph.fileCount() > 0) {
        try {
          const bare = gatherUncontractedKernels(graph, gateState.editedFiles, getRoot());
          if (bare.length > 0) {
            if (needBlock) {
              gateState.numericalContractGateInjections = 1;
              gateState.numericalContractAdvisoryFired = true; // the block carries the same info
              logger?.info(`Numerical-contract gate fired — ${bare.length} edited kernel(s) lack a contract`);
              callbacks.onText('\n\n📐 Adding shape/dtype contracts before completion...\n');
              state.messages.push({
                role: 'user',
                content: [{ type: 'text' as const, text: buildNumericalGateReprompt(bare) }],
              });
              return 'injected';
            }
            gateState.numericalContractAdvisoryFired = true;
            logger?.info(`Numerical-contract advisory surfaced — ${bare.length} uncontracted kernel(s)`);
            callbacks.onText(buildNumericalAdvisory(bare));
          }
        } catch (err) {
          logger?.warn(`Numerical-contract gate skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // Skip on config disable / nothing to verify / cap.
  const maxGateInjections = state.scaffoldingProfile?.maxGateInjections ?? MAX_GATE_INJECTIONS;
  const disabled = config.completionGateEnabled === false || gateState.editedFiles.size === 0;

  if (disabled) return 'skip';

  if (gateState.gateInjections >= maxGateInjections) {
    if (gateState.editedFiles.size > 0) {
      logger?.warn(
        `Completion gate exhausted (${maxGateInjections} injections) — allowing termination with unverified edits`,
      );
    }
    return 'skip';
  }

  const findings = await checkCompletionGate(gateState);
  if (findings.length === 0) return 'skip';

  gateState.gateInjections++;
  const injection = buildGateInjection(findings, gateState.gateInjections, maxGateInjections);
  logger?.info(
    `Completion gate fired (#${gateState.gateInjections}/${maxGateInjections}): ${findings.length} unverified edit(s)`,
  );
  callbacks.onText('\n\n🔒 Verifying changes before completion...\n');
  state.messages.push({
    role: 'user',
    content: [{ type: 'text' as const, text: injection }],
  });
  return 'injected';
}
