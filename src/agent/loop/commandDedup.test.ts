import { describe, it, expect } from 'vitest';
import { collapseRepeatedCommandResults, type CommandRunRecord } from './commandDedup.js';
import type { ToolResultContentBlock, ToolUseContentBlock } from '../../ollama/types.js';

function use(id: string, name: string, input: Record<string, unknown>): ToolUseContentBlock {
  return { type: 'tool_use', id, name, input } as ToolUseContentBlock;
}
function result(id: string, content: string): ToolResultContentBlock {
  return { type: 'tool_result', tool_use_id: id, content } as ToolResultContentBlock;
}

describe('collapseRepeatedCommandResults', () => {
  it('keeps the first run of a command intact', () => {
    const seen = new Map<string, CommandRunRecord>();
    const { results, collapsed } = collapseRepeatedCommandResults(
      [result('1', 'Ran 12 tests OK')],
      [use('1', 'run_command', { command: 'pytest tests/x.py' })],
      seen,
      0,
      1,
    );
    expect(results[0].content).toBe('Ran 12 tests OK');
    expect(collapsed).toEqual([]);
    expect(seen.size).toBe(1);
  });

  it('collapses an identical re-run when nothing was written in between', () => {
    const seen = new Map<string, CommandRunRecord>();
    const call = [use('1', 'run_command', { command: 'pytest tests/x.py' })];
    collapseRepeatedCommandResults([result('1', 'Ran 12 tests OK')], call, seen, 0, 1);

    const second = collapseRepeatedCommandResults([result('1', 'Ran 12 tests OK')], call, seen, 0, 4);
    expect(second.collapsed).toEqual(['pytest tests/x.py']);
    expect(second.results[0].content).toContain('iteration 1');
    expect(second.results[0].content).not.toContain('Ran 12 tests OK');
  });

  it('does NOT collapse once a file has been written since', () => {
    // The whole point of re-running a test. A changed mutation counter means the
    // result could legitimately differ, so the model must see it in full.
    const seen = new Map<string, CommandRunRecord>();
    const call = [use('1', 'run_command', { command: 'pytest tests/x.py' })];
    collapseRepeatedCommandResults([result('1', 'Ran 12 tests OK')], call, seen, 0, 1);

    const after = collapseRepeatedCommandResults([result('1', 'Ran 12 tests OK')], call, seen, 1, 5);
    expect(after.collapsed).toEqual([]);
    expect(after.results[0].content).toBe('Ran 12 tests OK');
  });

  it('does NOT collapse when the output changed, even with no writes', () => {
    // A flaky test, a timestamp, anything genuinely nondeterministic — which is
    // why run_command is dedup-exempt in the first place. The hash catches it.
    const seen = new Map<string, CommandRunRecord>();
    const call = [use('1', 'run_command', { command: 'date' })];
    collapseRepeatedCommandResults([result('1', '12:00:00')], call, seen, 0, 1);

    const later = collapseRepeatedCommandResults([result('1', '12:00:05')], call, seen, 0, 2);
    expect(later.collapsed).toEqual([]);
    expect(later.results[0].content).toBe('12:00:05');
  });

  it('treats different commands independently', () => {
    const seen = new Map<string, CommandRunRecord>();
    collapseRepeatedCommandResults(
      [result('1', 'out')],
      [use('1', 'run_command', { command: 'pytest a' })],
      seen,
      0,
      1,
    );
    const other = collapseRepeatedCommandResults(
      [result('2', 'out')],
      [use('2', 'run_command', { command: 'pytest b' })],
      seen,
      0,
      2,
    );
    expect(other.collapsed).toEqual([]);
    expect(seen.size).toBe(2);
  });

  it('leaves non-shell tools alone', () => {
    // read_file repeating is handled by the ordinary pruner; this guard is only
    // about the dedup-exempt shell path.
    const seen = new Map<string, CommandRunRecord>();
    const call = [use('1', 'read_file', { path: 'a.ts' })];
    collapseRepeatedCommandResults([result('1', 'contents')], call, seen, 0, 1);
    const again = collapseRepeatedCommandResults([result('1', 'contents')], call, seen, 0, 2);
    expect(again.collapsed).toEqual([]);
    expect(again.results[0].content).toBe('contents');
    expect(seen.size).toBe(0);
  });
});
