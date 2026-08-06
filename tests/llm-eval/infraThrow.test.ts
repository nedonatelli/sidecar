import { describe, it, expect } from 'vitest';
import { INFRA_FAILURE_PREFIX, isWrappedInfraFailure, isInfraFailure } from './agentHarness.js';

// `runAgentCase` throws on infra breakage instead of returning. That is right
// for agent.eval.ts, where every case is its own `it`: the throw fails one test
// and the suite carries on.
//
// The baseline recorder runs all 70 cases inside a SINGLE `it`, so the same
// throw ended the entire model run. llama3.2 died at case 16 of 70 on "This
// operation was aborted", and because the recorder flushes after every case,
// the 16 it had reached overwrote a complete 69-case baseline.
//
// The recogniser exists because wrapping the original error in a new Error drops
// `err.name`, so `isInfraFailure` cannot identify the re-thrown error — the
// check that classified it in the first place does not recognise its own output.

describe('the infra-failure marker', () => {
  it('recognises the error runAgentCase actually throws', () => {
    expect(isWrappedInfraFailure(new Error(`${INFRA_FAILURE_PREFIX}This operation was aborted`))).toBe(true);
  });

  it('does not claim an ordinary harness bug', () => {
    // A genuine defect must still fail the run rather than being absorbed as
    // "the backend had a moment".
    expect(isWrappedInfraFailure(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isWrappedInfraFailure(new TypeError('x is not a function'))).toBe(false);
  });

  it('tolerates non-Error throws', () => {
    expect(isWrappedInfraFailure('a string')).toBe(false);
    expect(isWrappedInfraFailure(undefined)).toBe(false);
    expect(isWrappedInfraFailure(null)).toBe(false);
  });

  it('is needed because isInfraFailure cannot recognise the wrapped form', () => {
    // The exact reason a separate marker exists rather than reusing the
    // classifier. `new Error(...)` loses `err.name === 'AbortError'`, and the
    // message regex has no `aborted` term — so the classifier returns false on
    // an error it produced itself. If this ever starts passing, the marker can
    // be deleted.
    const original = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    expect(isInfraFailure(original)).toBe(true);

    const wrapped = new Error(`${INFRA_FAILURE_PREFIX}${original.message}`);
    expect(isInfraFailure(wrapped)).toBe(false);
    expect(isWrappedInfraFailure(wrapped)).toBe(true);
  });
});

describe('the recorder survives an infra throw', () => {
  it('guards both loops and counts the throw toward the circuit breaker', async () => {
    // Asserted against the source: running the real loop needs a live model,
    // and this is the property that has to hold — an unguarded `await
    // runAgentCase` is the defect, and it is invisible in any run where the
    // backend behaves.
    const src = await import('fs').then((fs) => fs.readFileSync('tests/llm-eval/agentBaseline.eval.ts', 'utf-8'));
    // No bare call left outside a try.
    expect(src).not.toMatch(/^\s*const r = await runAgentCase\(/m);
    // Every runAgentCase call site guards — matching the CALL, not the import.
    // Three of them now: the record loop, the verify loop, and the extra-trials
    // loop, where an infra failure costs that trial rather than the case.
    expect(src.match(/isWrappedInfraFailure\(err\)/g) ?? []).toHaveLength(3);
    // ...and the record loop counts it, so a dead backend still trips the breaker
    // rather than looping through all 70 cases one throw at a time.
    expect(src).toMatch(/isWrappedInfraFailure\(err\)\) throw err;[\s\S]{0,120}consecutiveUnavailable\+\+/);
  });
});

describe('the recorder honours SIDECAR_EVAL_TRIALS', () => {
  // Asserted against the source for the same reason as the guard above: driving
  // the loop needs a live model, and the property that matters is structural.
  //
  // Five of the eleven cases that flipped between two sweeps flip on seed alone
  // — `shell-error-recovery` passes 2 of 5 on granite4.1 — so a one-shot
  // baseline records a coin toss and the flip resurfaces later as a phantom
  // regression. agent.eval.ts has reported flakiness for a while; the recorder
  // ignored the same knob.
  const src = () => import('fs').then((fs) => fs.readFileSync('tests/llm-eval/agentBaseline.eval.ts', 'utf-8'));

  it('reads the trials knob', async () => {
    expect(await src()).toMatch(/SIDECAR_EVAL_TRIALS/);
  });

  it('records a majority rather than the last trial', async () => {
    // `passes * 2 > results.length` — at TRIALS=1 this is the single result, so
    // the default path is unchanged.
    expect(await src()).toMatch(/passed: passes \* 2 > results\.length/);
  });

  it('stores the rate so a marginal case is visible in the file itself', async () => {
    const s = await src();
    expect(s).toMatch(/trials: results\.length, passes/);
    expect(s).toMatch(/MARGINAL/);
  });
});
