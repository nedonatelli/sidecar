import * as fs from 'fs';
import * as path from 'path';
import { describeScaffold, type ScaffoldDescriptor } from '../../src/agent/scaffoldVersion.js';
import { hasProblematicThinking } from '../../src/config/modelAgentBehavior.js';

/**
 * The conditions a recorded baseline was measured under.
 *
 * The baseline previously stored only results plus a model, a timestamp and the
 * extension version — none of which say what the agent was actually doing. A
 * comparison across a changed tool surface or a changed thinking configuration
 * is not a regression signal, and without this it was indistinguishable from
 * one.
 */
export interface BaselineProvenance {
  /** Model identifier exactly as invoked — a tag or quantisation change counts. */
  model: string;
  extensionVersion: string;
  /**
   * Ollama-specific: the other backends have no equivalent switch, so for them
   * this is constant and simply never diverges.
   */
  thinkingEnabled: boolean;
  /**
   * Iteration ceiling the run allowed. A baseline recorded under a tighter cap
   * measures how efficiently a model uses that budget, not whether it can finish
   * — 40% of local failures in the first sweep were runs stopped mid-work. The
   * guard could not see it, because provenance did not record it.
   */
  maxIterations: number;
  /**
   * The RUN-level scaffold. Per-case `configOverrides` are deliberately absent:
   * they are part of the case definition, versioned in git beside it, so two
   * runs of the same committed cases share them. What varies run to run — the
   * resolved settings and any env override — is what this has to capture.
   */
  scaffold: ScaffoldDescriptor;
}

export type Comparability = { comparable: true } | { comparable: false; divergences: string[] };

/** Throws if the version cannot be read — a baseline that cannot describe its
 *  own conditions must not be written, and an exception is that refusal. */
function readExtensionVersion(): string {
  const raw = fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf-8');
  return (JSON.parse(raw) as { version: string }).version;
}

/**
 * Snapshot the conditions the current run is executing under.
 *
 * `runConfig` must be the config the run actually executes with, not the env
 * overrides alone: the harness layers resolved settings under those, and a
 * snapshot built from the top layer would report every underlying flag at a
 * default the run never used.
 *
 * `thinkingEnabled` reads the same field the Ollama backend reads, plus the
 * per-model suppression the agent loop applies — describing what the run DID,
 * not what was requested.
 */
export function currentProvenance(model: string, runConfig: Record<string, unknown>): BaselineProvenance {
  return {
    model,
    extensionVersion: readExtensionVersion(),
    thinkingEnabled: runConfig.ollamaDisableThinking !== true && !hasProblematicThinking(model),
    maxIterations: typeof runConfig.agentMaxIterations === 'number' ? runConfig.agentMaxIterations : 25,
    scaffold: describeScaffold(runConfig),
  };
}

const major = (version: string): string => version.split('.')[0];

function featureDrift(recorded: ScaffoldDescriptor, current: ScaffoldDescriptor): string[] {
  const keys = new Set([...Object.keys(recorded.features), ...Object.keys(current.features)]);
  return [...keys].filter((k) => (recorded.features[k] ?? false) !== (current.features[k] ?? false)).sort();
}

/**
 * Decide whether a recorded baseline can be compared against the current run.
 *
 * Deliberately narrow about what invalidates. A scaffold MINOR/PATCH bump or an
 * extension release does NOT — a guard that fires on every release is ignored,
 * which fails as surely as one that never fires. What breaks comparability is a
 * change to what was being measured: the scaffold MAJOR boundary that
 * docs/scaffold-versions.md already calls not directly comparable, the set of
 * active mechanisms, whether the model could think, and which model it was.
 *
 * Pure by design — no I/O beyond the version read, no vitest, no model. That is
 * what lets the guard run in the normal suite, where the evals it protects
 * cannot.
 */
export function compareProvenance(
  recorded: BaselineProvenance | undefined,
  current: BaselineProvenance,
): Comparability {
  if (!recorded) {
    return {
      comparable: false,
      divergences: ['no provenance recorded — this baseline predates provenance tracking'],
    };
  }

  const divergences: string[] = [];
  if (recorded.model !== current.model) {
    divergences.push(`model: recorded ${recorded.model}, current ${current.model}`);
  }
  if (recorded.maxIterations !== current.maxIterations) {
    divergences.push(`maxIterations: recorded ${recorded.maxIterations}, current ${current.maxIterations}`);
  }
  if (recorded.thinkingEnabled !== current.thinkingEnabled) {
    divergences.push(
      `thinking: recorded ${recorded.thinkingEnabled ? 'on' : 'off'}, current ${current.thinkingEnabled ? 'on' : 'off'}`,
    );
  }
  if (major(recorded.scaffold.version) !== major(current.scaffold.version)) {
    divergences.push(
      `scaffold major version: recorded ${recorded.scaffold.version}, current ${current.scaffold.version}`,
    );
  }
  const drift = featureDrift(recorded.scaffold, current.scaffold);
  if (drift.length > 0) {
    divergences.push(
      `scaffold features changed: ${drift
        .map(
          (k) => `${k} ${recorded.scaffold.features[k] ? 'on' : 'off'}→${current.scaffold.features[k] ? 'on' : 'off'}`,
        )
        .join(', ')}`,
    );
  }

  return divergences.length === 0 ? { comparable: true } : { comparable: false, divergences };
}
