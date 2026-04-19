import { exec } from 'child_process';
import { promisify } from 'util';
import { workspace } from 'vscode';
import { getConfig } from '../../config/settings.js';
import { checkWorkspaceConfigTrust } from '../../config/workspaceTrust.js';
import { redactSecrets } from '../securityScanner.js';

const execAsync = promisify(exec);

/**
 * Run a pre/post hook for a tool call (v0.69 chunk 1 extraction).
 *
 * Returns an error message string if the hook failed (pre-hooks block
 * execution), or `undefined` on success / skip. Post-hook failures are
 * swallowed — they only warn to the console.
 *
 * Secrets are redacted from SIDECAR_INPUT / SIDECAR_OUTPUT before the
 * child process inherits the environment (audit cycle-3 MEDIUM #7).
 */
export async function runHook(
  phase: 'pre' | 'post',
  toolName: string,
  input: Record<string, unknown>,
  output?: string,
): Promise<string | undefined> {
  const config = getConfig();
  const hooks = config.hooks;
  const toolHook = hooks[toolName]?.[phase];
  const globalHook = hooks['*']?.[phase];
  const command = toolHook || globalHook;

  if (!command) return undefined;

  // Warn once per session if hooks are defined at workspace level (supply-chain risk)
  const hookTrust = await checkWorkspaceConfigTrust(
    'hooks',
    'SideCar: This workspace defines hook commands that will execute shell commands. Only trust hooks from repositories you control.',
  );
  if (hookTrust === 'blocked') return undefined;

  const cwd = workspace.workspaceFolders?.[0]?.uri.fsPath;
  // Redact secret patterns out of the tool input/output before handing
  // them to the hook's child-process environment. Without this, a tool
  // call that e.g. read a `.env` file (slipped past the sensitive-file
  // guard) or returned an API response containing a key would land
  // verbatim in `SIDECAR_INPUT` / `SIDECAR_OUTPUT`, and every subprocess
  // the hook spawns inherits those env vars.
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SIDECAR_TOOL: toolName,
    SIDECAR_INPUT: redactSecrets(JSON.stringify(input)),
  };
  if (output !== undefined) {
    env.SIDECAR_OUTPUT = redactSecrets(output.slice(0, 10_000));
  }

  try {
    await execAsync(command, { cwd, timeout: 15_000, env });
    return undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[SideCar] Hook ${phase}:${toolName} failed: ${msg}`);
    return phase === 'pre' ? msg : undefined;
  }
}
