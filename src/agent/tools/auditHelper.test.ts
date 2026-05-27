import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/settings.js', () => ({
  getConfig: vi.fn(() => ({ agentMode: 'cautious', auditBufferGitCommits: false })),
}));

import { isAuditModeActive, shouldBufferCommits } from './auditHelper.js';
import { getConfig } from '../../config/settings.js';

function makeContext(agentMode: string, auditBufferGitCommits = false) {
  return {
    config: { agentMode, auditBufferGitCommits } as ReturnType<typeof getConfig>,
  };
}

describe('isAuditModeActive', () => {
  beforeEach(() => {
    vi.mocked(getConfig).mockReturnValue({ agentMode: 'cautious', auditBufferGitCommits: false } as ReturnType<
      typeof getConfig
    >);
  });

  it('returns true when context.config.agentMode is "audit"', () => {
    expect(isAuditModeActive(makeContext('audit') as never)).toBe(true);
  });

  it('returns false when context.config.agentMode is not "audit"', () => {
    expect(isAuditModeActive(makeContext('cautious') as never)).toBe(false);
    expect(isAuditModeActive(makeContext('autonomous') as never)).toBe(false);
  });

  it('falls back to getConfig() when no context is provided', () => {
    vi.mocked(getConfig).mockReturnValue({ agentMode: 'audit' } as ReturnType<typeof getConfig>);
    expect(isAuditModeActive()).toBe(true);
  });

  it('falls back to getConfig() when context has no config property', () => {
    vi.mocked(getConfig).mockReturnValue({ agentMode: 'cautious' } as ReturnType<typeof getConfig>);
    expect(isAuditModeActive({} as never)).toBe(false);
  });

  it('returns false when getConfig() throws', () => {
    vi.mocked(getConfig).mockImplementation(() => {
      throw new Error('settings unavailable');
    });
    expect(isAuditModeActive()).toBe(false);
  });
});

describe('shouldBufferCommits', () => {
  beforeEach(() => {
    vi.mocked(getConfig).mockReturnValue({ agentMode: 'cautious', auditBufferGitCommits: false } as ReturnType<
      typeof getConfig
    >);
  });

  it('returns true only when agentMode is "audit" AND auditBufferGitCommits is true', () => {
    expect(shouldBufferCommits(makeContext('audit', true) as never)).toBe(true);
  });

  it('returns false when agentMode is "audit" but auditBufferGitCommits is false', () => {
    expect(shouldBufferCommits(makeContext('audit', false) as never)).toBe(false);
  });

  it('returns false when agentMode is not "audit" even if auditBufferGitCommits is true', () => {
    expect(shouldBufferCommits(makeContext('cautious', true) as never)).toBe(false);
  });

  it('falls back to getConfig() when no context is provided', () => {
    vi.mocked(getConfig).mockReturnValue({
      agentMode: 'audit',
      auditBufferGitCommits: true,
    } as ReturnType<typeof getConfig>);
    expect(shouldBufferCommits()).toBe(true);
  });

  it('returns false when getConfig() throws', () => {
    vi.mocked(getConfig).mockImplementation(() => {
      throw new Error('settings unavailable');
    });
    expect(shouldBufferCommits()).toBe(false);
  });
});
