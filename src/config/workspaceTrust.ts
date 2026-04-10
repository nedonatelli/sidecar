import { workspace, window } from 'vscode';

/**
 * Per-session trust decisions for workspace-level configuration.
 * Each key is a settings section name (e.g., 'hooks', 'toolPermissions', 'mcpServers').
 * Value: 'trusted' | 'blocked' | undefined (not yet asked).
 */
const trustDecisions = new Map<string, 'trusted' | 'blocked'>();

/**
 * Check whether a workspace-level configuration section should be trusted.
 * If the section has workspace-level values, prompts the user once per session.
 *
 * @returns 'trusted' if the user allows it (or there are no workspace values),
 *          'blocked' if the user blocks it.
 */
export async function checkWorkspaceConfigTrust(
  section: string,
  warningMessage: string,
): Promise<'trusted' | 'blocked'> {
  // Return cached decision if already asked this session
  const cached = trustDecisions.get(section);
  if (cached) return cached;

  const inspection = workspace.getConfiguration('sidecar').inspect(section);
  if (!inspection?.workspaceValue || Object.keys(inspection.workspaceValue as object).length === 0) {
    // No workspace-level config — implicitly trusted
    trustDecisions.set(section, 'trusted');
    return 'trusted';
  }

  const choice = await window.showWarningMessage(warningMessage, { modal: false }, 'Allow', 'Block');

  const decision = choice === 'Block' ? 'blocked' : 'trusted';
  trustDecisions.set(section, decision);
  return decision;
}

/** Reset all trust decisions (e.g., for testing). */
export function resetWorkspaceTrust(): void {
  trustDecisions.clear();
}
