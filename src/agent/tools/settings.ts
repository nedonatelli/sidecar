import { workspace, ConfigurationTarget } from 'vscode';
import type { ToolDefinition } from '../../ollama/types.js';
import { BUILT_IN_BACKEND_PROFILES, applyBackendProfile } from '../../config/settings.js';

// Settings tools: read / modify SideCar's own VS Code configuration from
// within an agent turn. The two mutating tools (`switch_backend`,
// `update_setting`) ship with `alwaysRequireApproval: true` in the
// registry, so every call surfaces a modal regardless of approval mode
// or per-tool permission overrides. Nothing about the user's durable
// config changes without an explicit click.
//
// The denylist below is a structural block on top of the approval gate:
// even if the user clicks Allow, these keys stay off-limits. They are
// keys where "allow once, forever" semantics would let a prompt-injected
// agent escalate privileges, bypass security controls, or redirect
// network traffic in a way the user would not reasonably consent to on
// a per-call basis.

/**
 * Setting keys that `update_setting` refuses to touch, grouped by concern:
 *
 *   - secrets           : API keys live in SecretStorage; never exposed
 *   - backend identity  : use `switch_backend` (vetted profile list)
 *   - self-escalation   : tool permissions, custom tools/modes, MCP
 *                         servers, hooks — any of these let the agent
 *                         grant itself new abilities or run arbitrary
 *                         commands on future turns
 *   - exfiltration/prompt: outbound allowlist, system prompt override,
 *                         arbitrary context paths
 *
 * Adding a new security-sensitive setting? Add it here AND update the
 * denylist regression test so the block is intentional.
 */
const DENIED_SETTING_KEYS: ReadonlySet<string> = new Set([
  // secrets
  'apiKey',
  'fallbackApiKey',
  // backend identity — use switch_backend
  'baseUrl',
  'fallbackBaseUrl',
  'provider',
  'delegateTask.workerBaseUrl',
  // self-escalation: permissions, custom executables, hooks
  'toolPermissions',
  'hooks',
  'eventHooks',
  'scheduledTasks',
  'customTools',
  'customModes',
  'mcpServers',
  // exfiltration and base-prompt overrides
  'outboundAllowlist',
  'systemPrompt',
  'pinnedContext',
  'workspaceRoots',
]);

function isDenied(key: string): boolean {
  return DENIED_SETTING_KEYS.has(key);
}

/** Exposed for the denylist regression test. */
export function getDeniedSettingKeys(): ReadonlySet<string> {
  return DENIED_SETTING_KEYS;
}

// ---------------------------------------------------------------------------
// switch_backend
// ---------------------------------------------------------------------------

export const switchBackendDef: ToolDefinition = {
  name: 'switch_backend',
  description:
    'Switch SideCar to a different built-in backend profile. Always requires user approval. ' +
    'Use when the user asks to change the overall backend or provider family ("switch to Claude", "use local Ollama", "go back to Kickstand"). ' +
    'Not for changing the model within a backend — use `update_setting` with key "model" for that. ' +
    'Not for switching to a custom OpenAI-compatible endpoint — that requires changing `baseUrl` + `provider` + `model` together, which is deliberately not exposed and must be done manually by the user. ' +
    'If the target profile has no stored API key, the tool reports that so the user can run "SideCar: Set API Key" before retrying. ' +
    'Example: `switch_backend(profile="anthropic")`.',
  input_schema: {
    type: 'object',
    properties: {
      profile: {
        type: 'string',
        enum: ['local-ollama', 'anthropic', 'openai', 'kickstand'],
        description:
          'Backend profile ID: "local-ollama" (free, private, requires Ollama running locally), "anthropic" (Claude via the Anthropic API, pay-per-token, needs API key), "openai" (GPT models via the OpenAI API, pay-per-token, needs API key), or "kickstand" (self-hosted Kickstand LLM client).',
      },
    },
    required: ['profile'],
  },
};

export async function switchBackend(input: Record<string, unknown>): Promise<string> {
  const profileId = (input.profile as string) || '';
  if (!profileId) return 'Error: profile id is required.';
  const profile = BUILT_IN_BACKEND_PROFILES.find((p) => p.id === profileId);
  if (!profile) {
    const known = BUILT_IN_BACKEND_PROFILES.map((p) => p.id).join(', ');
    return `Unknown backend profile "${profileId}". Known profiles: ${known}.`;
  }
  try {
    const result = await applyBackendProfile(profile);
    return result.message;
  } catch (err) {
    return `Failed to switch backend: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// get_setting
// ---------------------------------------------------------------------------

export const getSettingDef: ToolDefinition = {
  name: 'get_setting',
  description:
    'Read the current value of a SideCar configuration setting. ' +
    'Use when the user asks "what is my current X" or when you need to check config before suggesting a change. ' +
    'Not for reading arbitrary VS Code settings — only keys under `sidecar.*` are exposed. ' +
    'Not for reading secrets — `apiKey` and `fallbackApiKey` are blocked and return an error; API keys live in VS Code SecretStorage and are never exposed to tools. ' +
    'Example: `get_setting(key="model")`, `get_setting(key="dailyBudget")`, `get_setting(key="chatDensity")`, `get_setting(key="jsDocSync.enabled")`.',
  input_schema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description:
          'Setting key without the "sidecar." prefix. Dotted namespaces allowed (e.g. "jsDocSync.enabled", "promptPruning.maxToolResultTokens").',
      },
    },
    required: ['key'],
  },
};

export async function getSetting(input: Record<string, unknown>): Promise<string> {
  const key = (input.key as string) || '';
  if (!key) return 'Error: setting key is required.';
  if (key === 'apiKey' || key === 'fallbackApiKey') {
    return `Error: "${key}" is a secret and cannot be read via this tool. API keys live in VS Code's SecretStorage.`;
  }
  const cfg = workspace.getConfiguration('sidecar');
  const value = cfg.get(key);
  if (value === undefined) {
    return `Setting "sidecar.${key}" is not configured (no value at any scope).`;
  }
  return `sidecar.${key} = ${JSON.stringify(value)}`;
}

// ---------------------------------------------------------------------------
// update_setting
// ---------------------------------------------------------------------------

export const updateSettingDef: ToolDefinition = {
  name: 'update_setting',
  description:
    'Update a SideCar configuration setting at user (global) scope. Always requires user approval — every call surfaces a modal regardless of the active approval mode. ' +
    'Use when the user explicitly asks to change a setting durably ("bump the daily budget to $20", "make the chat compact", "turn off mermaid rendering", "set the shell timeout to 300 seconds"). ' +
    'Not for switching backends — use `switch_backend`, which applies a vetted profile list. ' +
    'Not for one-off tweaks — changes persist across sessions, so only call when the user wants a durable change rather than a temporary override for the current turn. ' +
    'Security-sensitive keys are denied outright (before the approval modal): API keys, tool permissions, custom tools/modes, MCP server definitions, event hooks, scheduled tasks, system prompt override, outbound allowlist, backend URLs, and arbitrary context path lists. The tool reports which categories are blocked. ' +
    'Example: `update_setting(key="dailyBudget", value=20)`, `update_setting(key="chatDensity", value="compact")`, `update_setting(key="enableMermaid", value=false)`, `update_setting(key="promptPruning.enabled", value=true)`.',
  input_schema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Setting key without the "sidecar." prefix. Dotted namespaces allowed (e.g. "jsDocSync.enabled").',
      },
      value: {
        description:
          'New value. Type depends on the setting: boolean for feature flags, number for limits, string for enums, arrays or objects for structured settings. Pass null to clear a setting that accepts it.',
      },
    },
    required: ['key', 'value'],
  },
};

export async function updateSetting(input: Record<string, unknown>): Promise<string> {
  const key = (input.key as string) || '';
  if (!key) return 'Error: setting key is required.';
  if (isDenied(key)) {
    return (
      `Refusing to update "sidecar.${key}" — this setting is on the security denylist ` +
      `(secrets, backend identity, tool permissions, arbitrary command execution, or exfiltration controls). ` +
      `Ask the user to change it manually via VS Code settings if they really want it changed.`
    );
  }
  if (!('value' in input) || input.value === undefined) {
    return 'Error: setting value is required (use null if the setting accepts clearing).';
  }
  const value = input.value;
  const cfg = workspace.getConfiguration('sidecar');
  try {
    await cfg.update(key, value, ConfigurationTarget.Global);
    return `Updated sidecar.${key} = ${JSON.stringify(value)} at user scope. Change is persistent across sessions.`;
  } catch (err) {
    return `Failed to update sidecar.${key}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
