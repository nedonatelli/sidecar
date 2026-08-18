import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../completionGate.js', () => ({
  checkCompletionGate: vi.fn(async () => []),
  buildGateInjection: vi.fn(() => 'Verify your edited files before finishing.'),
}));

import { baseCompletionGate as gate } from './baseCompletionGate.js';
import { checkCompletionGate } from '../../completionGate.js';
import type { GateContext } from './types.js';
import type { LoopState } from '../state.js';
import type { getConfig } from '../../../config/settings.js';

const ctx = (completionGateEnabled = true): GateContext => ({
  config: { completionGateEnabled } as ReturnType<typeof getConfig>,
  options: {} as GateContext['options'],
  signal: new AbortController().signal,
  callbacks: { onText: vi.fn() } as unknown as GateContext['callbacks'],
});

const makeState = (edited = new Set(['a.ts']), gateInjections = 0) =>
  ({
    gateState: { editedFiles: edited, gateInjections },
    messages: [],
    logger: undefined,
    scaffoldingProfile: undefined,
  }) as unknown as LoopState;

beforeEach(() => vi.mocked(checkCompletionGate).mockReset().mockResolvedValue([]));

describe('baseCompletionGate', () => {
  it('is gated by the completion-gate master', () => {
    expect(gate.enabled({ completionGateEnabled: true } as ReturnType<typeof getConfig>)).toBe(true);
    expect(gate.enabled({ completionGateEnabled: false } as ReturnType<typeof getConfig>)).toBe(false);
  });

  it('skips when nothing was edited', async () => {
    expect(await gate.maybeInject(makeState(new Set()), ctx())).toBe('skip');
    expect(checkCompletionGate).not.toHaveBeenCalled();
  });

  it('skips when the check finds no unverified edits', async () => {
    expect(await gate.maybeInject(makeState(), ctx())).toBe('skip');
  });

  it('injects and increments the counter when there are unverified findings', async () => {
    vi.mocked(checkCompletionGate).mockResolvedValueOnce([{ file: 'a.ts' } as never]);
    const s = makeState();
    expect(await gate.maybeInject(s, ctx())).toBe('injected');
    expect(s.gateState.gateInjections).toBe(1);
    expect(JSON.stringify(s.messages[0])).toContain('Verify your edited files');
  });

  it('stands down (skip) once the injection cap is exhausted', async () => {
    const s = makeState(new Set(['a.ts']), 999);
    expect(await gate.maybeInject(s, ctx())).toBe('skip');
    expect(checkCompletionGate).not.toHaveBeenCalled();
  });
});
