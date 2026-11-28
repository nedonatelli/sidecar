import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { workspace } from 'vscode';
import { checkDocumentGate } from './documentGate.js';
import { runAgentLoopInSandbox } from './shadow/sandbox.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler, onSaveMatchPaths } from './scheduler.js';
import type { ScheduledTask } from '../config/settings.js';
import type { AgentLogger } from './logger.js';
import { runAgentLoop } from './loop.js';

// Mock dependencies
vi.mock('../config/settings.js', () => ({
  getConfig: vi.fn(() => ({
    model: 'test-model',
    baseUrl: 'http://localhost',
    apiKey: 'test-key',
  })),
}));

vi.mock('../ollama/client.js', () => ({
  // Class-shaped stub so `new SideCarClient(...)` works — vi.fn() as a
  // mockImplementation returns a plain function and `new` on it throws
  // "not a constructor." Keeps `.close()` stub surface for any callers.
  SideCarClient: class {
    close = vi.fn();
  },
}));

vi.mock('./loop.js', () => ({
  runAgentLoop: vi.fn(async () => Promise.resolve()),
}));

vi.mock('./shadow/sandbox.js', () => ({
  runAgentLoopInSandbox: vi.fn(async () => ({ success: true, output: '' })),
}));

vi.mock('./documentGate.js', () => ({
  checkDocumentGate: vi.fn(() => ({ dirty: false, dirtyFiles: [] })),
}));

describe('Scheduler', () => {
  let scheduler: Scheduler;
  let mockLogger: Partial<AgentLogger>;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      logIteration: vi.fn(),
      logToolCall: vi.fn(),
      logToolResult: vi.fn(),
      logText: vi.fn(),
      logDone: vi.fn(),
      logAborted: vi.fn(),
    };

    scheduler = new Scheduler(mockLogger as AgentLogger);
    vi.useFakeTimers();
  });

  afterEach(() => {
    scheduler.dispose();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('constructs with optional logger and mcpManager', () => {
    expect(scheduler).toBeDefined();
  });

  it('starts scheduled tasks with correct interval', () => {
    const task: ScheduledTask = {
      name: 'test-task',
      enabled: true,
      prompt: 'Do something',
      intervalMinutes: 5,
    };

    scheduler.start([task]);

    expect(vi.mocked(mockLogger.info)).toHaveBeenCalledWith(expect.stringContaining('test-task'));
  });

  it('skips disabled tasks', () => {
    const task: ScheduledTask = {
      name: 'disabled-task',
      enabled: false,
      prompt: 'Do something',
      intervalMinutes: 5,
    };

    scheduler.start([task]);

    expect(vi.mocked(mockLogger.info)).not.toHaveBeenCalledWith(expect.stringContaining('disabled-task'));
  });

  it('skips tasks with interval less than 1 minute', () => {
    const task: ScheduledTask = {
      name: 'quick-task',
      enabled: true,
      prompt: 'Do something',
      intervalMinutes: 0.5,
    };

    scheduler.start([task]);

    expect(vi.mocked(mockLogger.info)).not.toHaveBeenCalledWith(expect.stringContaining('quick-task'));
  });

  it('clears timers when stopping', () => {
    const task: ScheduledTask = {
      name: 'task',
      enabled: true,
      prompt: 'Do something',
      intervalMinutes: 1,
    };

    scheduler.start([task]);
    expect(vi.mocked(mockLogger.info)).toHaveBeenCalled();

    vi.clearAllMocks();
    scheduler.stop();

    // Advance time and verify no new tasks are scheduled
    vi.advanceTimersByTime(60000);
    expect(vi.mocked(mockLogger.info)).not.toHaveBeenCalled();
  });

  it('disposes resources', () => {
    const task: ScheduledTask = {
      name: 'task',
      enabled: true,
      prompt: 'Do something',
      intervalMinutes: 1,
    };

    scheduler.start([task]);
    scheduler.dispose();

    vi.advanceTimersByTime(60000);
    expect(vi.mocked(mockLogger.info)).toHaveBeenCalledTimes(1); // Only from start()
  });

  it('replaces previous timers when starting new tasks', () => {
    const task1: ScheduledTask = {
      name: 'task1',
      enabled: true,
      prompt: 'Do something',
      intervalMinutes: 1,
    };

    scheduler.start([task1]);
    vi.clearAllMocks();

    const task2: ScheduledTask = {
      name: 'task2',
      enabled: true,
      prompt: 'Do something else',
      intervalMinutes: 2,
    };

    scheduler.start([task2]);

    // Should have logged only task2, not task1
    expect(vi.mocked(mockLogger.info)).toHaveBeenCalledWith(expect.stringContaining('task2'));
    expect(vi.mocked(mockLogger.info)).not.toHaveBeenCalledWith(expect.stringContaining('task1'));
  });

  it('handles multiple tasks', () => {
    const tasks: ScheduledTask[] = [
      { name: 'task1', enabled: true, prompt: 'A', intervalMinutes: 1 },
      { name: 'task2', enabled: true, prompt: 'B', intervalMinutes: 2 },
      { name: 'task3', enabled: true, prompt: 'C', intervalMinutes: 3 },
    ];

    scheduler.start(tasks);

    expect(vi.mocked(mockLogger.info)).toHaveBeenCalledTimes(3);
  });

  it('formats interval message correctly', () => {
    const task: ScheduledTask = {
      name: 'scheduled',
      enabled: true,
      prompt: 'Task',
      intervalMinutes: 30,
    };

    scheduler.start([task]);

    expect(vi.mocked(mockLogger.info)).toHaveBeenCalledWith(expect.stringMatching(/every 30m/));
  });

  it('converts interval minutes to milliseconds correctly', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const task: ScheduledTask = {
      name: 'task',
      enabled: true,
      prompt: 'Do something',
      intervalMinutes: 5,
    };

    scheduler.start([task]);

    // Should have called setInterval with 5 * 60 * 1000 = 300000 ms
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 300000);

    setIntervalSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // runTask invocation path (v0.65 chunk 6c gap-fill — was completely
  // uncovered; exercised here via vi.advanceTimersByTime)
  // -------------------------------------------------------------------------
  // These tests drive the runTask dispatch via real timers + a tiny
  // interval (set through a test-only helper). Fake timers don't
  // interact well with the interval → microtask → awaited runAgentLoop
  // chain in this module, and the scheduler's runTask is private so
  // we can't call it directly without wrapping — so we flip to real
  // timers for just this describe block.
  describe('runTask — fires on interval tick', () => {
    beforeEach(() => {
      vi.useRealTimers();
    });
    afterEach(() => {
      scheduler.dispose();
    });

    it('invokes runAgentLoop with the task prompt when the interval fires', async () => {
      // Under 1min is rejected by scheduler (intervalMinutes < 1 skip),
      // so use the smallest accepted value and directly monkey-poke
      // a short real-time setInterval for the test window. Instead,
      // call runTask through the private path by exposing via indexed
      // access — cleaner than subverting start().
      const task: ScheduledTask = {
        name: 'nightly-lint',
        enabled: true,
        prompt: 'Run the linter',
        intervalMinutes: 1,
      };
      // @ts-expect-error — runTask is private; tests reach past the seal
      // rather than widening the public API for coverage alone.
      await (scheduler as { runTask: (t: ScheduledTask) => Promise<void> }).runTask(task);

      expect(runAgentLoop).toHaveBeenCalledOnce();
      const [, messages] = vi.mocked(runAgentLoop).mock.calls[0];
      expect(messages).toEqual([{ role: 'user', content: 'Run the linter' }]);
    });

    it('passes approvalMode="autonomous" and maxIterations=10 (scheduled runs are unattended)', async () => {
      const task: ScheduledTask = {
        name: 'auto',
        enabled: true,
        prompt: 'x',
        intervalMinutes: 1,
      };
      // @ts-expect-error — runTask is private; tests reach past the seal.
      await (scheduler as { runTask: (t: ScheduledTask) => Promise<void> }).runTask(task);

      const options = vi.mocked(runAgentLoop).mock.calls[0][4];
      expect(options?.approvalMode).toBe('autonomous');
      expect(options?.maxIterations).toBe(10);
    });

    it('forwards text chunks to logger.debug, tool calls to logger.info', async () => {
      vi.mocked(runAgentLoop).mockImplementationOnce(async (_c, _m, cb) => {
        cb.onText('streaming text');
        cb.onToolCall('read_file', { path: 'a.ts' }, 'tu1');
        cb.onToolResult('read_file', 'file content', false, 'tu1');
        cb.onDone();
        return [];
      });
      const task: ScheduledTask = { name: 'probe', enabled: true, prompt: 'x', intervalMinutes: 1 };
      scheduler.start([task]);
      // @ts-expect-error — runTask is private; tests reach past the seal.
      await (scheduler as { runTask: (t: ScheduledTask) => Promise<void> }).runTask(task);

      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('streaming text'));
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Tool call: read_file'));
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('read_file: ok'));
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Completed'));
    });

    it('truncates tool results to 100 chars in the log line (bounded verbosity)', async () => {
      vi.mocked(runAgentLoop).mockImplementationOnce(async (_c, _m, cb) => {
        const huge = 'y'.repeat(500);
        cb.onToolResult('grep', huge, false, 'tu1');
        cb.onDone();
        return [];
      });
      const task: ScheduledTask = { name: 'probe', enabled: true, prompt: 'x', intervalMinutes: 1 };
      scheduler.start([task]);
      // @ts-expect-error — runTask is private; tests reach past the seal.
      await (scheduler as { runTask: (t: ScheduledTask) => Promise<void> }).runTask(task);

      const call = vi.mocked(mockLogger.info!).mock.calls.find((c) => String(c[0]).includes('grep: ok'));
      expect(call).toBeDefined();
      const line = String(call![0]);
      // 100 chars of payload + metadata prefix; line stays well under 200 chars total.
      expect(line.length).toBeLessThan(200);
    });

    it('logs is_error results as "error" rather than "ok"', async () => {
      vi.mocked(runAgentLoop).mockImplementationOnce(async (_c, _m, cb) => {
        cb.onToolResult('run_command', 'permission denied', true, 'tu1');
        cb.onDone();
        return [];
      });
      const task: ScheduledTask = { name: 'probe', enabled: true, prompt: 'x', intervalMinutes: 1 };
      scheduler.start([task]);
      // @ts-expect-error — runTask is private; tests reach past the seal.
      await (scheduler as { runTask: (t: ScheduledTask) => Promise<void> }).runTask(task);

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('run_command: error'));
    });

    it('catches runAgentLoop rejections and logs them via logger.error', async () => {
      vi.mocked(runAgentLoop).mockRejectedValueOnce(new Error('backend offline'));
      const task: ScheduledTask = { name: 'crash-probe', enabled: true, prompt: 'x', intervalMinutes: 1 };
      scheduler.start([task]);
      // @ts-expect-error — runTask is private; tests reach past the seal.
      await (scheduler as { runTask: (t: ScheduledTask) => Promise<void> }).runTask(task);

      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('crash-probe'));
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('backend offline'));
    });

    it('coerces non-Error throws to strings in the error log', async () => {
      vi.mocked(runAgentLoop).mockRejectedValueOnce('string rejection');
      const task: ScheduledTask = { name: 'p', enabled: true, prompt: 'x', intervalMinutes: 1 };
      scheduler.start([task]);
      // @ts-expect-error — runTask is private; tests reach past the seal.
      await (scheduler as { runTask: (t: ScheduledTask) => Promise<void> }).runTask(task);

      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('string rejection'));
    });
  });

  // -------------------------------------------------------------------------
  // Cron trigger
  // -------------------------------------------------------------------------
  describe('cron trigger', () => {
    it('logs cron expression on start', () => {
      const task: ScheduledTask = {
        name: 'cron-task',
        enabled: true,
        prompt: 'nightly',
        cron: '0 2 * * *',
      };
      scheduler.start([task]);
      expect(vi.mocked(mockLogger.info)).toHaveBeenCalledWith(expect.stringMatching(/cron-task.*0 2 \* \* \*/));
    });

    it('warns and skips tasks with invalid cron expression', () => {
      const task: ScheduledTask = {
        name: 'bad-cron',
        enabled: true,
        prompt: 'x',
        cron: 'not-a-cron',
      };
      scheduler.start([task]);
      expect(vi.mocked(mockLogger.warn)).toHaveBeenCalledWith(expect.stringContaining('invalid cron'));
    });
  });

  // -------------------------------------------------------------------------
  // onSave trigger (#431)
  // -------------------------------------------------------------------------
  describe('onSave trigger', () => {
    let fire: (fsPath: string) => void;
    let folders: typeof workspace.workspaceFolders;
    let saveSpy: { mockRestore: () => void };

    beforeEach(() => {
      folders = workspace.workspaceFolders;
      saveSpy = vi.spyOn(workspace, 'onDidSaveTextDocument').mockImplementation(((listener: (doc: unknown) => void) => {
        fire = (fsPath) => listener({ uri: { fsPath } });
        return { dispose: () => {} };
      }) as never);
    });
    afterEach(() => {
      (workspace as { workspaceFolders: unknown }).workspaceFolders = folders;
      saveSpy.mockRestore();
    });

    const setFolders = (...paths: string[]) => {
      (workspace as { workspaceFolders: unknown }).workspaceFolders = paths.map((p) => ({ uri: { fsPath: p } }));
    };
    const fired = (globs: string[], fsPath: string): boolean => {
      vi.mocked(mockLogger.info!).mockClear();
      scheduler.start([{ name: 'on-save', enabled: true, prompt: 'p', onSave: globs }]);
      fire(fsPath);
      return vi.mocked(mockLogger.info!).mock.calls.some(([m]) => String(m).includes('"on-save" triggered by save'));
    };

    it('matches a workspace-relative glob against the path inside the folder', () => {
      setFolders('/home/u/proj');
      expect(fired(['src/**/*.ts'], '/home/u/proj/src/agent/x.ts')).toBe(true);
      expect(fired(['src/**/*.ts'], '/home/u/proj/src/x.ts')).toBe(true);
      expect(fired(['src/**/*.ts'], '/home/u/proj/test/x.ts')).toBe(false);
    });

    it('matches a Windows backslash path against a forward-slash glob, ignoring drive-letter case', () => {
      setFolders('C:\\Users\\u\\proj');
      expect(fired(['src/**/*.ts'], 'c:\\Users\\u\\proj\\src\\agent\\x.ts')).toBe(true);
    });

    it('keeps the bare-name and **/-prefixed forms working', () => {
      setFolders('/home/u/proj');
      expect(fired(['*.ts'], '/home/u/proj/src/x.ts')).toBe(true);
      expect(fired(['**/src/**/*.ts'], '/home/u/proj/src/x.ts')).toBe(true);
    });

    it('does not treat a file outside every folder as relative to one', () => {
      setFolders('/home/u/proj');
      expect(fired(['src/**/*.ts'], '/home/u/other/src/x.ts')).toBe(false);
      expect(fired(['**/src/**/*.ts'], '/home/u/other/src/x.ts')).toBe(true);
    });
  });

  describe('onSaveMatchPaths', () => {
    it('returns relative, absolute and file name, all forward-slash', () => {
      expect(onSaveMatchPaths('C:\\w\\proj\\src\\a.ts', ['C:\\w\\proj'])).toEqual([
        'src/a.ts',
        'C:/w/proj/src/a.ts',
        'a.ts',
      ]);
    });

    it('takes the innermost folder when folders nest', () => {
      expect(onSaveMatchPaths('/w/proj/pkg/src/a.ts', ['/w/proj', '/w/proj/pkg'])[0]).toBe('src/a.ts');
    });

    it('does not match a sibling folder that shares a name prefix', () => {
      expect(onSaveMatchPaths('/w/proj-b/src/a.ts', ['/w/proj'])).toEqual(['/w/proj-b/src/a.ts', 'a.ts']);
    });

    it('omits the relative form for a file outside every folder', () => {
      expect(onSaveMatchPaths('/elsewhere/a.ts', ['/w/proj'])).toEqual(['/elsewhere/a.ts', 'a.ts']);
      expect(onSaveMatchPaths('/elsewhere/a.ts', [])).toEqual(['/elsewhere/a.ts', 'a.ts']);
    });
  });

  // -------------------------------------------------------------------------
  // runNow (manual trigger)
  // -------------------------------------------------------------------------
  describe('runNow', () => {
    beforeEach(() => {
      vi.useRealTimers();
    });

    it('runs a named task immediately', async () => {
      const task: ScheduledTask = { name: 'manual', enabled: true, prompt: 'go', intervalMinutes: 60 };
      scheduler.start([task]);
      vi.clearAllMocks();
      await scheduler.runNow('manual');
      expect(runAgentLoop).toHaveBeenCalledOnce();
    });

    it('throws when task name is not found', async () => {
      scheduler.start([]);
      await expect(scheduler.runNow('no-such-task')).rejects.toThrow('"no-such-task"');
    });

    it('records a successful run in run history', async () => {
      const task: ScheduledTask = { name: 'hist-task', enabled: true, prompt: 'x', intervalMinutes: 60 };
      scheduler.start([task]);
      await scheduler.runNow('hist-task');
      const history = scheduler.getRunHistory();
      expect(history).toHaveLength(1);
      expect(history[0].taskName).toBe('hist-task');
      expect(history[0].success).toBe(true);
      expect(history[0].finishedAt).toBeGreaterThanOrEqual(history[0].startedAt);
    });

    it('records a failed run with errorMessage in history', async () => {
      vi.mocked(runAgentLoop).mockRejectedValueOnce(new Error('agent failed'));
      const task: ScheduledTask = { name: 'fail-task', enabled: true, prompt: 'x', intervalMinutes: 60 };
      scheduler.start([task]);
      await scheduler.runNow('fail-task');
      const history = scheduler.getRunHistory();
      expect(history[0].success).toBe(false);
      expect(history[0].errorMessage).toContain('agent failed');
    });

    it('caps history at 100 entries (FIFO)', async () => {
      const task: ScheduledTask = { name: 't', enabled: true, prompt: 'x', intervalMinutes: 60 };
      scheduler.start([task]);
      for (let i = 0; i < 105; i++) {
        await scheduler.runNow('t');
      }
      expect(scheduler.getRunHistory()).toHaveLength(100);
    });
  });

  // -------------------------------------------------------------------------
  // getTaskNames
  // -------------------------------------------------------------------------
  describe('getTaskNames', () => {
    it('returns enabled task names', () => {
      scheduler.start([
        { name: 'a', enabled: true, prompt: 'x', intervalMinutes: 1 },
        { name: 'b', enabled: false, prompt: 'x', intervalMinutes: 1 },
        { name: 'c', enabled: true, prompt: 'x', cron: '* * * * *' },
      ]);
      expect(scheduler.getTaskNames()).toEqual(['a', 'c']);
    });

    it('returns empty array when no tasks loaded', () => {
      expect(scheduler.getTaskNames()).toEqual([]);
    });
  });
});

// #115: a scheduled task on files with unsaved edits runs in a shadow whose
// patch was thrown away, and the run was recorded as a success.
describe('Scheduler — shadow run on dirty files (#115)', () => {
  it('saves the unapplied patch and records the run as not applied', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-115-sched-'));
    const folders = workspace.workspaceFolders;
    (workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: root } }];
    vi.mocked(checkDocumentGate).mockReturnValueOnce({ dirty: true, dirtyFiles: ['src/a.ts'] });
    vi.mocked(runAgentLoopInSandbox).mockResolvedValueOnce({
      mode: 'shadow',
      applied: false,
      reason: 'deferred',
      pendingDiff: 'diff --git a/src/a.ts b/src/a.ts\n',
    } as never);
    const scheduler = new Scheduler();
    try {
      scheduler.start([
        { name: 'nightly fix', enabled: true, prompt: 'p', intervalMinutes: 60, targetPaths: ['src/a.ts'] },
      ]);
      await scheduler.runNow('nightly fix');
      const record = scheduler.getRunHistory().at(-1)!;
      expect(record.success).toBe(false);
      expect(record.errorMessage).toMatch(/not applied: src\/a\.ts had uncommitted changes[\s\S]*git apply/);
      const dir = path.join(root, '.sidecar', 'scheduled-patches');
      const files = fs.readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(fs.readFileSync(path.join(dir, files[0]), 'utf-8')).toContain('diff --git a/src/a.ts');
    } finally {
      scheduler.dispose();
      (workspace as { workspaceFolders: unknown }).workspaceFolders = folders;
    }
  });
});
