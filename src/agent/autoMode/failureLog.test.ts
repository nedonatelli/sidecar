import { describe, it, expect, vi, beforeEach } from 'vitest';
import { appendFailureLogEntry } from './failureLog.js';

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
}));

import * as fsMod from 'fs/promises';

const mkdir = vi.mocked(fsMod.mkdir);
const appendFile = vi.mocked(fsMod.appendFile);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('appendFailureLogEntry', () => {
  it('creates the parent directory then appends the entry', async () => {
    await appendFailureLogEntry('/ws/.sidecar/logs/auto-mode-failures.md', {
      taskText: 'Write unit tests',
      errorMessage: 'Agent timed out',
      timestamp: new Date('2026-04-21T10:00:00.000Z'),
    });

    expect(mkdir).toHaveBeenCalledWith('/ws/.sidecar/logs', { recursive: true });
    expect(appendFile).toHaveBeenCalledOnce();
    const [filePath, content] = appendFile.mock.calls[0];
    expect(filePath).toBe('/ws/.sidecar/logs/auto-mode-failures.md');
    expect(content).toContain('2026-04-21T10:00:00.000Z');
    expect(content).toContain('Write unit tests');
    expect(content).toContain('Agent timed out');
  });

  it('uses current time when timestamp is omitted', async () => {
    const before = Date.now();
    await appendFailureLogEntry('/ws/.sidecar/logs/auto-mode-failures.md', {
      taskText: 'Task',
      errorMessage: 'boom',
    });
    const after = Date.now();

    const content = appendFile.mock.calls[0][1] as string;
    const match = content.match(/## (.+)\n/);
    expect(match).not.toBeNull();
    const ts = new Date(match![1]).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('formats the entry with task and error sections', async () => {
    await appendFailureLogEntry('/ws/.sidecar/logs/auto-mode-failures.md', {
      taskText: 'Refactor auth',
      errorMessage: 'No changes produced',
      timestamp: new Date('2026-04-21T12:00:00.000Z'),
    });

    const content = appendFile.mock.calls[0][1] as string;
    expect(content).toContain('**Task:** Refactor auth');
    expect(content).toContain('**Error:** No changes produced');
    expect(content).toMatch(/---\s*$/);
  });
});
