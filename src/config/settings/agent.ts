// ---------------------------------------------------------------------------
// Agent-surface configuration types: MCP servers, per-event hooks,
// scheduled tasks, user-defined custom tools, and custom agent modes.
//
// These types describe user-authored entries in `settings.json` — they
// do not include the SideCarConfig fields that consume them (that
// assembly lives in settings.ts itself). Keeping the types and
// `resolveMode` together here makes the "what can a user declare to
// extend the agent?" surface easy to find and reason about.
// ---------------------------------------------------------------------------

export interface MCPServerConfig {
  /** Transport type: "stdio" (default), "http", or "sse" */
  type?: 'stdio' | 'http' | 'sse';
  /** Command to spawn (stdio transport) */
  command?: string;
  /** Arguments for the command (stdio transport) */
  args?: string[];
  /** Environment variables (stdio transport, or extra headers source) */
  env?: Record<string, string>;
  /** URL for HTTP/SSE transport */
  url?: string;
  /** Custom headers for HTTP/SSE transport */
  headers?: Record<string, string>;
  /** Per-tool overrides: enable/disable specific tools */
  tools?: Record<string, { enabled?: boolean }>;
  /** Maximum result size in characters (default 50000) */
  maxResultChars?: number;
}

export interface HookConfig {
  pre?: string;
  post?: string;
}

export interface ScheduledTask {
  name: string;
  intervalMinutes: number;
  prompt: string;
  enabled: boolean;
  /** Optional list of file paths this task targets; used to check for unsaved edits */
  targetPaths?: string[];
}

export interface EventHookConfig {
  onSave?: string;
  onCreate?: string;
  onDelete?: string;
}

export interface CustomToolConfig {
  name: string;
  description: string;
  command: string;
}

export interface CustomModeConfig {
  name: string;
  description: string;
  systemPrompt: string;
  approvalBehavior: 'autonomous' | 'cautious' | 'manual';
  toolPermissions?: Record<string, 'allow' | 'deny' | 'ask'>;
}

const BUILT_IN_MODES = ['autonomous', 'cautious', 'manual', 'plan', 'review', 'audit'] as const;

/** Resolve an agentMode string to its effective approval behavior, system prompt, and tool permissions. */
export function resolveMode(
  agentMode: string,
  customModes: CustomModeConfig[],
): {
  approvalBehavior: 'autonomous' | 'cautious' | 'manual' | 'plan' | 'review';
  systemPrompt: string;
  toolPermissions: Record<string, 'allow' | 'deny' | 'ask'>;
  isCustom: boolean;
} {
  if ((BUILT_IN_MODES as readonly string[]).includes(agentMode)) {
    // Audit mode is a special case: the approval layer is the audit
    // buffer + user review step, NOT per-tool-call confirmation
    // prompts. So the underlying approvalBehavior is 'autonomous'
    // (agent runs without interruption) and fs writes get intercepted
    // by the AuditBuffer in fs.ts. Surfacing as 'autonomous' downstream
    // keeps executor.ts's ConfirmFn logic simple without teaching
    // ApprovalMode a sixth value.
    if (agentMode === 'audit') {
      return {
        approvalBehavior: 'autonomous',
        systemPrompt: '',
        toolPermissions: {},
        isCustom: false,
      };
    }
    return {
      approvalBehavior: agentMode as 'autonomous' | 'cautious' | 'manual' | 'plan' | 'review',
      systemPrompt: '',
      toolPermissions: {},
      isCustom: false,
    };
  }
  const custom = customModes.find((m) => m.name === agentMode);
  if (custom) {
    return {
      approvalBehavior: custom.approvalBehavior,
      systemPrompt: custom.systemPrompt,
      toolPermissions: custom.toolPermissions || {},
      isCustom: true,
    };
  }
  // Unknown mode — fall back to cautious
  return { approvalBehavior: 'cautious', systemPrompt: '', toolPermissions: {}, isCustom: false };
}
