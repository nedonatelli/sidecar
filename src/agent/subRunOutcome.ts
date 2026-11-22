import type { LoopState } from './loop/state.js';

/**
 * Whether a sub-run (spawn_agent's sub-agent, delegate_task's local worker)
 * finished its task, from the termination its loop reported (#475).
 *
 * runAgentLoop returns normally, without throwing, when a model request times
 * out, when the iteration cap is reached (at most 15 for a sub-agent), when a
 * stuck loop is stopped, and when it catches a PolicyEnforcementError. Both
 * callers used to report every normal return as success, so the parent's tool
 * result was not an error and its tool budget, agent memory and tool-chain
 * records all logged a success the sub-run never had.
 */

/** A watcher for a sub-run's termination: pass `onOutcome` into its callbacks. */
export interface SubRunWatch {
  onOutcome: (bucket: unknown, meta?: { termination?: LoopState['termination'] }) => void;
  /** Null when the sub-run finished; otherwise why it did not, as a clause. */
  unfinishedReason(maxIterations: number): string | null;
  /** The termination the loop reported, if it reported one. */
  readonly termination: LoopState['termination'] | 'unreported';
}

export function watchSubRun(): SubRunWatch {
  let seen = false;
  let termination: LoopState['termination'];
  return {
    onOutcome: (_bucket, meta) => {
      seen = true;
      termination = meta?.termination;
    },
    // runAgentLoop reports an outcome on every normal return (finalize), so an
    // unreported run is a loop stand-in, not a real one; it is taken as finished.
    unfinishedReason: (maxIterations) => (seen ? describeUnfinished(termination, maxIterations) : null),
    get termination() {
      return seen ? termination : 'unreported';
    },
  };
}

/** Null for a normal finish; otherwise why the run stopped, as a clause. */
export function describeUnfinished(termination: LoopState['termination'], maxIterations: number): string | null {
  switch (termination) {
    case 'natural':
      return null;
    case 'max-iterations':
      return `it used all ${maxIterations} of its iterations without finishing`;
    case 'out-of-resources':
      return 'it ran out of time or budget (a model request timed out, or its context budget ran out)';
    case 'stuck':
      return 'it was stopped for repeating the same actions';
    case 'aborted':
      return 'it was stopped before it finished';
    case 'error':
      return 'it stopped on an error (from the model server, for example)';
    case undefined:
      return 'it was stopped by an error it caught (a failing policy hook, for example)';
  }
}

/** The parent's tool result for a sub-run that did not finish: the reason, then what it produced. */
export function unfinishedOutput(label: string, reason: string, output: string): string {
  const produced = output.trim();
  return (
    `${label} did not finish: ${reason}. Treat its work as incomplete.` +
    (produced ? `\n\nWhat it produced before stopping:\n${produced}` : ' It produced no output.')
  );
}
