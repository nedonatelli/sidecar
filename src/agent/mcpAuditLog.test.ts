import { describe, it, expect, vi, afterEach } from 'vitest';
import { setMcpAuditDir, logMcpEvent } from './mcpAuditLog.js';
import type { SidecarDir } from '../config/sidecarDir.js';

function stubDir() {
  const appendJsonl = vi.fn().mockResolvedValue(undefined);
  return { dir: { appendJsonl } as unknown as SidecarDir, appendJsonl };
}

afterEach(() => {
  setMcpAuditDir(null);
});

describe('mcpAuditLog', () => {
  it('no-ops when no SidecarDir is wired', () => {
    const { appendJsonl } = stubDir();
    logMcpEvent({ event: 'disconnected', server: 'fs' });
    expect(appendJsonl).not.toHaveBeenCalled();
  });

  it('appends to logs/mcp.jsonl with a timestamp', () => {
    const { dir, appendJsonl } = stubDir();
    setMcpAuditDir(dir);
    logMcpEvent({ event: 'disconnected', server: 'fs' });
    expect(appendJsonl).toHaveBeenCalledWith(
      'logs/mcp.jsonl',
      expect.objectContaining({ event: 'disconnected', server: 'fs', timestamp: expect.any(String) }),
    );
  });

  it('redacts secrets from spawn commands and args', () => {
    const { dir, appendJsonl } = stubDir();
    setMcpAuditDir(dir);
    logMcpEvent({
      event: 'spawn',
      server: 'gh',
      command: 'npx',
      args: ['-y', 'server-github', '--token', 'ghp_' + 'a'.repeat(36)],
    });
    const record = appendJsonl.mock.calls[0][1] as { args: string[] };
    expect(record.args.join(' ')).not.toContain('ghp_');
    expect(record.args.join(' ')).toContain('[REDACTED');
  });

  it('records connected events with tool lists and lazy flag', () => {
    const { dir, appendJsonl } = stubDir();
    setMcpAuditDir(dir);
    logMcpEvent({
      event: 'connected',
      server: 'fs',
      transport: 'stdio',
      toolCount: 2,
      tools: ['mcp_fs_read', 'mcp_fs_write'],
      lazy: true,
    });
    expect(appendJsonl).toHaveBeenCalledWith(
      'logs/mcp.jsonl',
      expect.objectContaining({ event: 'connected', tools: ['mcp_fs_read', 'mcp_fs_write'], lazy: true }),
    );
  });

  it('swallows append failures (best-effort logging)', () => {
    const appendJsonl = vi.fn().mockRejectedValue(new Error('disk full'));
    setMcpAuditDir({ appendJsonl } as unknown as SidecarDir);
    expect(() => logMcpEvent({ event: 'disconnected', server: 'fs' })).not.toThrow();
  });
});
