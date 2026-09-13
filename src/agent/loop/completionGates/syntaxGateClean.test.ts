import { describe, it, expect, vi } from 'vitest';
import { stubLoopState } from '../testHelpers.js';

// The clean path of the syntax gate wrapper: a parse that passes must be
// RECORDED so the base gate can accept it as the static check for Python
// (see GateState.syntaxCleanFiles). Without the record, a .py edit in an
// environment with no linter could never satisfy the lint requirement.
vi.mock('../syntaxGate.js', () => ({
  runSyntaxGate: vi.fn(async () => []),
  buildSyntaxReprompt: vi.fn(() => ''),
  hasCheckableFiles: vi.fn(() => true),
}));
vi.mock('../../tools/shared.js', () => ({ getRoot: () => '/repo' }));
vi.mock('../../tools/shell.js', () => ({
  runVerificationCommand: vi.fn(async () => ({ exitCode: 0, output: '', timedOut: false })),
}));

import { maybeInjectSyntaxGate } from './syntaxGate.js';
import { createGateState } from '../../completionGate.js';

describe('syntax gate — clean pass is recorded for the base gate', () => {
  it('stores the edited files under the base gate keys when every file parses', async () => {
    const gateState = createGateState();
    gateState.editedFiles.add('django/utils/http.py');
    const state = stubLoopState({ gateState });
    const outcome = await maybeInjectSyntaxGate(
      state,
      { completionGateEnabled: true, syntaxGateEnabled: true } as never,
      new AbortController().signal,
      { onText: vi.fn() } as never,
    );
    expect(outcome).toBe('clean');
    expect([...(gateState.syntaxCleanFiles ?? [])]).toEqual(['django/utils/http.py']);
  });
});
