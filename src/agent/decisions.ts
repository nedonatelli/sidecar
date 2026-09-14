// Structured decision records — what the loop DECIDED, as data.
//
// WHY THIS EXISTS. Every scaffold decision used to reach an experiment only as
// a pre-formatted English sentence in the trajectory log, e.g.
//   [info] Completion gate fired (#1/2): 1 unverified edit(s)
// Which findings triggered it is not in that sentence, so an A/B on a new gate
// finding could not verify its own trigger: the PR #70 run (2026-09-14) had to
// fall back on comparing gate FIRING RATES between arms, because the injected
// text is recorded nowhere and the log line does not name the finding.
//
// The same gap forced every analysis script to re-derive production predicates
// in its own regex. Those copies then drifted: the shipped completion gate
// counted `\b(vitest|jest|pytest|mocha|go test)\b` as a verification run, so on
// a Django corpus it recognised almost nothing, while eight analysis scripts
// used a much broader pattern and reported 59% of runs "ran a test". Both
// numbers were defensible; nothing in the pipeline revealed they disagreed.
//
// So: emit the decision as a record with fields. The human line is still
// emitted, unchanged, by the same call — existing greps and the readable log
// keep working, and this is purely additive.

/** A file path plus the byte delta a decision attributed to it. */
export interface DecisionFile {
  path: string;
  bytes?: number;
}

export type AgentDecision =
  | {
      kind: 'completion_gate';
      /** 'fired' = injected a reprompt; 'exhausted' = budget spent, termination allowed. */
      action: 'fired' | 'exhausted';
      attempt?: number;
      max?: number;
      /**
       * Finding kinds that triggered this firing (e.g. 'needsTestRun',
       * 'needsLint', 'noRead'). THE POINT OF THIS MODULE: without these an
       * experiment on a new finding cannot tell "my trigger never fired" from
       * "my trigger fired and did not help".
       */
      findings?: string[];
      files?: string[];
    }
  | {
      kind: 'red_check_gate';
      action: 'fired' | 'exhausted';
      attempt?: number;
      max?: number;
      /** True when the gate's retries run under the keep-best ratchet. */
      ratcheted?: boolean;
    }
  | {
      kind: 'keep_best_ratchet';
      action: 'armed' | 'kept' | 'reverted' | 'skipped';
      /** For 'reverted': which arm of the ratchet fired. */
      reason?: 'regression' | 'overengineering' | string;
      files?: DecisionFile[];
      /**
       * The verification baseline AT ARMING. A ratchet armed at
       * projectTestsPassed=false can never fire its regression arm — nothing
       * regresses below red — which is exactly why the ratcheted red-check
       * experiment was vacuous on the runs where it fired.
       */
      projectTestsPassed?: boolean;
    }
  | {
      kind: 'verification_run';
      /** The command as the model wrote it. */
      command: string;
      /** Whether the PRODUCT recognised it as a test run. The field that stops
       *  analysis from re-deriving this predicate and silently disagreeing. */
      recognized: boolean;
      runner?: string;
      exitCode?: number;
    };

/** Minimal logger surface this module needs (AgentLogger satisfies it). */
export interface DecisionSink {
  info?(message: string): void;
  warn?(message: string): void;
  /** Present on loggers that collect structured records; absent on plain ones. */
  logDecision?(decision: AgentDecision): void;
}

/**
 * Emit a decision BOTH ways: the structured record for analysis, and the
 * human line for the readable log. `line` is passed in rather than derived so
 * existing messages stay byte-identical — this change must not alter a single
 * line an operator already reads, or any grep that already works.
 */
export function recordDecision(
  logger: DecisionSink | undefined,
  decision: AgentDecision,
  line: string,
  level: 'info' | 'warn' = 'info',
): void {
  logger?.logDecision?.(decision);
  if (level === 'warn') logger?.warn?.(line);
  else logger?.info?.(line);
}

/**
 * Roll a decision list into per-run counts for a predictions row. Counts by
 * kind+action, and for the completion gate also by finding, so a run's summary
 * answers "did my trigger fire" without re-reading the trajectory.
 */
export function summarizeDecisions(decisions: readonly AgentDecision[]): Record<string, number> {
  const out: Record<string, number> = {};
  const bump = (k: string) => {
    out[k] = (out[k] ?? 0) + 1;
  };
  for (const d of decisions) {
    if (d.kind === 'verification_run') {
      bump('verification_run');
      bump(d.recognized ? 'verification_run.recognized' : 'verification_run.unrecognized');
      continue;
    }
    bump(`${d.kind}.${d.action}`);
    if (d.kind === 'completion_gate') for (const f of d.findings ?? []) bump(`completion_gate.finding.${f}`);
    if (d.kind === 'keep_best_ratchet' && d.action === 'reverted' && d.reason) {
      bump(`keep_best_ratchet.reason.${d.reason}`);
    }
  }
  return out;
}
