import { describe, it, expect } from 'vitest';
import { parseBatchInput } from './batch.js';

describe('parseBatchInput', () => {
  it('parses sequential tasks', () => {
    const { mode, tasks } = parseBatchInput('1. Fix the bug\n2. Add tests\n3. Update docs');
    expect(mode).toBe('sequential');
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toContain('Fix the bug');
    expect(tasks[1]).toContain('Add tests');
    expect(tasks[2]).toContain('Update docs');
  });

  it('parses parallel tasks with --parallel flag', () => {
    const { mode, tasks } = parseBatchInput('--parallel\n- Task A\n- Task B\n- Task C');
    expect(mode).toBe('parallel');
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toContain('Task A');
    expect(tasks[1]).toContain('Task B');
    expect(tasks[2]).toContain('Task C');
  });

  it('parses parallel tasks with bullet points', () => {
    const { mode, tasks } = parseBatchInput('- Task A\n- Task B\n- Task C');
    expect(mode).toBe('sequential');
    expect(tasks.length).toBeGreaterThanOrEqual(3);
  });

  it('handles empty input', () => {
    const { tasks } = parseBatchInput('');
    expect(tasks).toHaveLength(0);
  });

  it('handles single task', () => {
    const { tasks } = parseBatchInput('Just one task');
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('filters out blank lines', () => {
    const { tasks } = parseBatchInput('Task 1\n\n\nTask 2\n  \nTask 3');
    expect(tasks).not.toContain('');
    expect(tasks).toHaveLength(3);
  });

  it('strips whitespace from tasks', () => {
    const { tasks } = parseBatchInput('  Task 1  \n  Task 2  ');
    expect(tasks[0]).toBe('Task 1');
    expect(tasks[1]).toBe('Task 2');
  });

  it('case insensitive --parallel flag', () => {
    const { mode } = parseBatchInput('--PARALLEL\nTask 1');
    expect(mode).toBe('parallel');
  });

  it('recognizes --parallel at beginning of input', () => {
    const { mode } = parseBatchInput('--parallel\nTask 1\nTask 2');
    expect(mode).toBe('parallel');
  });

  it('treats --parallel not at start as regular task', () => {
    const { mode, tasks } = parseBatchInput('Task 1\n--parallel');
    expect(mode).toBe('sequential');
    expect(tasks).toContain('Task 1');
  });

  it('handles mixed formatting', () => {
    const { tasks } = parseBatchInput('1. First\n- Second\n* Third');
    expect(tasks).toHaveLength(3);
  });

  it('preserves task content exactly', () => {
    const input = 'Fix bug in parser\nUpdate documentation\nAdd new tests';
    const { tasks } = parseBatchInput(input);
    expect(tasks).toContain('Fix bug in parser');
    expect(tasks).toContain('Update documentation');
    expect(tasks).toContain('Add new tests');
  });
});
