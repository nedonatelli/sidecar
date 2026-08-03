import { describe, it, expect } from 'vitest';
import { scoreAgentCase } from './agentScorers.js';
import type { AgentEvalCase, AgentExpectations, TrajectoryEvent } from './agentTypes.js';

// The code that decides every pass and fail in the agent eval, and it had no
// tests. A scorer defect is invisible in exactly the way that matters: the
// suite still reports a number, and the number is wrong.
//
// These cover the route assertions specifically, because those are the ones
// that fail a model for reaching the right outcome by an equally valid path —
// 18 cases pinned a specific write tool alongside a file outcome, and a model
// that used the other tracked write tool read as a regression.

const call = (name: string): TrajectoryEvent => ({ type: 'tool_call', name, input: {}, id: `${name}-1` });

const caseWith = (expectations: AgentExpectations): AgentEvalCase => ({
  id: 'scorer-probe',
  description: 'probe',
  tags: [],
  workspace: {},
  userMessage: 'go',
  expect: expectations,
});

const score = (expectations: AgentExpectations, tools: string[]) =>
  scoreAgentCase(caseWith(expectations), {
    trajectory: tools.map(call),
    finalText: '',
    workspaceAfter: {},
    durationMs: 1,
    iterationsUsed: 1,
  });

describe('toolsCalledAny', () => {
  it('passes when any one of the listed tools was called', () => {
    const r = score({ toolsCalledAny: ['edit_file', 'write_file'] }, ['read_file', 'write_file']);
    expect(r.failures).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('passes on the other listed tool too', () => {
    // The whole point of the relaxation: neither route is privileged.
    expect(score({ toolsCalledAny: ['edit_file', 'write_file'] }, ['edit_file']).passed).toBe(true);
  });

  it('fails when none of them was called', () => {
    // Still has to catch a model that produced the file by some untracked
    // route — a shell heredoc reaches the same bytes without an undoable edit.
    const r = score({ toolsCalledAny: ['edit_file', 'write_file'] }, ['run_command']);
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toMatch(/toolsCalledAny/);
  });
});

describe('trajectoryOrder', () => {
  it('accepts a plain string on both sides', () => {
    expect(
      score({ trajectoryOrder: [{ before: 'edit_file', after: 'run_tests' }] }, ['edit_file', 'run_tests']).passed,
    ).toBe(true);
  });

  it('fails a reversed plain-string order', () => {
    const r = score({ trajectoryOrder: [{ before: 'edit_file', after: 'run_tests' }] }, ['run_tests', 'edit_file']);
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toMatch(/order was reversed/);
  });

  it('takes the earliest match when a side is a list', () => {
    // gate-run-tests-after-fix: the ordering is the assertion, the write tool
    // is not. Both routes must satisfy it.
    const anyWrite: AgentExpectations = {
      trajectoryOrder: [{ before: ['edit_file', 'write_file'], after: 'run_tests' }],
    };
    expect(score(anyWrite, ['edit_file', 'run_tests']).passed).toBe(true);
    expect(score(anyWrite, ['write_file', 'run_tests']).passed).toBe(true);
  });

  it('fails when every listed alternative comes after', () => {
    const r = score({ trajectoryOrder: [{ before: ['edit_file', 'write_file'], after: 'run_tests' }] }, [
      'run_tests',
      'write_file',
    ]);
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toMatch(/order was reversed/);
  });

  it('reports the alternatives by name when none was called', () => {
    // A message naming only one tool sends whoever reads it looking for the
    // wrong thing.
    const r = score({ trajectoryOrder: [{ before: ['edit_file', 'write_file'], after: 'run_tests' }] }, ['run_tests']);
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toMatch(/any of \[edit_file, write_file\]/);
  });

  it('uses the earliest alternative, not the first one listed', () => {
    // write_file happens first here while edit_file is listed first. Reading
    // the list in order rather than by index would wrongly pass this.
    const r = score({ trajectoryOrder: [{ before: ['edit_file', 'write_file'], after: 'run_tests' }] }, [
      'write_file',
      'run_tests',
      'edit_file',
    ]);
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
  });
});
