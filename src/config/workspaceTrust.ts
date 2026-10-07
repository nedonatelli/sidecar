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
 * @param options.workspaceProvided treat the section as workspace content even
 *        when no SETTING carries it -- e.g. servers from a project `.mcp.json`.
 * @returns 'trusted' if the user allows it (or there are no workspace values),
 *          'blocked' otherwise.
 */
export async function checkWorkspaceConfigTrust(
  section: string,
  warningMessage: string,
  options: { modal?: boolean; workspaceProvided?: boolean } = {},
): Promise<'trusted' | 'blocked'> {
  // Return cached decision if already asked this session
  const cached = trustDecisions.get(section);
  if (cached) return cached;

  // Nothing from the workspace means nothing to trust -- but that is NOT
  // cached: a value that arrives later (a git pull, an agent editing
  // .vscode/settings.json) must still be asked about.
  if (!options.workspaceProvided && !hasWorkspaceValue(section)) return 'trusted';

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

/**
 * True when the workspace (or a workspace folder) sets `section`. Folder
 * values are workspace content too, and a value is present even when it is
 * `false`, `0` or `""` -- the previous `Object.keys(...).length` test read a
 * workspace-set boolean as "no value".
 */
function hasWorkspaceValue(section: string): boolean {
  const cfg = workspace.getConfiguration('sidecar');
  if (typeof cfg.inspect !== 'function') return false;
  const i = cfg.inspect(section);
  const present = (v: unknown) =>
    v !== undefined && v !== null && !(typeof v === 'object' && Object.keys(v as object).length === 0);
  return present(i?.workspaceValue) || present(i?.workspaceFolderValue);
}

// ---------------------------------------------------------------------------
// Sensitive settings: values a cloned repository must not set silently.
// ---------------------------------------------------------------------------

/**
 * Settings where a workspace value could send the user's credentials to
 * another host, make SideCar run a program, or lower its approval or
 * isolation. A workspace or folder value for any of these is IGNORED -- the
 * user's own (global) value or the default applies -- until the user allows
 * this workspace's values in a modal prompt.
 */
export const SENSITIVE_WORKSPACE_KEYS: readonly string[] = [
  // Hosts that receive the user's API key or tokens
  'baseUrl',
  'provider',
  'fallbackBaseUrl',
  'zotero.baseUrl',
  'voice.transcriptionUrl',
  'contextProviders',
  // Programs and commands SideCar would run
  'visualVerify.browserPath',
  'eventHooks',
  'shadowWorkspace.gateCommand',
  // Approval and isolation
  'agentMode',
  'sandbox.enabled',
  // SideCar's own local agent server
  'mcpServer.enabled',
  'mcpServer.requireAuth',
  'mcpServer.authToken',
];
const SENSITIVE = new Set(SENSITIVE_WORKSPACE_KEYS);

/** The workspace's values for the sensitive keys it sets, keyed by setting. */
function sensitiveWorkspaceValues(): Record<string, unknown> {
  const cfg = workspace.getConfiguration('sidecar');
  const out: Record<string, unknown> = {};
  if (typeof cfg.inspect !== 'function') return out;
  for (const key of SENSITIVE_WORKSPACE_KEYS) {
    const i = cfg.inspect(key);
    const v = i?.workspaceFolderValue ?? i?.workspaceValue;
    if (v !== undefined) out[key] = v;
  }
  return out;
}

interface SensitiveDecision {
  fingerprint: string;
  trusted: boolean;
}

/** The decision covers only the exact values it was made for. */
let sensitiveDecision: SensitiveDecision | null = null;
const fingerprintOf = (values: Record<string, unknown>) => JSON.stringify(values);
const MEMENTO_KEY = 'sidecar.sensitiveWorkspaceTrust';

function sensitiveValuesTrusted(): boolean {
  return (
    sensitiveDecision?.trusted === true && sensitiveDecision.fingerprint === fingerprintOf(sensitiveWorkspaceValues())
  );
}

type Configuration = ReturnType<typeof workspace.getConfiguration>;

/**
 * A view of `cfg` for config reads: a sensitive key whose workspace value is
 * not (yet) allowed reads as the user's global value, else the default. Fails
 * closed -- before the prompt is answered, the workspace value is not used.
 */
export function trustFilteredConfig(cfg: Configuration): Configuration {
  const read = (key: string, def: unknown) => (def === undefined ? cfg.get(key) : cfg.get(key, def));
  const get = (key: string, def?: unknown): unknown => {
    if (!SENSITIVE.has(key) || typeof cfg.inspect !== 'function' || sensitiveValuesTrusted()) return read(key, def);
    const i = cfg.inspect(key);
    if (i?.workspaceValue === undefined && i?.workspaceFolderValue === undefined) return read(key, def);
    if (i.globalValue !== undefined) return i.globalValue;
    return def !== undefined ? def : i.defaultValue;
  };
  // VS Code freezes the configuration object, so a Proxy may not replace its
  // `get` (invariant violation); shadow it on an object inheriting the rest.
  return Object.create(cfg, { get: { value: get } }) as Configuration;
}

/**
 * Ask about the sensitive values this workspace sets, once per distinct set of
 * values (remembered in `memento` across sessions when given). Returns true
 * when the effective configuration changed, so the caller can drop any cached
 * config.
 */
export async function ensureSensitiveWorkspaceSettingsTrust(memento?: {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}): Promise<boolean> {
  const values = sensitiveWorkspaceValues();
  const keys = Object.keys(values);
  if (keys.length === 0) return false;
  const fingerprint = fingerprintOf(values);
  if (sensitiveDecision?.fingerprint === fingerprint) return false;

  const remembered = memento?.get<SensitiveDecision>(MEMENTO_KEY);
  if (remembered?.fingerprint === fingerprint) {
    sensitiveDecision = remembered;
    return remembered.trusted;
  }

  const choice = await window.showWarningMessage(
    `This workspace sets SideCar settings that can send your API keys to another server, run programs, ` +
      `or lower approval: ${keys.join(', ')}. Allow them only for repositories you trust. ` +
      `Until you allow them, SideCar uses your own settings instead.`,
    { modal: true },
    'Allow',
    'Block',
  );
  if (choice !== 'Allow' && choice !== 'Block') return false; // dismissed: stay closed, ask again later
  sensitiveDecision = { fingerprint, trusted: choice === 'Allow' };
  await memento?.update(MEMENTO_KEY, sensitiveDecision);
  return sensitiveDecision.trusted;
}

/** Reset all trust decisions (e.g., for testing). */
export function resetWorkspaceTrust(): void {
  trustDecisions.clear();
  sensitiveDecision = null;
}
