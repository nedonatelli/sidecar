import { describe, it, expect } from 'vitest';
import { parseToolBudgets, withToolBudgets } from './toolBudgets.js';
import { resolveScaffoldingProfile } from '../../src/agent/scaffoldingProfile.js';

describe('SIDECAR_SWE_TOOL_BUDGETS (#268)', () => {
  it('parses tool=N pairs, and unset or empty means no override', () => {
    expect(parseToolBudgets('run_command=6, grep=6,edit_file=4')).toEqual({ run_command: 6, grep: 6, edit_file: 4 });
    expect(parseToolBudgets(undefined)).toBeUndefined();
    expect(parseToolBudgets('  ')).toBeUndefined();
  });

  it('rejects a malformed or zero entry instead of running a different experiment', () => {
    expect(() => parseToolBudgets('run_command')).toThrow(/tool=N/);
    expect(() => parseToolBudgets('run_command=0')).toThrow(/N >= 1/);
    expect(() => parseToolBudgets('run_command=six')).toThrow();
  });

  it('applies per tool through the product path, keeping the tier budgets for other tools', () => {
    const overrides = withToolBudgets({ maxIterations: 90 }, { run_command: 6 });
    expect(overrides).toEqual({ maxIterations: 90, toolBudgets: { run_command: 6 } });
    const profile = resolveScaffoldingProfile('medium', overrides);
    expect(profile.toolBudgets.run_command).toBe(6);
    expect(profile.toolBudgets.grep).toBe(resolveScaffoldingProfile('medium').toolBudgets.grep);
  });

  it('leaves the overrides untouched when no budgets are given', () => {
    const o = { maxIterations: 90 };
    expect(withToolBudgets(o, undefined)).toBe(o);
  });
});
