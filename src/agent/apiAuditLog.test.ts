import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setApiAuditDir, logApiCall, type ApiAuditEntry } from './apiAuditLog.js';
import type { SidecarDir } from '../config/sidecarDir.js';

function makeEntry(): ApiAuditEntry {
  return {
    runId: 'run-1',
    model: 'claude-sonnet-4-6',
    inputTokens: 100,
    outputTokens: 50,
    stopReason: 'end_turn',
    timestamp: new Date().toISOString(),
  };
}

describe('apiAuditLog', () => {
  beforeEach(() => {
    setApiAuditDir(null);
    vi.clearAllMocks();
  });

  it('no-ops when verboseLogs is false', () => {
    const mockDir = { appendJsonl: vi.fn().mockResolvedValue(undefined) } as unknown as SidecarDir;
    setApiAuditDir(mockDir);
    logApiCall(makeEntry(), false);
    expect(mockDir.appendJsonl).not.toHaveBeenCalled();
  });

  it('no-ops when no sidecarDir is set', () => {
    logApiCall(makeEntry(), true);
    // Should not throw
  });

  it('calls appendJsonl when verboseLogs is true and dir is set', async () => {
    const mockDir = { appendJsonl: vi.fn().mockResolvedValue(undefined) } as unknown as SidecarDir;
    setApiAuditDir(mockDir);
    const entry = makeEntry();
    logApiCall(entry, true);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockDir.appendJsonl).toHaveBeenCalledWith('logs/api.jsonl', entry);
  });

  it('swallows appendJsonl errors silently', async () => {
    const mockDir = {
      appendJsonl: vi.fn().mockRejectedValue(new Error('disk full')),
    } as unknown as SidecarDir;
    setApiAuditDir(mockDir);
    logApiCall(makeEntry(), true);
    await new Promise((r) => setTimeout(r, 0));
    // No throw expected
  });

  it('setApiAuditDir(null) clears the directory', () => {
    const mockDir = { appendJsonl: vi.fn().mockResolvedValue(undefined) } as unknown as SidecarDir;
    setApiAuditDir(mockDir);
    setApiAuditDir(null);
    logApiCall(makeEntry(), true);
    expect(mockDir.appendJsonl).not.toHaveBeenCalled();
  });
});
