import { describe, it, expect } from 'vitest';
import { classifyFailureBucket, classifyRunError, type RunFailureSignals } from './failureTaxonomy.js';

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

// #271: a loop-control stop was the catch-all bad-reasoning.
describe('classifyFailureBucket — loop-stopped (#271)', () => {
  it('a stuck run with nothing more specific is loop-stopped', () => {
    expect(classifyFailureBucket(signals({ loopStopped: true, toolCalls: 4, toolErrors: 0 }))).toBe('loop-stopped');
  });
  it('a more specific bucket still wins over loop-stopped', () => {
    expect(classifyFailureBucket(signals({ loopStopped: true, unrepairedMalformedCalls: 1 }))).toBe('malformed-call');
    expect(classifyFailureBucket(signals({ loopStopped: true, toolCalls: 4, toolErrors: 3 }))).toBe('wrong-tool');
  });
  it('loop-stopped is a failure, not a success, for model learning', () => {
    expect(classifyFailureBucket(signals({ loopStopped: true }))).not.toBeNull();
  });
});

describe('classifyFailureBucket — a run that ended on an error (#271)', () => {
  // Messages verbatim from recorded runs.
  it.each([
    ['OpenAI API request failed: 502 '],
    ['openai: EngineCore encountered an issue. See stack trace (above) for the root cause.'],
    ['fetch failed'],
    ['Ollama request failed: 500 Internal Server Error — model requires more system memory'],
  ])('backend and transport errors are infra: %s', (message) => {
    expect(classifyFailureBucket(signals({ runError: message, toolCalls: 2, toolErrors: 2 }))).toBe('infra');
  });

  it.each([
    ['Ollama error: XML syntax error on line 11: unexpected EOF'],
    ['Ollama error: expected element type <function> but have <parameter>'],
    ["Ollama error: invalid character '(' in string escape code"],
    ["Ollama error: tool 'Let's look at the template files:[TOOL_CALLS]read_file' not found"],
  ])('a tool call the backend could not take is malformed-call: %s', (message) => {
    expect(classifyFailureBucket(signals({ runError: message }))).toBe('malformed-call');
  });

  it('a generation aborted for repeating itself is loop-stopped', () => {
    expect(
      classifyFailureBucket(signals({ runError: 'Ollama error: prediction aborted, token repeat limit reached' })),
    ).toBe('loop-stopped');
  });

  it('the error decides the bucket over the run’s other signals', () => {
    expect(
      classifyFailureBucket(
        signals({ runError: 'OpenAI API request failed: 502 ', loopStopped: true, toolCalls: 4, toolErrors: 3 }),
      ),
    ).toBe('infra');
  });

  it('an empty message is still an error, and still infra', () => {
    expect(classifyRunError('')).toBe('infra');
  });

  it('a run with no error is unaffected', () => {
    expect(classifyFailureBucket(signals({ toolCalls: 4, toolErrors: 0 }))).toBe('bad-reasoning');
  });
});
