import { describe, it, expect, vi } from 'vitest';
import { recordDecision, summarizeDecisions, type AgentDecision, type DecisionSink } from './decisions.js';

// These pin the property the module exists for: a decision reaches analysis as
// FIELDS, while the operator-facing line stays byte-identical. The motivating
// failure is in the module header — an A/B on a new completion-gate finding
// could not verify its own trigger, because the log line names neither the
// finding nor the injected text.

describe('recordDecision', () => {
  it('emits the structured record AND the human line, unchanged', () => {
    const seen: AgentDecision[] = [];
    const info = vi.fn();
    const logger: DecisionSink = { info, logDecision: (d) => void seen.push(d) };

    recordDecision(
      logger,
      { kind: 'completion_gate', action: 'fired', attempt: 1, max: 2, findings: ['needsTestRun'] },
      'Completion gate fired (#1/2): 1 unverified edit(s)',
    );

    expect(info).toHaveBeenCalledWith('Completion gate fired (#1/2): 1 unverified edit(s)');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'completion_gate', action: 'fired', findings: ['needsTestRun'] });
  });

  it('routes warn-level decisions to warn, not info', () => {
    const info = vi.fn();
    const warn = vi.fn();
    recordDecision(
      { info, warn },
      { kind: 'completion_gate', action: 'exhausted', max: 2 },
      'Completion gate exhausted (2 injections) — allowing termination with unverified edits',
      'warn',
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(info).not.toHaveBeenCalled();
  });

  it('is a no-op on a logger with no decision sink — plain loggers still log', () => {
    const info = vi.fn();
    expect(() =>
      recordDecision({ info }, { kind: 'red_check_gate', action: 'fired', attempt: 1, max: 2 }, 'Red-check gate fired'),
    ).not.toThrow();
    expect(info).toHaveBeenCalledWith('Red-check gate fired');
  });

  it('tolerates no logger at all', () => {
    expect(() => recordDecision(undefined, { kind: 'keep_best_ratchet', action: 'armed' }, 'armed')).not.toThrow();
  });
});

describe('summarizeDecisions', () => {
  it('counts by kind+action and breaks the gate out by finding', () => {
    const out = summarizeDecisions([
      { kind: 'completion_gate', action: 'fired', findings: ['needsTestRun', 'needsLint'] },
      { kind: 'completion_gate', action: 'fired', findings: ['needsTestRun'] },
      { kind: 'completion_gate', action: 'exhausted' },
    ]);
    expect(out['completion_gate.fired']).toBe(2);
    expect(out['completion_gate.exhausted']).toBe(1);
    expect(out['completion_gate.finding.needsTestRun']).toBe(2);
    expect(out['completion_gate.finding.needsLint']).toBe(1);
  });

  it('separates the ratchet revert arms — the distinction the log line buried in prose', () => {
    const out = summarizeDecisions([
      { kind: 'keep_best_ratchet', action: 'armed', projectTestsPassed: false },
      { kind: 'keep_best_ratchet', action: 'reverted', reason: 'overengineering' },
      { kind: 'keep_best_ratchet', action: 'reverted', reason: 'regression' },
      { kind: 'keep_best_ratchet', action: 'kept' },
    ]);
    expect(out['keep_best_ratchet.armed']).toBe(1);
    expect(out['keep_best_ratchet.reverted']).toBe(2);
    expect(out['keep_best_ratchet.reason.overengineering']).toBe(1);
    expect(out['keep_best_ratchet.reason.regression']).toBe(1);
  });

  it('counts recognised vs unrecognised verification runs separately', () => {
    // The Django case: the product did not recognise ./tests/runtests.py, while
    // every analysis script did. With this field the disagreement is visible in
    // the run's own summary instead of requiring a regex diff by hand.
    const out = summarizeDecisions([
      { kind: 'verification_run', command: './tests/runtests.py utils_tests', recognized: false },
      { kind: 'verification_run', command: 'python -m pytest tests/', recognized: true, runner: 'pytest', exitCode: 1 },
    ]);
    expect(out['verification_run.recognized']).toBe(1);
    expect(out['verification_run.unrecognized']).toBe(1);
  });

  it('separates edits that WROTE from edits that only reported success', () => {
    // The measurement this exists for: 704 of 5,689 "successful" edits across
    // 3,510 recorded runs wrote nothing, and every metric counting successful
    // edits counted them. One flag could not tell them apart; two can.
    const out = summarizeDecisions([
      { kind: 'edit_outcome', path: 'a.py', applied: true, parses: 'ok', writesSinceVerify: 1 },
      { kind: 'edit_outcome', path: 'a.py', applied: false, parses: 'unchecked' },
    ]);
    expect(out['edit_outcome']).toBe(2);
    expect(out['edit_outcome.applied']).toBe(1);
    expect(out['edit_outcome.no_change']).toBe(1);
    // the no-change edit must not be credited with a parse result
    expect(out['edit_outcome.parses.ok']).toBe(1);
    expect(out['edit_outcome.parses.unchecked']).toBeUndefined();
  });

  it('keeps the three parse verdicts distinct', () => {
    // 'unchecked' and 'not-worse' are NOT 'ok'. The gate returns refuse:false
    // for all three, which is right for the gate and wrong for a report.
    const out = summarizeDecisions([
      { kind: 'edit_outcome', path: 'a.py', applied: true, parses: 'ok', writesSinceVerify: 1 },
      { kind: 'edit_outcome', path: 'b.rs', applied: true, parses: 'unchecked', writesSinceVerify: 1 },
      { kind: 'edit_outcome', path: 'c.py', applied: true, parses: 'not-worse', writesSinceVerify: 1 },
    ]);
    expect(out['edit_outcome.parses.ok']).toBe(1);
    expect(out['edit_outcome.parses.unchecked']).toBe(1);
    expect(out['edit_outcome.parses.not-worse']).toBe(1);
  });

  it('counts a rewrite of a file nothing has been run against', () => {
    // The structurally empty verification channel, countable per run: a file
    // edited again with no test run since the last edit.
    const out = summarizeDecisions([
      { kind: 'edit_outcome', path: 'a.py', applied: true, parses: 'ok', writesSinceVerify: 1 },
      { kind: 'edit_outcome', path: 'a.py', applied: true, parses: 'ok', writesSinceVerify: 2 },
      { kind: 'edit_outcome', path: 'a.py', applied: true, parses: 'ok', writesSinceVerify: 3 },
    ]);
    expect(out['edit_outcome.applied']).toBe(3);
    expect(out['edit_outcome.unverified_rewrite']).toBe(2);
  });

  it('returns an empty object for no decisions', () => {
    expect(summarizeDecisions([])).toEqual({});
  });
});

describe('verification_run — the record that ends the regex duplication', () => {
  it('summarises recognised and unrecognised shell commands separately', () => {
    // The Django case: the shipped gate did not recognise ./tests/runtests.py,
    // while every analysis script did. With this field the disagreement shows
    // up in the run's own summary instead of needing a regex diff by hand.
    const out = summarizeDecisions([
      { kind: 'verification_run', command: './tests/runtests.py utils_tests', recognized: true, runner: 'runtests.py' },
      { kind: 'verification_run', command: 'ls -1', recognized: false },
      { kind: 'verification_run', command: 'python -m pytest tests/', recognized: true, runner: 'pytest' },
    ]);
    expect(out['verification_run']).toBe(3);
    expect(out['verification_run.recognized']).toBe(2);
    expect(out['verification_run.unrecognized']).toBe(1);
  });
});
