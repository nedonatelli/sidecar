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
  buildMcpMutationVerifyReprompt,
} from '../completionGate.js';
import { runSyntaxGate, buildSyntaxReprompt, hasCheckableFiles } from './syntaxGate.js';
import { planStepWriteTargetsNotWritten } from '../plans/externalPlan.js';
import { getRoot } from '../tools/shared.js';
import { runVerificationCommand } from '../tools/shell.js';
import { getDefaultToolRuntime } from '../tools/runtime.js';
import type { SymbolGraph, ImpactedItem } from '../../config/symbolGraph.js';
import { findNumericalKernels, uncontractedKernels, type NumericalKernel } from '../numericalContracts.js';
import { findUnenforcedBoundsInFiles, type FileBoundFinding } from '../analyticBounds.js';
import { checkShapeConsistency, type ShapeIssue } from '../shapePropagation.js';
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

/** Combined §5 findings for the edited files: kernels with no contract, plus
 *  provable shape-contract conflicts. */
interface NumericalFindings {
  bare: NumericalKernel[];
  conflicts: ShapeIssue[];
}

function gatherNumericalFindings(
  graph: SymbolGraph,
  editedFiles: ReadonlySet<string>,
  root: string,
): NumericalFindings {
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
  const inScope = { fileFilter: (f: string) => editedRel.has(f) };
  return {
    bare: uncontractedKernels(findNumericalKernels(graph, readSource, inScope)),
    conflicts: checkShapeConsistency(graph, readSource, inScope),
  };
}

function findingsEmpty(f: NumericalFindings): boolean {
  return f.bare.length === 0 && f.conflicts.length === 0;
}

function bareLines(bare: readonly NumericalKernel[]): string[] {
  return bare
    .slice(0, IMPACT_ADVISORY_MAX_SYMBOLS)
    .map((k) => `   • ${k.name} (${k.file}:${k.startLine}) — ${k.roles.join('/')} typed as a bare array`);
}

function conflictLines(conflicts: readonly ShapeIssue[]): string[] {
  return conflicts
    .slice(0, IMPACT_ADVISORY_MAX_SYMBOLS)
    .map((i) => `   • ${i.kernel} (${i.file}:${i.line}) [${i.kind}] — ${i.detail}`);
}

function buildNumericalAdvisory(f: NumericalFindings): string {
  const parts: string[] = ['\n\n📐 Numerical contracts (advisory):'];
  if (f.conflicts.length > 0) {
    parts.push('  Shape-contract conflicts (likely bugs):', ...conflictLines(f.conflicts));
  }
  if (f.bare.length > 0) {
    parts.push('  Kernels with no shape/dtype/unit contract:', ...bareLines(f.bare));
  }
  parts.push('  Call `check_shape_consistency` / `check_numerical_contracts` for detail.\n');
  return parts.join('\n');
}

function buildNumericalGateReprompt(f: NumericalFindings): string {
  const parts: string[] = ['Before finishing, resolve these numerical-contract issues in your edits:', ''];
  if (f.conflicts.length > 0) {
    parts.push('Shape-contract conflicts — the stated shapes disagree (fix the annotation, assertion, or callee):');
    parts.push(...conflictLines(f.conflicts), '');
  }
  if (f.bare.length > 0) {
    parts.push(
      'Numerical kernels with no contract — give each a shaped type, a `assert arr.shape == …` / dtype check, or a docstring shape spec:',
    );
    parts.push(...bareLines(f.bare), '');
  }
  parts.push('Then finish.');
  return parts.join('\n');
}

// --- Analytic-bound gate (§5 vertical, pillar 2) ---------------------------
// Shape contracts say the array is the right shape; analytic bounds say the
// VALUES are physically admissible (a probability in [0,1], an energy ≥ 0, a
// normalized sum == 1). A kernel that DECLARES a bound (`# bounds: …`) but does
// not enforce it — no assert, no clip, no raise — and isn't test-verified is the
// gap this surfaces, with the exact assertion to add.

function gatherBoundFindings(graph: SymbolGraph, editedFiles: ReadonlySet<string>, root: string): FileBoundFinding[] {
  const relativize = (f: string): string => (root && path.isAbsolute(f) ? path.relative(root, f) : f);
  const editedRel = new Set<string>();
  for (const f of editedFiles) editedRel.add(relativize(f));
  const readSource = (f: string): string | undefined => {
    const cached = graph.getFileContent(f);
    if (cached) return cached;
    try {
      return fs.readFileSync(root && !path.isAbsolute(f) ? path.join(root, f) : f, 'utf-8');
    } catch {
      return undefined;
    }
  };
  return findUnenforcedBoundsInFiles(editedRel, graph, readSource);
}

function boundLines(findings: readonly FileBoundFinding[]): string[] {
  return findings
    .slice(0, IMPACT_ADVISORY_MAX_SYMBOLS)
    .map((f) => `   • ${f.func} (${f.file}:${f.fileLine}) declares \`${f.bound.raw}\` — nothing enforces it`);
}

function buildBoundAdvisory(findings: readonly FileBoundFinding[]): string {
  return (
    '\n\n📊 Analytic bounds (advisory) — declared value bounds with no enforcement:\n' +
    boundLines(findings).join('\n') +
    '\n   Add the stated check (or a property test that tries to violate it) so the physics is verified, not just asserted in a comment.\n'
  );
}

function buildBoundGateReprompt(findings: readonly FileBoundFinding[]): string {
  const lines = findings
    .slice(0, IMPACT_ADVISORY_MAX_SYMBOLS)
    .map((f) => `   • ${f.func} (${f.file}:${f.fileLine}) — declared \`${f.bound.raw}\`; add:  ${f.fix}`);
  return [
    'Before finishing: you edited kernels that DECLARE an analytic value bound but nothing enforces it. A comment ' +
      'is not a guarantee — add the assertion (or a property test that tries to violate the bound):',
    '',
    ...lines,
    '',
    'Enforce each bound in the code (or add a test that would fail if it were violated), then finish.',
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

import { MAX_GATE_INJECTIONS } from '../../config/constants.js';

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
  const mcpToolMeta = state.mcpManager ? (name: string) => state.mcpManager!.getToolMeta(name) : undefined;
  for (let idx = 0; idx < pendingToolUses.length; idx++) {
    const tr = toolResults[idx];
    if (tr) recordGateToolCall(state.gateState, pendingToolUses[idx], tr, mcpToolMeta);
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
/**
 * Deterministic syntax gate: every edited file must PARSE. Runs the in-process
 * tree-sitter check + the shell py_compile / node --check on each edited file
 * (only spawns a shell when a shell-checkable file was actually edited). On a
 * genuine parse failure it injects a reprompt naming the file + error and
 * returns `'injected'`; otherwise `'clean'` (nothing broken) or `'skip'`
 * (disabled, budget spent, or no checkable files).
 *
 * Shared by two callers so a broken file is caught on BOTH termination paths:
 *   - the completion gate (clean-finish / empty-response path), and
 *   - the cycle-detection bail (loop.ts) — a stuck model that thrashed into a
 *     bail with a broken file on disk gets the concrete parse error as a
 *     directed, cycle-breaking task instead of shipping the broken file.
 * Bounded by MAX_SYNTAX_GATE_INJECTIONS across both callers.
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
  if (config.completionGateEnabled === false) return 'skip';

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

export async function maybeInjectCompletionGate(
  state: LoopState,
  config: ReturnType<typeof getConfig>,
  options: AgentOptions,
  signal: AbortSignal,
  callbacks: AgentCallbacks,
): Promise<GateOutcome> {
  const { gateState, logger } = state;

  if (signal.aborted || options.approvalMode === 'plan') return 'skip';

  // Any injection below is scaffold-tail by default; the plan-incomplete
  // branch overrides this to true (primary-work continuation — the keep-best
  // ratchet must not arm on it; see completionGate.ts field doc).
  gateState.lastInjectionWasPrimaryWork = false;

  // Check: the externalized plan says the run isn't done. This is the one
  // completion check with STRUCTURED evidence — no prose matching: if
  // planRef.plan exists and current < steps.length, "all steps completed"
  // is a deterministic contradiction (observed live: llama3.2 declared
  // completion at step 4/10 with 2 of 10 files written). Fires at most
  // twice — a long plan legitimately needs more than one nudge, but an
  // unbounded gate would loop a model that cannot comply. Stands down
  // when there is no plan.
  if (config.completionGateEnabled !== false) {
    const plan = state.planRef?.plan;
    const fired = gateState.planIncompleteInjections ?? 0;
    if (plan && fired < 2) {
      const incomplete = plan.current < plan.steps.length;
      // Even at current == steps.length, a step that NAMES its deliverable
      // ("Create out/DONE.md …") which was never written is a provable
      // false-completion claim — checked against editedFiles, no fs access.
      const unwritten = incomplete ? [] : planStepWriteTargetsNotWritten(plan, gateState.editedFiles);
      if (incomplete || unwritten.length > 0) {
        gateState.planIncompleteInjections = fired + 1;
        gateState.lastInjectionWasPrimaryWork = true;
        const detail = incomplete
          ? `it shows step ${plan.current} of ${plan.steps.length}. Do not finish yet. Work the remaining steps in order:\n` +
            plan.steps
              .slice(plan.current - 1)
              .map((s, i) => `${plan.current + i}. ${s}`)
              .join('\n') +
            `\nWhen a step is done, include an update_plan call with the next current index alongside your next tool call — do not spend a message on update_plan alone. ` +
            `If the remaining steps are actually already finished, call update_plan with current=${plan.steps.length} before answering.`
          : `your plan says every step is done, but these files named in the plan were never written:\n` +
            unwritten.map((p) => `  - ${p}`).join('\n') +
            `\nCreate each with write_file(path, content) exactly as its plan step specifies, then answer.`;
        logger?.info(
          incomplete
            ? `Plan-incomplete gate fired — plan shows step ${plan.current}/${plan.steps.length}`
            : `Plan-incomplete gate fired — plan claims done but ${unwritten.length} named deliverable(s) unwritten`,
        );
        callbacks.onText(
          incomplete
            ? `\n\n📋 Plan shows step ${plan.current}/${plan.steps.length} — continuing remaining steps...\n`
            : `\n\n📋 Plan claims done but ${unwritten.length} planned file(s) missing — finishing them...\n`,
        );
        state.messages.push({
          role: 'user',
          content: [{ type: 'text' as const, text: `Your plan is not complete: ${detail}` }],
        });
        return 'injected';
      }
    }
  }

  // Check: the model's own verification FAILED and it is trying to finish
  // anyway. The gate historically verified that checks RAN, not that they
  // PASSED — v0.122 gemma4 ran `tsc --noEmit`, saw both errors, wrote "this
  // is expected, the compiler hasn't picked up the change," and finished with
  // a broken import (rename-propagates-to-cross-file-caller, the one
  // fleet-universal failure). Fires at most twice; the wording explicitly
  // allows an honest could-not-complete report to exit, so a model in an
  // unfixable workspace is not trapped. Fix work in response is the user's
  // PRIMARY work (the task is not done while its check is red) — the
  // keep-best ratchet must not arm on it.
  if (
    config.completionGateEnabled !== false &&
    gateState.failedCheckOutput &&
    (gateState.redCheckInjections ?? 0) < 2
  ) {
    gateState.redCheckInjections = (gateState.redCheckInjections ?? 0) + 1;
    gateState.lastInjectionWasPrimaryWork = true;
    const attempt = gateState.redCheckInjections;
    logger?.info(`Red-check gate fired (attempt ${attempt}/2) — last verification FAILED`);
    callbacks.onText('\n\n🔴 The last check FAILED — completion refused until it passes or the failure is reported.\n');
    state.messages.push({
      role: 'user',
      content: [
        {
          type: 'text' as const,
          text:
            `[Completion gate] The last verification you ran FAILED:\n${gateState.failedCheckOutput}\n\n` +
            `Do not declare the task done while your own check is failing, and do not explain the failure away ` +
            `as stale or expected — re-run the check if you believe it is outdated. Either fix the cause and ` +
            `re-run the check until it passes, or state plainly that the task could not be completed and quote ` +
            `the failing output.`,
        },
      ],
    });
    return 'injected';
  }

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

  // Check: an MCP mutation (tool without readOnlyHint: true) succeeded but was
  // never followed by a read-only call to the same server — the write is
  // fire-and-trust. Demands round-trip evidence for each field the model set;
  // on mismatch the model is told to report it and leave the resource in
  // draft rather than claim success. Fires at most once per run.
  if (!gateState.mcpMutationRepromptFired && config.completionGateEnabled !== false) {
    const reprompt = buildMcpMutationVerifyReprompt(gateState);
    if (reprompt) {
      gateState.mcpMutationRepromptFired = true;
      logger?.info('MCP mutation-verify gate fired — external write(s) never read back');
      callbacks.onText('\n\n🔁 Verifying external writes landed...\n');
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

  // Syntax gate: edited code must PARSE before the agent can finish. Extracted
  // so the cycle-detection bail can also run it (loop.ts) — a stuck loop with a
  // broken edited file gets a directed syntax-fix task instead of a silent bail.
  if ((await maybeInjectSyntaxGate(state, config, signal, callbacks)) === 'injected') return 'injected';

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
          const findings = gatherNumericalFindings(graph, gateState.editedFiles, getRoot());
          if (!findingsEmpty(findings)) {
            if (needBlock) {
              gateState.numericalContractGateInjections = 1;
              gateState.numericalContractAdvisoryFired = true; // the block carries the same info
              logger?.info(
                `Numerical-contract gate fired — ${findings.conflicts.length} shape conflict(s), ${findings.bare.length} uncontracted kernel(s)`,
              );
              callbacks.onText('\n\n📐 Resolving numerical-contract issues before completion...\n');
              state.messages.push({
                role: 'user',
                content: [{ type: 'text' as const, text: buildNumericalGateReprompt(findings) }],
              });
              return 'injected';
            }
            gateState.numericalContractAdvisoryFired = true;
            logger?.info(
              `Numerical-contract advisory surfaced — ${findings.conflicts.length} conflict(s), ${findings.bare.length} uncontracted`,
            );
            callbacks.onText(buildNumericalAdvisory(findings));
          }
        } catch (err) {
          logger?.warn(`Numerical-contract gate skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // Analytic-bound gate + advisory (§5 vertical, pillar 2). Fires only when an
  // edited kernel declares a value bound with no enforcement. Advisory always;
  // opt-in hard block via `sidecar.analyticBounds.gate`. Independent of tests —
  // a comment-only bound is unverified regardless of what the suite does.
  {
    const needBoundBlock =
      config.analyticBoundsGateEnabled === true && (gateState.analyticBoundGateInjections ?? 0) < 1;
    const needBoundAdvisory = !gateState.analyticBoundAdvisoryFired;
    if (gateState.editedFiles.size > 0 && (needBoundBlock || needBoundAdvisory)) {
      const graph = getDefaultToolRuntime().symbolGraph;
      if (graph && graph.fileCount() > 0) {
        try {
          const findings = gatherBoundFindings(graph, gateState.editedFiles, getRoot());
          if (findings.length > 0) {
            if (needBoundBlock) {
              gateState.analyticBoundGateInjections = 1;
              gateState.analyticBoundAdvisoryFired = true; // the block carries the same info
              logger?.info(`Analytic-bound gate fired — ${findings.length} declared-but-unenforced bound(s)`);
              callbacks.onText('\n\n📊 Enforcing declared analytic bounds before completion...\n');
              state.messages.push({
                role: 'user',
                content: [{ type: 'text' as const, text: buildBoundGateReprompt(findings) }],
              });
              return 'injected';
            }
            gateState.analyticBoundAdvisoryFired = true;
            logger?.info(`Analytic-bound advisory surfaced — ${findings.length} unenforced bound(s)`);
            callbacks.onText(buildBoundAdvisory(findings));
          }
        } catch (err) {
          logger?.warn(`Analytic-bound gate skipped: ${err instanceof Error ? err.message : String(err)}`);
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
