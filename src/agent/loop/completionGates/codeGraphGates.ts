// Code-graph completion gates — change-impact, numerical-contract, and
// analytic-bound. Each pairs an opt-in (default-off) hard BLOCK with a
// once-per-run non-blocking ADVISORY that fires regardless of the block flag.
// The advisory must run even when the block is off, so each gate's `enabled` is
// always true and the block decision lives inside maybeInject, gated by the
// gate's own config flag. The shared helpers below (moved verbatim from gate.ts)
// resolve the symbol graph and render the reprompts/advisories.
import * as fs from 'fs';
import * as path from 'path';
import { getRoot } from '../../tools/shared.js';
import { getDefaultToolRuntime } from '../../tools/runtime.js';
import { findNumericalKernels, uncontractedKernels, type NumericalKernel } from '../../numericalContracts.js';
import { findUnenforcedBoundsInFiles, type FileBoundFinding } from '../../analyticBounds.js';
import { checkShapeConsistency, type ShapeIssue } from '../../shapePropagation.js';
import type { SymbolGraph, ImpactedItem } from '../../../config/symbolGraph.js';
import type { CompletionGate } from './types.js';

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
  // Forward-slashed: symbolIndexer keys the graph that way, so a backslash
  // relative path from path.relative matched nothing on Windows and these
  // gates silently reported no downstream impact.
  const relativize = (f: string): string =>
    root && path.isAbsolute(f) ? path.relative(root, f).split(path.sep).join('/') : f;
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
  // Forward-slashed: symbolIndexer keys the graph that way, so a backslash
  // relative path from path.relative matched nothing on Windows and these
  // gates silently reported no downstream impact.
  const relativize = (f: string): string =>
    root && path.isAbsolute(f) ? path.relative(root, f).split(path.sep).join('/') : f;
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
  // Forward-slashed: symbolIndexer keys the graph that way, so a backslash
  // relative path from path.relative matched nothing on Windows and these
  // gates silently reported no downstream impact.
  const relativize = (f: string): string =>
    root && path.isAbsolute(f) ? path.relative(root, f).split(path.sep).join('/') : f;
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

export const impactGate: CompletionGate = {
  name: 'change-impact',
  enabled: () => true, // the advisory runs regardless; the block is gated inside
  async maybeInject(state, ctx) {
    const { gateState, logger } = state;
    const { config, callbacks } = ctx;
    // Opt-in hard block (bounded once/run): edited exported symbols with
    // import-resolved cross-file dependents AND no test passed this run.
    if (config.impactGateEnabled && (gateState.impactGateInjections ?? 0) < 1 && gateState.editedFiles.size > 0) {
      const verifiedThisRun = gateState.projectTestsPassed || gateState.passingTestFiles.size > 0;
      if (!verifiedThisRun) {
        const graph = getDefaultToolRuntime().symbolGraph;
        if (graph && graph.fileCount() > 0) {
          try {
            const impact = gatherImpact(graph, gateState.editedFiles, getRoot());
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
    // Non-blocking advisory (once/run), independent of the block flag.
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
    return 'skip';
  },
};

export const numericalContractGate: CompletionGate = {
  name: 'numerical-contract',
  enabled: () => true,
  async maybeInject(state, ctx) {
    const { gateState, logger } = state;
    const { config, callbacks } = ctx;
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
    return 'skip';
  },
};

export const analyticBoundGate: CompletionGate = {
  name: 'analytic-bound',
  enabled: () => true,
  async maybeInject(state, ctx) {
    const { gateState, logger } = state;
    const { config, callbacks } = ctx;
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
    return 'skip';
  },
};
