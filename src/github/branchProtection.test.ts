import { describe, it, expect } from 'vitest';
import { summarizeProtection, canPushDirect, formatProtectionMarkdown } from './branchProtection.js';
import type { BranchProtection } from './types.js';

// ---------------------------------------------------------------------------
// Tests for branchProtection.ts (v0.68 chunk 3).
//
// Pure primitive — no network. Every case tests the severity + message
// produced by a specific combination of protection rules.
// ---------------------------------------------------------------------------

function makeProtection(overrides: Partial<BranchProtection> = {}): BranchProtection {
  return {
    pullRequestRequired: false,
    requiredApprovingReviews: undefined,
    codeOwnersRequired: false,
    requiredStatusChecks: [],
    signedCommitsRequired: false,
    enforceAdmins: false,
    linearHistoryRequired: false,
    forcePushesAllowed: false,
    ...overrides,
  };
}

describe('summarizeProtection', () => {
  it('returns empty array when protection is null (unprotected branch)', () => {
    const lines = summarizeProtection(null);
    expect(lines).toEqual([]);
  });

  it('returns only the admin-bypass info line when every rule is off', () => {
    const lines = summarizeProtection(makeProtection());
    // The "admins can bypass" info line is always emitted — either
    // admins bypass OR rules enforced for admins. Never silent.
    expect(lines).toHaveLength(1);
    expect(lines[0].severity).toBe('info');
    expect(lines[0].message).toContain('admins can bypass');
  });

  it('flags PR required as a block with the specific reviewer count', () => {
    const lines = summarizeProtection(makeProtection({ pullRequestRequired: true, requiredApprovingReviews: 2 }));
    const block = lines.find((l) => l.severity === 'block');
    expect(block).toBeDefined();
    expect(block!.message).toContain('2 reviewer approvals');
    expect(block!.message).toContain('direct push blocked');
  });

  it('says "1 reviewer approval" singular when count is 1', () => {
    const lines = summarizeProtection(makeProtection({ pullRequestRequired: true, requiredApprovingReviews: 1 }));
    expect(lines[0].message).toContain('1 reviewer approval');
    expect(lines[0].message).not.toContain('approvals');
  });

  it('says generic "reviewer approval" when count is undefined', () => {
    const lines = summarizeProtection(
      makeProtection({ pullRequestRequired: true, requiredApprovingReviews: undefined }),
    );
    expect(lines[0].message).toContain('reviewer approval');
    expect(lines[0].message).not.toMatch(/\d+ reviewer/);
  });

  it('appends "(code-owner review required)" when codeOwnersRequired is true', () => {
    const lines = summarizeProtection(
      makeProtection({
        pullRequestRequired: true,
        requiredApprovingReviews: 1,
        codeOwnersRequired: true,
      }),
    );
    expect(lines[0].message).toContain('code-owner review required');
  });

  it('lists up to 3 required status checks, collapsing the rest into "+N more"', () => {
    const lines = summarizeProtection(
      makeProtection({
        requiredStatusChecks: ['lint', 'test', 'build', 'e2e', 'compile'],
      }),
    );
    const checks = lines.find((l) => l.message.includes('status checks'));
    expect(checks).toBeDefined();
    expect(checks!.severity).toBe('block');
    expect(checks!.message).toContain('lint, test, build');
    expect(checks!.message).toContain('+2 more');
  });

  it('does not emit a status-check line when no contexts are configured', () => {
    const lines = summarizeProtection(makeProtection({ requiredStatusChecks: [] }));
    expect(lines.some((l) => l.message.includes('status checks'))).toBe(false);
  });

  it('flags signedCommitsRequired as a block', () => {
    const lines = summarizeProtection(makeProtection({ signedCommitsRequired: true }));
    const signed = lines.find((l) => l.message.includes('Signed commits'));
    expect(signed?.severity).toBe('block');
  });

  it('flags linearHistoryRequired as a warn', () => {
    const lines = summarizeProtection(makeProtection({ linearHistoryRequired: true }));
    const linear = lines.find((l) => l.message.includes('Linear history'));
    expect(linear?.severity).toBe('warn');
  });

  it('says "Rules enforced for admins" when enforceAdmins is true', () => {
    const lines = summarizeProtection(makeProtection({ enforceAdmins: true }));
    const enforced = lines.find((l) => l.message.includes('Rules enforced for admins'));
    expect(enforced).toBeDefined();
    expect(enforced?.severity).toBe('info');
  });

  it('flags forcePushesAllowed as warn (unusual for protected branches)', () => {
    const lines = summarizeProtection(makeProtection({ forcePushesAllowed: true }));
    const force = lines.find((l) => l.message.includes('Force pushes'));
    expect(force?.severity).toBe('warn');
  });

  it('orders blocks before warns before infos in the full-fence case', () => {
    const lines = summarizeProtection(
      makeProtection({
        pullRequestRequired: true,
        requiredApprovingReviews: 1,
        requiredStatusChecks: ['ci'],
        signedCommitsRequired: true,
        linearHistoryRequired: true,
        enforceAdmins: true,
        forcePushesAllowed: true,
      }),
    );
    const severities = lines.map((l) => l.severity);
    // Sanity: no info line appears before any block line.
    const firstInfoIdx = severities.indexOf('info');
    const lastBlockIdx = severities.lastIndexOf('block');
    expect(firstInfoIdx).toBeGreaterThan(lastBlockIdx);
  });
});

describe('canPushDirect', () => {
  it('returns true when protection is null', () => {
    expect(canPushDirect(null)).toBe(true);
  });

  it('returns true when rules exist but PR is not required', () => {
    expect(canPushDirect(makeProtection({ signedCommitsRequired: true }))).toBe(true);
  });

  it('returns false when pullRequestRequired is true', () => {
    expect(canPushDirect(makeProtection({ pullRequestRequired: true }))).toBe(false);
  });
});

describe('formatProtectionMarkdown', () => {
  it('returns empty string when there are no lines', () => {
    expect(formatProtectionMarkdown([])).toBe('');
  });

  it('emits one bullet per line, tagged with severity glyph', () => {
    const md = formatProtectionMarkdown([
      { severity: 'block', message: 'block msg' },
      { severity: 'warn', message: 'warn msg' },
      { severity: 'info', message: 'info msg' },
    ]);
    const lines = md.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('🔒');
    expect(lines[1]).toContain('⚠️');
    expect(lines[2]).toContain('ℹ️');
    expect(lines[0]).toContain('block msg');
    expect(lines[1]).toContain('warn msg');
    expect(lines[2]).toContain('info msg');
  });
});
