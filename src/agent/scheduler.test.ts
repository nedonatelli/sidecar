import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from './scheduler.js';
import type { ScheduledTask } from '../config/settings.js';
import type { AgentLogger } from './logger.js';

// Mock dependencies
vi.mock('../config/settings.js', () => ({
  getConfig: vi.fn(() => ({
    model: 'test-model',
    baseUrl: 'http://localhost',
    apiKey: 'test-key',
  })),
}));

vi.mock('../ollama/client.js', () => ({
  SideCarClient: vi.fn().mockImplementation(() => ({
    close: vi.fn(),
  })),
}));

vi.mock('./loop.js', () => ({
  runAgentLoop: vi.fn(async () => Promise.resolve()),
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
});
