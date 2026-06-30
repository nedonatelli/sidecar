import { describe, it, expect } from 'vitest';
import { classifyFailureBucket, type RunFailureSignals } from './failureTaxonomy.js';

function signals(over: Partial<RunFailureSignals> = {}): RunFailureSignals {
  return {
    completedNaturally: false,
    hitMaxIterations: false,
    aborted: false,
    unrepairedMalformedCalls: 0,
    toolCalls: 0,
    toolErrors: 0,
    gateExhausted: false,
    ...over,
  };
}

describe('classifyFailureBucket', () => {
  it('a natural completion is a success (null)', () => {
    expect(classifyFailureBucket(signals({ completedNaturally: true }))).toBeNull();
  });

  it('a user abort is not a failure (null), even mid-task', () => {
    expect(classifyFailureBucket(signals({ aborted: true, hitMaxIterations: true }))).toBeNull();
  });

  it('unrepaired malformed calls → malformed-call (highest-priority signal)', () => {
    expect(classifyFailureBucket(signals({ unrepairedMalformedCalls: 1, hitMaxIterations: true }))).toBe(
      'malformed-call',
    );
  });

  it('iteration cap → timeout', () => {
    expect(classifyFailureBucket(signals({ hitMaxIterations: true }))).toBe('timeout');
  });

  it('gate exhausted (even on natural completion) → incomplete', () => {
    expect(classifyFailureBucket(signals({ completedNaturally: true, gateExhausted: true }))).toBe('incomplete');
  });

  it('high tool-error rate → wrong-tool', () => {
    expect(classifyFailureBucket(signals({ toolCalls: 4, toolErrors: 3 }))).toBe('wrong-tool');
  });

  it('low tool-error rate without other signals → bad-reasoning', () => {
    expect(classifyFailureBucket(signals({ toolCalls: 4, toolErrors: 1 }))).toBe('bad-reasoning');
  });

  it('terminated with nothing diagnostic → bad-reasoning', () => {
    expect(classifyFailureBucket(signals())).toBe('bad-reasoning');
  });

  it('malformed wins over wrong-tool when both present', () => {
    expect(classifyFailureBucket(signals({ unrepairedMalformedCalls: 2, toolCalls: 4, toolErrors: 4 }))).toBe(
      'malformed-call',
    );
  });
});
