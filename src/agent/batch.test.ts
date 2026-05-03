import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseBatchInput, runBatch } from './batch.js';

vi.mock('./loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./loop.js')>();
  return { ...actual, runAgentLoop: vi.fn().mockResolvedValue(undefined) };
});

import { runAgentLoop } from './loop.js';

const mockClient = {} as never;

describe('runBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runAgentLoop).mockResolvedValue([] as never);
  });

  it('runs tasks sequentially and returns done status', async () => {
    const updates: string[] = [];
    const tasks = await runBatch(
      mockClient,
      ['task one', 'task two'],
      'sequential',
      (_id, status) => updates.push(status),
      new AbortController().signal,
    );

    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.status === 'done')).toBe(true);
    expect(runAgentLoop).toHaveBeenCalledTimes(2);
  });

  it('runs tasks in parallel', async () => {
    const tasks = await runBatch(mockClient, ['a', 'b', 'c'], 'parallel', () => {}, new AbortController().signal);
    expect(tasks).toHaveLength(3);
    expect(runAgentLoop).toHaveBeenCalledTimes(3);
  });

  it('captures agent text output in task result', async () => {
    vi.mocked(runAgentLoop).mockImplementationOnce(async (_client, _msgs, callbacks) => {
      callbacks.onText('agent output text');
      return [] as never;
    });
    const tasks = await runBatch(mockClient, ['do it'], 'sequential', () => {}, new AbortController().signal);
    expect(tasks[0].result).toBe('agent output text');
  });

  it('records error status when runAgentLoop throws an Error', async () => {
    vi.mocked(runAgentLoop).mockRejectedValueOnce(new Error('loop failed'));
    const tasks = await runBatch(mockClient, ['bad task'], 'sequential', () => {}, new AbortController().signal);
    expect(tasks[0].status).toBe('error');
    expect(tasks[0].result).toContain('loop failed');
  });

  it('records error status when runAgentLoop throws a non-Error', async () => {
    vi.mocked(runAgentLoop).mockRejectedValueOnce('string error' as never);
    const tasks = await runBatch(mockClient, ['bad task'], 'sequential', () => {}, new AbortController().signal);
    expect(tasks[0].status).toBe('error');
    expect(tasks[0].result).toContain('string error');
  });

  it('stops sequential processing when signal is aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await runBatch(mockClient, ['t1', 't2'], 'sequential', () => {}, ac.signal);
    // All tasks should remain pending (signal was already aborted at start)
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  it('uses "(completed)" when agent produces no text output', async () => {
    const tasks = await runBatch(mockClient, ['silent task'], 'sequential', () => {}, new AbortController().signal);
    expect(tasks[0].result).toBe('(completed)');
  });
});

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
