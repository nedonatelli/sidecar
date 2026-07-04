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
 * Fails closed: trust is granted only on an explicit 'Allow'. Dismissing the
 * prompt (which resolves `undefined`) denies for this evaluation but is not
 * cached, so the user can recover by triggering the flow again — only explicit
 * Allow/Block decisions are remembered for the session.
 *
 * @param options.modal show a blocking modal dialog instead of a dismissable
 *        toast. Use for sections that execute code or shell commands, where an
 *        accidentally-ignored toast must not silently deny (or, previously, grant).
 * @returns 'trusted' if the user allows it (or there are no workspace values),
 *          'blocked' otherwise.
 */
export async function checkWorkspaceConfigTrust(
  section: string,
  warningMessage: string,
  options: { modal?: boolean } = {},
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

  const choice = await window.showWarningMessage(warningMessage, { modal: options.modal ?? false }, 'Allow', 'Block');

  if (choice === 'Allow') {
    trustDecisions.set(section, 'trusted');
    return 'trusted';
  }
  if (choice === 'Block') {
    trustDecisions.set(section, 'blocked');
    return 'blocked';
  }
  // Dismissed: fail closed without caching, so the user can be re-prompted.
  return 'blocked';
}

/** Reset all trust decisions (e.g., for testing). */
export function resetWorkspaceTrust(): void {
  trustDecisions.clear();
}
