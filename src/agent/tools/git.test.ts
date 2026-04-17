import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gitCommit } from './git.js';
import { AuditBuffer, __setDefaultAuditBufferForTests } from '../audit/auditBuffer.js';
import * as settings from '../../config/settings.js';

/**
 * v0.61 a.4: `git_commit` tool routes through `AuditBuffer.queueCommit`
 * when audit mode is active with `sidecar.audit.bufferGitCommits` on.
 * Scope is tight — we don't test the unrelated pre-existing
 * `GitCLI.commit` path here (that's covered elsewhere by integration
 * and client tests). Just the mode-switch behavior.
 */
describe('gitCommit audit routing', () => {
  let buf: AuditBuffer;
  let getConfigSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    buf = new AuditBuffer();
    __setDefaultAuditBufferForTests(buf);
    getConfigSpy = vi.spyOn(settings, 'getConfig');
  });

  afterEach(() => {
    __setDefaultAuditBufferForTests(null);
    getConfigSpy.mockRestore();
  });

  it('queues the commit in the buffer when agentMode is audit + auditBufferGitCommits is true', async () => {
    getConfigSpy.mockReturnValue({
      agentMode: 'audit',
      auditBufferGitCommits: true,
    } as never);

    const result = await gitCommit({ message: 'feat: buffered' });

    expect(result).toContain('Commit queued in audit buffer');
    expect(result).toContain('feat: buffered');
    expect(buf.hasCommits).toBe(true);
    expect(buf.listCommits()[0].message).toBe('feat: buffered');
  });

  it('does NOT buffer when audit mode is on but auditBufferGitCommits is off', async () => {
    getConfigSpy.mockReturnValue({
      agentMode: 'audit',
      auditBufferGitCommits: false,
    } as never);
    // Don't mock GitCLI.commit — the tool will invoke it and probably
    // fail because tests run outside a git repo, but that's fine. We
    // just assert the buffer was NOT used.
    await gitCommit({ message: 'feat: passthrough' });
    expect(buf.hasCommits).toBe(false);
  });

  it('does NOT buffer when agentMode is not audit', async () => {
    getConfigSpy.mockReturnValue({
      agentMode: 'autonomous',
      auditBufferGitCommits: true,
    } as never);
    await gitCommit({ message: 'feat: passthrough' });
    expect(buf.hasCommits).toBe(false);
  });

  it('preserves the model trailers on the queued commit', async () => {
    getConfigSpy.mockReturnValue({
      agentMode: 'audit',
      auditBufferGitCommits: true,
    } as never);

    const buildModelTrailers = vi.fn(() => 'X-AI-Model: claude-sonnet-4-6 (agent, 3 calls)');
    await gitCommit({ message: 'feat: with trailers' }, { client: { buildModelTrailers } } as never);

    const queued = buf.listCommits()[0];
    expect(queued.extraTrailers).toBe('X-AI-Model: claude-sonnet-4-6 (agent, 3 calls)');
  });
});
