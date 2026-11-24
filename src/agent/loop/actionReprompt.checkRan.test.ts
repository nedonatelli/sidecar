import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../../ollama/types.js';
import type { ToolOutcome } from '../tools/toolOutcome.js';
import { verifiedMutationSinceUserMessage } from './actionReprompt.js';

// #473: a check that never ran was a clean verify here, because
// `(exit code: -1)` isn't a failure to FAILING_CHECK_RE.

const afterEdit = (verifyOutput: string): ChatMessage[] => [
  { role: 'user', content: 'fix the bug in a.py' },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'Wrote a.py' }] },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'v1',
        content: `<tool_output tool="run_command">\n${verifyOutput}\n</tool_output>`,
      },
    ],
  },
];
const outcomes = new Map<string, ToolOutcome>([['e1', { kind: 'mutated', paths: ['a.py'] }]]);

describe('verifiedMutationSinceUserMessage: a check that never ran (#473)', () => {
  it('a check that ran clean verifies the edit', () => {
    expect(verifiedMutationSinceUserMessage(afterEdit('3 passed in 0.2s\n(exit code: 0)'), outcomes)).toBe(true);
  });

  it('a timed-out or backgrounded check does not', () => {
    expect(
      verifiedMutationSinceUserMessage(
        afterEdit('collecting ...\n\n⚠️ Command timed out after 120s with no output\n(exit code: -1)'),
        outcomes,
      ),
    ).toBe(false);
    expect(verifiedMutationSinceUserMessage(afterEdit('Background command started with ID: bg-1'), outcomes)).toBe(
      false,
    );
  });
});
