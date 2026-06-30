import { describe, it, expect } from 'vitest';
import { parseTasks, sampleTasks } from './loader.js';

const rowA = {
  instance_id: 'django__django-2',
  repo: 'django/django',
  base_commit: 'aaa',
  problem_statement: 'fix the bug',
  FAIL_TO_PASS: '["test_a", "test_b"]', // JSON-encoded string (upstream shape)
  PASS_TO_PASS: ['test_c'], // array shape (other exports)
  patch: 'diff --git ...',
  version: '4.2',
};
const rowB = { instance_id: 'sympy__sympy-1', repo: 'sympy/sympy', base_commit: 'bbb', problem_statement: 'x' };

describe('parseTasks', () => {
  it('parses a JSON array and decodes string-encoded test lists', () => {
    const tasks = parseTasks(JSON.stringify([rowA]));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].fail_to_pass).toEqual(['test_a', 'test_b']);
    expect(tasks[0].pass_to_pass).toEqual(['test_c']);
    expect(tasks[0].version).toBe('4.2');
  });

  it('parses JSONL (newline-delimited)', () => {
    const tasks = parseTasks([JSON.stringify(rowA), JSON.stringify(rowB)].join('\n'));
    expect(tasks.map((t) => t.instance_id)).toEqual(['django__django-2', 'sympy__sympy-1']);
    // missing test lists default to empty, not crash
    expect(tasks[1].fail_to_pass).toEqual([]);
  });
});

describe('sampleTasks', () => {
  const tasks = parseTasks(
    JSON.stringify([
      { ...rowB, instance_id: 'c-3', repo: 'r/x' },
      { ...rowB, instance_id: 'a-1', repo: 'r/x' },
      { ...rowB, instance_id: 'b-2', repo: 'r/y' },
    ]),
  );

  it('is deterministic: sorts by instance_id before slicing', () => {
    expect(sampleTasks(tasks, 2).map((t) => t.instance_id)).toEqual(['a-1', 'b-2']);
    // same input → same slice, every time
    expect(sampleTasks(tasks, 2).map((t) => t.instance_id)).toEqual(['a-1', 'b-2']);
  });

  it('filters by repo before sampling', () => {
    expect(sampleTasks(tasks, 10, ['r/x']).map((t) => t.instance_id)).toEqual(['a-1', 'c-3']);
  });

  it('caps at n', () => {
    expect(sampleTasks(tasks, 1)).toHaveLength(1);
  });
});
