import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditLog } from './auditLog.js';
import type { SidecarDir } from '../config/sidecarDir.js';

function createMockSidecarDir(): SidecarDir & { _data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    _data: data,
    appendJsonl: vi.fn(async (subpath: string, entry: unknown) => {
      const existing = data.get(subpath) || '';
      data.set(subpath, existing + JSON.stringify(entry) + '\n');
    }),
    readText: vi.fn(async (subpath: string) => data.get(subpath) || null),
    writeText: vi.fn(async (subpath: string, content: string) => {
      data.set(subpath, content);
    }),
  } as unknown as SidecarDir & { _data: Map<string, string> };
}

describe('AuditLog', () => {
  let dir: ReturnType<typeof createMockSidecarDir>;
  let log: AuditLog;

  beforeEach(() => {
    dir = createMockSidecarDir();
    log = new AuditLog(dir, 's-test', 'test-model', 'cautious');
  });

  it('records a tool call and result', async () => {
    log.recordToolCall('read_file', { path: 'foo.ts' }, 'tc_1', 1);
    await log.recordToolResult('read_file', 'tc_1', 'contents', false, 50);

    const entries = await log.query();
    expect(entries).toHaveLength(1);
    expect(entries[0].tool).toBe('read_file');
    expect(entries[0].durationMs).toBe(50);
    expect(entries[0].isError).toBe(false);
    expect(entries[0].input).toEqual({ path: 'foo.ts' });
  });

  it('records standalone result without prior call', async () => {
    await log.recordToolResult('grep', 'tc_2', 'no results', false, 100);

    const entries = await log.query();
    expect(entries).toHaveLength(1);
    expect(entries[0].tool).toBe('grep');
    expect(entries[0].input).toEqual({});
  });

  it('truncates long results', async () => {
    const longResult = 'x'.repeat(1000);
    await log.recordToolResult('read_file', 'tc_1', longResult, false, 10);

    const entries = await log.query();
    expect(entries[0].result.length).toBeLessThanOrEqual(500);
  });

  it('filters by tool name', async () => {
    await log.recordToolResult('read_file', 'tc_1', 'ok', false, 10);
    await log.recordToolResult('grep', 'tc_2', 'ok', false, 20);
    await log.recordToolResult('read_file', 'tc_3', 'ok', false, 30);

    const entries = await log.query({ tool: 'read_file' });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.tool === 'read_file')).toBe(true);
  });

  it('filters errors only', async () => {
    await log.recordToolResult('read_file', 'tc_1', 'ok', false, 10);
    await log.recordToolResult('grep', 'tc_2', 'fail', true, 20);

    const entries = await log.query({ errorsOnly: true });
    expect(entries).toHaveLength(1);
    expect(entries[0].isError).toBe(true);
  });

  it('limits results', async () => {
    for (let i = 0; i < 10; i++) {
      await log.recordToolResult('read_file', `tc_${i}`, 'ok', false, 10);
    }

    const entries = await log.query({ limit: 3 });
    expect(entries).toHaveLength(3);
  });

  it('gets entry by tool call ID', async () => {
    log.recordToolCall('edit_file', { path: 'bar.ts' }, 'tc_special', 2);
    await log.recordToolResult('edit_file', 'tc_special', 'done', false, 100);

    const entry = await log.getByToolCallId('tc_special');
    expect(entry).not.toBeNull();
    expect(entry!.tool).toBe('edit_file');
    expect(entry!.input).toEqual({ path: 'bar.ts' });
  });

  it('returns null for missing tool call ID', async () => {
    const entry = await log.getByToolCallId('nonexistent');
    expect(entry).toBeNull();
  });

  it('counts entries', async () => {
    await log.recordToolResult('a', 'tc_1', 'ok', false, 10);
    await log.recordToolResult('b', 'tc_2', 'ok', false, 10);

    const count = await log.count();
    expect(count).toBe(2);
  });

  it('clears the log', async () => {
    await log.recordToolResult('a', 'tc_1', 'ok', false, 10);
    await log.clear();

    const count = await log.count();
    expect(count).toBe(0);
  });

  it('updates context via setContext', async () => {
    log.setContext('s-new', 'new-model', 'autonomous');
    await log.recordToolResult('read_file', 'tc_1', 'ok', false, 10);

    const entries = await log.query();
    expect(entries[0].sessionId).toBe('s-new');
    expect(entries[0].model).toBe('new-model');
    expect(entries[0].approvalMode).toBe('autonomous');
  });

  it('filters by session ID', async () => {
    await log.recordToolResult('a', 'tc_1', 'ok', false, 10);
    log.setContext('s-other', 'test-model', 'cautious');
    await log.recordToolResult('b', 'tc_2', 'ok', false, 10);

    const entries = await log.query({ sessionId: 's-test' });
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe('s-test');
  });

  it('returns empty array when no log file exists', async () => {
    const entries = await log.query();
    expect(entries).toEqual([]);
  });
});
