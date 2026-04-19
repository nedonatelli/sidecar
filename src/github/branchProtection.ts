import type { BranchProtection } from './types.js';

// ---------------------------------------------------------------------------
// Branch Protection utilities (v0.68 chunk 3).
//
// Pure primitives — no network, no VS Code. `GitHubAPI.getBranchProtection`
// fetches the rules; these functions convert them into human-readable
// summaries and answer yes/no questions the Draft PR flow (and a future
// pre-push agent hook) need.
// ---------------------------------------------------------------------------

export interface ProtectionSummaryLine {
  /** 'block' = direct push/merge is refused, 'warn' = policy exists but less strict, 'info' = pure fact. */
  severity: 'block' | 'warn' | 'info';
  /** One-sentence human-readable summary of the rule. */
  message: string;
}

/**
 * Render a branch's protection rules as a list of severity-tagged
 * findings, ordered from most-blocking to least. Returns an empty
 * array when `protection` is null (branch unprotected) or when every
 * rule is off.
 */
export function summarizeProtection(protection: BranchProtection | null): ProtectionSummaryLine[] {
  if (!protection) return [];
  const lines: ProtectionSummaryLine[] = [];

  if (protection.pullRequestRequired) {
    const count = protection.requiredApprovingReviews;
    const reviewerClause =
      count === undefined ? 'reviewer approval' : count === 1 ? '1 reviewer approval' : `${count} reviewer approvals`;
    const codeOwnerClause = protection.codeOwnersRequired ? ' (code-owner review required)' : '';
    lines.push({
      severity: 'block',
      message: `Pull request required — direct push blocked. Merge needs ${reviewerClause}${codeOwnerClause}.`,
    });
  }

  if (protection.requiredStatusChecks.length > 0) {
    const sample = protection.requiredStatusChecks.slice(0, 3).join(', ');
    const more =
      protection.requiredStatusChecks.length > 3 ? ` +${protection.requiredStatusChecks.length - 3} more` : '';
    lines.push({
      severity: 'block',
      message: `Required status checks must pass before merge: ${sample}${more}.`,
    });
  }

  if (protection.signedCommitsRequired) {
    lines.push({
      severity: 'block',
      message: 'Signed commits required — unsigned commits are refused on this branch.',
    });
  }

  if (protection.linearHistoryRequired) {
    lines.push({
      severity: 'warn',
      message: 'Linear history required — rebase or squash-merge only; merge commits are refused.',
    });
  }

  if (protection.enforceAdmins) {
    lines.push({
      severity: 'info',
      message: 'Rules enforced for admins too — no override path.',
    });
  } else {
    // Mentioning the override path is genuinely useful for the rare
    // case where the user IS an admin. Keep this at info severity.
    lines.push({
      severity: 'info',
      message: 'Rules NOT enforced for admins — admins can bypass.',
    });
  }

  if (protection.forcePushesAllowed) {
    lines.push({
      severity: 'warn',
      message: 'Force pushes are allowed on this branch (unusual for a protected branch).',
    });
  }

  return lines;
}

/**
 * Yes/no: can a non-admin push directly to this branch? `true` when
 * `protection` is null (unprotected) or when no blocking rule is
 * active. Shorthand so callers don't re-derive the logic themselves.
 */
export function canPushDirect(protection: BranchProtection | null): boolean {
  if (!protection) return true;
  return !protection.pullRequestRequired;
}

/**
 * Render summary lines as a markdown bullet list. Emits an empty
 * string when there's nothing to say so callers can trivially skip
 * the section. Severity becomes a glyph prefix so the rendered UI
 * doesn't need separate styling code.
 */
export function formatProtectionMarkdown(lines: readonly ProtectionSummaryLine[]): string {
  if (lines.length === 0) return '';
  const glyph = (sev: ProtectionSummaryLine['severity']): string =>
    sev === 'block' ? '🔒' : sev === 'warn' ? '⚠️' : 'ℹ️';
  return lines.map((l) => `- ${glyph(l.severity)} ${l.message}`).join('\n');
}
