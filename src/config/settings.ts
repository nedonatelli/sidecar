import { workspace } from 'vscode';
import { getCachedApiKey, getCachedFallbackApiKey } from './settings/secrets.js';
import { OLLAMA_DEFAULT_MODEL, ANTHROPIC_DEFAULT_MODEL, detectProvider } from './settings/backends.js';
import type { RoutingRule } from '../ollama/modelRouter.js';

// Re-export the public SecretStorage API from its extracted module so
// every existing `import { initSecrets, ... } from '../config/settings.js'`
// keeps working unchanged. The implementation lives in ./settings/secrets.ts.
export {
  initSecrets,
  setApiKeySecret,
  setFallbackApiKeySecret,
  getHuggingFaceToken,
  setHuggingFaceToken,
  clearHuggingFaceToken,
} from './settings/secrets.js';

// Backend profiles + provider detection live in ./settings/backends.ts;
// re-exported here so existing import sites stay unchanged.
export type { BackendProfile } from './settings/backends.js';
export {
  OLLAMA_DEFAULT_MODEL,
  ANTHROPIC_DEFAULT_MODEL,
  BUILT_IN_BACKEND_PROFILES,
  detectActiveProfile,
  applyBackendProfile,
  setProfileApiKey,
  isLocalOllama,
  isAnthropic,
  isKickstand,
  isOpenRouter,
  isGroq,
  isFireworks,
  detectProvider,
} from './settings/backends.js';

// ---------------------------------------------------------------------------
// Typed configuration
// ---------------------------------------------------------------------------

// Agent-surface types (MCP, hooks, modes) live in ./settings/agent.ts;
// import for internal use + re-export so existing imports keep working.
import type {
  MCPServerConfig,
  HookConfig,
  ScheduledTask,
  EventHookConfig,
  CustomToolConfig,
  CustomModeConfig,
} from './settings/agent.js';

export type { MCPServerConfig, HookConfig, ScheduledTask, EventHookConfig, CustomToolConfig, CustomModeConfig };

export { resolveMode } from './settings/agent.js';

export interface SideCarConfig {
  model: string;
  provider: 'auto' | 'ollama' | 'anthropic' | 'openai' | 'kickstand' | 'openrouter' | 'groq' | 'fireworks';
  systemPrompt: string;
  baseUrl: string;
  apiKey: string;
  includeActiveFile: boolean;
  agentMode: string;
  agentTemperature: number;
  agentMaxIterations: number;
  agentMaxMessages: number;
  agentMaxTokens: number;
  enableInlineCompletions: boolean;
  completionModel: string;
  completionDraftModel: string;
  completionMaxTokens: number;
  completionDebounceMs: number;
  toolPermissions: Record<string, 'allow' | 'deny' | 'ask'>;
  hooks: Record<string, HookConfig>;
  eventHooks: EventHookConfig;
  scheduledTasks: ScheduledTask[];
  customTools: CustomToolConfig[];
  customModes: CustomModeConfig[];
  mcpServers: Record<string, MCPServerConfig>;
  verboseMode: boolean;
  expandThinking: boolean;
  enableMermaid: boolean;
  chatDensity: 'compact' | 'normal' | 'comfortable';
  chatFontSize: number;
  chatAccentColor: string;
  terminalErrorInterception: boolean;
  jsDocSyncEnabled: boolean;
  readmeSyncEnabled: boolean;
  requestTimeout: number;
  shellTimeout: number;
  shellMaxOutputMB: number;
  pinnedContext: string[];
  autoFixOnFailure: boolean;
  autoFixMaxRetries: number;
  completionGateEnabled: boolean;
  steerQueueCoalesceWindowMs: number;
  steerQueueMaxPending: number;
  multiFileEditsEnabled: boolean;
  multiFileEditsMaxParallel: number;
  multiFileEditsPlanningPass: boolean;
  multiFileEditsMinFilesForPlan: number;
  multiFileEditsPlannerModel: string;
  multiFileEditsReviewGranularity: 'bulk' | 'per-file' | 'per-hunk';
  retrievalGraphExpansionEnabled: boolean;
  retrievalGraphExpansionMaxHits: number;
  facetsEnabled: boolean;
  facetsMaxConcurrent: number;
  facetsRpcTimeoutMs: number;
  facetsRegistry: string[];
  sidecarMdMode: 'full' | 'sections';
  sidecarMdAlwaysIncludeHeadings: string[];
  sidecarMdLowPriorityHeadings: string[];
  sidecarMdMaxScopedSections: number;
  forkEnabled: boolean;
  forkDefaultCount: number;
  forkMaxConcurrent: number;
  kickstandNCtx: number;
  criticEnabled: boolean;
  criticModel: string;
  criticBlockOnHighSeverity: boolean;
  fetchUrlContext: boolean;
  fallbackBaseUrl: string;
  fallbackApiKey: string;
  fallbackModel: string;
  dailyBudget: number;
  weeklyBudget: number;
  /* Role-Based Model Routing (v0.64) */
  modelRoutingEnabled: boolean;
  modelRoutingRules: RoutingRule[];
  /** Fallback when no rule matches. Empty string → use `model`. */
  modelRoutingDefaultModel: string;
  /** Show a brief toast on every role-triggered model swap. */
  modelRoutingVisibleSwaps: boolean;
  /** Log what would have been routed but dispatch using `model` anyway — for calibration. */
  modelRoutingDryRun: boolean;
  /* Large file & monorepo handling */
  workspaceRoots: string[];
  maxFileSizeBytes: number;
  streamingReadThreshold: number;
  maxTraversalDepth: number;
  enableLazyIndexing: boolean;
  maxIndexedFiles: number;
  /* RAG and documentation retrieval */
  enableDocumentationRAG: boolean;
  ragMaxDocEntries: number;
  ragUpdateIntervalMinutes: number;
  /* Agent memory and learning */
  enableAgentMemory: boolean;
  agentMemoryMaxEntries: number;
  /* Pinned Memory (v0.72) */
  pinnedMemoryEnabled: boolean;
  pinnedMemoryMaxPins: number;
  pinnedMemoryMaxCharsPerPin: number;
  /* Semantic search */
  enableSemanticSearch: boolean;
  semanticSearchWeight: number;
  /* Background agents */
  bgMaxConcurrent: number;
  /* Prompt pruning (paid backends) */
  promptPruningEnabled: boolean;
  promptPruningMaxToolResultTokens: number;
  /* Hybrid delegation to local Ollama worker (paid backends only) */
  delegateTaskEnabled: boolean;
  delegateTaskWorkerModel: string;
  delegateTaskWorkerBaseUrl: string;
  /**
   * Hard cap on iterations a delegated worker agent may run. The
   * worker is intentionally focused on read-only research, so a
   * tight cap protects against runaway loops. The main agent loop
   * uses `agentMaxIterations` instead.
   */
  delegateTaskMaxIterations: number;
  /* Outbound exfiltration defense */
  outboundAllowlist: string[];
  /* Terminal-integrated shell execution for run_command (v0.59) */
  terminalExecutionEnabled: boolean;
  terminalExecutionTerminalName: string;
  terminalExecutionFallbackToChildProcess: boolean;
  terminalExecutionShellIntegrationTimeoutMs: number;
  /* Shadow Workspaces (v0.59) */
  shadowWorkspaceMode: 'off' | 'opt-in' | 'always';
  shadowWorkspaceAutoCleanup: boolean;
  shadowWorkspaceGateCommand: string;
  /** v0.62.1 p.3 — sweep orphan shadow worktrees left behind by a
   *  prior VS Code crash at activation. Default `true`. Disable
   *  when doing crash-recovery forensics on your own shadows. */
  shadowWorkspaceSweepOnActivation: boolean;
  /* Audit Mode (v0.60) */
  auditAutoApproveReads: boolean;
  auditBufferGitCommits: boolean;
  /* Project Knowledge Index (v0.61 b.*) */
  projectKnowledgeEnabled: boolean;
  projectKnowledgeMaxSymbolsPerFile: number;
  /** Storage backend for the symbol embedding index (v0.62 c.2).
   *  `flat` is the only implementation shipped today; `lance`
   *  reserves the name for a future release and returns a clear
   *  "not yet implemented" warning when selected. */
  projectKnowledgeBackend: 'flat' | 'lance';
  /* Skill Sync & Registry (v0.64 chunk 6) */
  /** Git URL (or absolute local folder) cloned into ~/.sidecar/user-skills/ at activation. Empty → disabled. */
  skillsUserRegistry: string;
  /** Array of git URLs, each cloned into ~/.sidecar/team-skills/<slug>/. Empty → no team registries. */
  skillsTeamRegistries: string[];
  /** When to pull configured registries. `on-start` syncs on every activation; `manual` only on explicit command. */
  skillsAutoPull: 'on-start' | 'manual';
  /** Registry URLs that skip the first-install trust prompt. Empty by default; unknown registries always prompt. */
  skillsTrustedRegistries: string[];
  /** Air-gapped mode — when `true`, every registry-sync network call is skipped. Cached skills still load. */
  skillsOffline: boolean;
  /**
   * Whether the Merkle-addressed fingerprint layer is active
   * (v0.62 d.2+). When on + `projectKnowledgeEnabled` is also on,
   * every symbol mutation mirrors into a hash tree + descent-based
   * query pruning activates. The two are architecturally coupled
   * per the ROADMAP but kept on separate toggles so a user can
   * debug retrieval-quality issues by disabling Merkle without
   * losing the entire PKI.
   */
  merkleIndexEnabled: boolean;
  /* Diagnostics & Thinking (v0.71) */
  diagnosticsReactiveFixEnabled: boolean;
  diagnosticsReactiveFixDebounceMs: number;
  diagnosticsReactiveFixSeverity: 'error' | 'warning';
  thinkingMode: 'single' | 'self-debate' | 'tree-of-thought' | 'red-team';
  /* Next Edit Suggestions (v0.72) */
  nextEditEnabled: boolean;
  nextEditDebounceMs: number;
  nextEditMaxHops: number;
  nextEditTopK: number;
  nextEditCrossFileEnabled: boolean;
  nextEditModel: string;
  nextEditAutoTriggerOnSave: boolean;
  /* Auto Mode (v0.73) */
  autoModeBacklogPath: string;
  autoModeMaxTasksPerSession: number;
  autoModeMaxRuntimeMinutes: number;
  autoModeHaltOnFailure: boolean;
  autoModeAutoOpenPR: boolean;
  autoModeInterTaskCooldownSeconds: number;
  /* Adaptive Paste (v0.72) */
  adaptivePasteEnabled: boolean;
  adaptivePasteMinPasteLength: number;
  adaptivePasteModel: string;
  adaptivePasteAutoDetect: boolean;
}

/**
 * Read all SideCar settings from workspace configuration.
 * Results are cached and invalidated automatically when settings change.
 */
let _cachedConfig: SideCarConfig | null = null;

// Invalidate cache when VS Code settings change.
// Guard for test environments where workspace API may not be fully available.
try {
  workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('sidecar')) {
      _cachedConfig = null;
    }
  });
} catch {
  // Not in a VS Code environment (e.g., unit tests) — cache will be rebuilt on each call
}

/** Clamp a number to a minimum value, falling back to the default if invalid. */
export function clampMin(value: number | undefined, min: number, fallback: number): number {
  if (value === undefined || typeof value !== 'number' || isNaN(value)) return fallback;
  return Math.max(min, value);
}

function readConfig(): SideCarConfig {
  const cfg = workspace.getConfiguration('sidecar');
  const rawModel = cfg.get<string>('model', OLLAMA_DEFAULT_MODEL) || OLLAMA_DEFAULT_MODEL;
  const rawProvider = cfg.get<
    'auto' | 'ollama' | 'anthropic' | 'openai' | 'kickstand' | 'openrouter' | 'groq' | 'fireworks'
  >('provider', 'auto');
  const rawBaseUrl = cfg.get<string>('baseUrl', 'http://localhost:11434') || 'http://localhost:11434';
  // Provider-aware default: if the user switched provider to Anthropic but left
  // the model field at the shipped Ollama default, use Haiku (cheapest valid
  // Anthropic model) instead of sending an invalid qwen3 name to Anthropic.
  const model =
    rawModel === OLLAMA_DEFAULT_MODEL && detectProvider(rawBaseUrl, rawProvider) === 'anthropic'
      ? ANTHROPIC_DEFAULT_MODEL
      : rawModel;
  return {
    model,
    provider: rawProvider,
    systemPrompt: cfg.get<string>('systemPrompt', ''),
    baseUrl: rawBaseUrl,
    apiKey: getCachedApiKey() ?? cfg.get<string>('apiKey', 'ollama'),
    includeActiveFile: cfg.get<boolean>('includeActiveFile', true),
    agentMode: cfg.get<string>('agentMode', 'cautious'),
    agentTemperature: clampMin(cfg.get<number>('agentTemperature'), 0, 0.2),
    agentMaxIterations: clampMin(cfg.get<number>('agentMaxIterations'), 1, 50),
    agentMaxMessages: clampMin(cfg.get<number>('agentMaxMessages'), 5, 100),
    agentMaxTokens: clampMin(cfg.get<number>('agentMaxTokens'), 1000, 200000),
    enableInlineCompletions: cfg.get<boolean>('enableInlineCompletions', false),
    completionModel: cfg.get<string>('completionModel', ''),
    completionDraftModel: cfg.get<string>('completionDraftModel', ''),
    completionMaxTokens: clampMin(cfg.get<number>('completionMaxTokens'), 1, 256),
    completionDebounceMs: clampMin(cfg.get<number>('completionDebounceMs'), 0, 300),
    toolPermissions: cfg.get<Record<string, 'allow' | 'deny' | 'ask'>>('toolPermissions', {}),
    hooks: cfg.get<Record<string, HookConfig>>('hooks', {}),
    eventHooks: cfg.get<EventHookConfig>('eventHooks', {}),
    scheduledTasks: cfg.get<ScheduledTask[]>('scheduledTasks', []),
    customTools: cfg.get<CustomToolConfig[]>('customTools', []),
    customModes: cfg.get<CustomModeConfig[]>('customModes', []),
    mcpServers: cfg.get<Record<string, MCPServerConfig>>('mcpServers', {}),
    verboseMode: cfg.get<boolean>('verboseMode', false),
    expandThinking: cfg.get<boolean>('expandThinking', false),
    enableMermaid: cfg.get<boolean>('enableMermaid', true),
    chatDensity: cfg.get<'compact' | 'normal' | 'comfortable'>('chatDensity', 'normal'),
    chatFontSize: clampMin(cfg.get<number>('chatFontSize'), 10, 13),
    chatAccentColor: cfg.get<string>('chatAccentColor', ''),
    terminalErrorInterception: cfg.get<boolean>('terminalErrorInterception', true),
    jsDocSyncEnabled: cfg.get<boolean>('jsDocSync.enabled', true),
    readmeSyncEnabled: cfg.get<boolean>('readmeSync.enabled', true),
    requestTimeout: clampMin(cfg.get<number>('requestTimeout'), 0, 120),
    shellTimeout: clampMin(cfg.get<number>('shellTimeout'), 1, 120),
    shellMaxOutputMB: clampMin(cfg.get<number>('shellMaxOutputMB'), 1, 10),
    pinnedContext: cfg.get<string[]>('pinnedContext', []),
    autoFixOnFailure: cfg.get<boolean>('autoFixOnFailure', false),
    autoFixMaxRetries: clampMin(cfg.get<number>('autoFixMaxRetries'), 0, 3),
    completionGateEnabled: cfg.get<boolean>('completionGate.enabled', true),
    steerQueueCoalesceWindowMs: clampMin(cfg.get<number>('steerQueue.coalesceWindowMs', 2000), 0, 10_000),
    steerQueueMaxPending: clampMin(cfg.get<number>('steerQueue.maxPending', 5), 1, 20),
    multiFileEditsEnabled: cfg.get<boolean>('multiFileEdits.enabled', true),
    multiFileEditsMaxParallel: clampMin(cfg.get<number>('multiFileEdits.maxParallel', 8), 1, 32),
    multiFileEditsPlanningPass: cfg.get<boolean>('multiFileEdits.planningPass', true),
    multiFileEditsMinFilesForPlan: clampMin(cfg.get<number>('multiFileEdits.minFilesForPlan', 3), 2, 50),
    multiFileEditsPlannerModel: cfg.get<string>('multiFileEdits.plannerModel', ''),
    multiFileEditsReviewGranularity: cfg.get<string>('multiFileEdits.reviewGranularity', 'per-file') as
      | 'bulk'
      | 'per-file'
      | 'per-hunk',
    retrievalGraphExpansionEnabled: cfg.get<boolean>('retrieval.graphExpansion.enabled', true),
    retrievalGraphExpansionMaxHits: clampMin(cfg.get<number>('retrieval.graphExpansion.maxHits', 8), 0, 50),
    facetsEnabled: cfg.get<boolean>('facets.enabled', true),
    facetsMaxConcurrent: clampMin(cfg.get<number>('facets.maxConcurrent', 3), 1, 16),
    facetsRpcTimeoutMs: clampMin(cfg.get<number>('facets.rpcTimeoutMs', 30_000), 1_000, 300_000),
    facetsRegistry: cfg.get<string[]>('facets.registry', []),
    sidecarMdMode: cfg.get<'full' | 'sections'>('sidecarMd.mode', 'sections'),
    sidecarMdAlwaysIncludeHeadings: cfg.get<string[]>('sidecarMd.alwaysIncludeHeadings', [
      'Build',
      'Conventions',
      'Setup',
    ]),
    sidecarMdLowPriorityHeadings: cfg.get<string[]>('sidecarMd.lowPriorityHeadings', ['Glossary', 'FAQ', 'Changelog']),
    sidecarMdMaxScopedSections: clampMin(cfg.get<number>('sidecarMd.maxScopedSections', 5), 1, 50),
    forkEnabled: cfg.get<boolean>('fork.enabled', true),
    forkDefaultCount: clampMin(cfg.get<number>('fork.defaultCount', 3), 2, 10),
    forkMaxConcurrent: clampMin(cfg.get<number>('fork.maxConcurrent', 3), 1, 10),
    kickstandNCtx: clampMin(cfg.get<number>('kickstand.nCtx', 32768), 512, 1_000_000),
    criticEnabled: cfg.get<boolean>('critic.enabled', false),
    // v0.62.1 p.1a: provider-aware default. An empty `critic.model`
    // historically meant "use the main model," which doubled per-
    // iteration cost on paid Anthropic backends. If the main model
    // is Sonnet/Opus and the user hasn't explicitly set a critic
    // model, we substitute Haiku (~12× cheaper per token) — same
    // pattern used for the main-model switch-provider fallback above.
    // Ollama / OpenAI / etc. keep the legacy "empty → main model"
    // behavior because we don't have a provider-specific cheap model
    // to substitute.
    criticModel:
      cfg.get<string>('critic.model', '') ||
      (detectProvider(rawBaseUrl, rawProvider) === 'anthropic' && model !== ANTHROPIC_DEFAULT_MODEL
        ? ANTHROPIC_DEFAULT_MODEL
        : ''),
    criticBlockOnHighSeverity: cfg.get<boolean>('critic.blockOnHighSeverity', true),
    fetchUrlContext: cfg.get<boolean>('fetchUrlContext', true),
    fallbackBaseUrl: cfg.get<string>('fallbackBaseUrl', ''),
    fallbackApiKey: getCachedFallbackApiKey() ?? cfg.get<string>('fallbackApiKey', ''),
    fallbackModel: cfg.get<string>('fallbackModel', ''),
    dailyBudget: clampMin(cfg.get<number>('dailyBudget'), 0, 0),
    weeklyBudget: clampMin(cfg.get<number>('weeklyBudget'), 0, 0),
    /* Role-Based Model Routing (v0.64) — opt-in until users have calibrated rules. */
    modelRoutingEnabled: cfg.get<boolean>('modelRouting.enabled', false),
    modelRoutingRules: cfg.get<RoutingRule[]>('modelRouting.rules', []),
    modelRoutingDefaultModel: cfg.get<string>('modelRouting.defaultModel', ''),
    modelRoutingVisibleSwaps: cfg.get<boolean>('modelRouting.visibleSwaps', true),
    modelRoutingDryRun: cfg.get<boolean>('modelRouting.dryRun', false),
    /* Large file & monorepo handling */
    workspaceRoots: cfg.get<string[]>('workspaceRoots', []),
    maxFileSizeBytes: clampMin(cfg.get<number>('maxFileSizeBytes'), 10240, 100 * 1024),
    streamingReadThreshold: clampMin(cfg.get<number>('streamingReadThreshold'), 10240, 50 * 1024),
    maxTraversalDepth: clampMin(cfg.get<number>('maxTraversalDepth'), 1, 10),
    enableLazyIndexing: cfg.get<boolean>('enableLazyIndexing', true),
    maxIndexedFiles: clampMin(cfg.get<number>('maxIndexedFiles'), 10, 1000),
    /* RAG and documentation retrieval */
    enableDocumentationRAG: cfg.get<boolean>('enableDocumentationRAG', true),
    ragMaxDocEntries: clampMin(cfg.get<number>('ragMaxDocEntries'), 1, 20),
    ragUpdateIntervalMinutes: clampMin(cfg.get<number>('ragUpdateIntervalMinutes'), 5, 360),
    /* Agent memory and learning */
    enableAgentMemory: cfg.get<boolean>('enableAgentMemory', true),
    agentMemoryMaxEntries: clampMin(cfg.get<number>('agentMemoryMaxEntries'), 10, 500),
    /* Pinned Memory (v0.72) */
    pinnedMemoryEnabled: cfg.get<boolean>('pinnedMemory.enabled', true),
    pinnedMemoryMaxPins: clampMin(cfg.get<number>('pinnedMemory.maxPins'), 1, 50),
    pinnedMemoryMaxCharsPerPin: clampMin(cfg.get<number>('pinnedMemory.maxCharsPerPin'), 500, 5000),
    /* Semantic search */
    enableSemanticSearch: cfg.get<boolean>('enableSemanticSearch', true),
    semanticSearchWeight: Math.max(0, Math.min(1, cfg.get<number>('semanticSearchWeight', 0.6))),
    bgMaxConcurrent: clampMin(cfg.get<number>('bgMaxConcurrent'), 1, 3),
    /* Prompt pruning (paid backends) */
    promptPruningEnabled: cfg.get<boolean>('promptPruning.enabled', true),
    promptPruningMaxToolResultTokens: clampMin(cfg.get<number>('promptPruning.maxToolResultTokens'), 200, 4000),
    /* Hybrid delegation to local Ollama worker */
    delegateTaskEnabled: cfg.get<boolean>('delegateTask.enabled', true),
    delegateTaskWorkerModel: cfg.get<string>('delegateTask.workerModel', ''),
    delegateTaskWorkerBaseUrl: cfg.get<string>('delegateTask.workerBaseUrl', 'http://localhost:11434'),
    delegateTaskMaxIterations: clampMin(cfg.get<number>('delegateTask.maxIterations'), 1, 10),
    /* Outbound exfiltration defense */
    outboundAllowlist: cfg.get<string[]>('outboundAllowlist', []),
    /* Terminal-integrated shell execution (v0.59) */
    terminalExecutionEnabled: cfg.get<boolean>('terminalExecution.enabled', true),
    terminalExecutionTerminalName: cfg.get<string>('terminalExecution.terminalName', 'SideCar Agent'),
    terminalExecutionFallbackToChildProcess: cfg.get<boolean>('terminalExecution.fallbackToChildProcess', true),
    terminalExecutionShellIntegrationTimeoutMs: clampMin(
      cfg.get<number>('terminalExecution.shellIntegrationTimeoutMs'),
      100,
      2000,
    ),
    /* Shadow Workspaces (v0.59) */
    shadowWorkspaceMode: cfg.get<'off' | 'opt-in' | 'always'>('shadowWorkspace.mode', 'off'),
    shadowWorkspaceAutoCleanup: cfg.get<boolean>('shadowWorkspace.autoCleanup', true),
    shadowWorkspaceGateCommand: cfg.get<string>('shadowWorkspace.gateCommand', 'npm run check'),
    shadowWorkspaceSweepOnActivation: cfg.get<boolean>('shadowWorkspace.sweepStaleOnActivation', true),
    /* Audit Mode (v0.60) */
    auditAutoApproveReads: cfg.get<boolean>('audit.autoApproveReads', true),
    auditBufferGitCommits: cfg.get<boolean>('audit.bufferGitCommits', true),
    /* Project Knowledge Index (v0.61 b.*). Defaults to `false` during
     * the MVP build-out — flips to `true` once the feature ships
     * end-to-end (b.1–b.4). Users can opt-in early to exercise the
     * symbol-level index. */
    projectKnowledgeEnabled: cfg.get<boolean>('projectKnowledge.enabled', true),
    projectKnowledgeMaxSymbolsPerFile: cfg.get<number>('projectKnowledge.maxSymbolsPerFile', 500),
    projectKnowledgeBackend: cfg.get<'flat' | 'lance'>('projectKnowledge.backend', 'flat'),
    merkleIndexEnabled: cfg.get<boolean>('merkleIndex.enabled', true),
    /* Skill Sync & Registry (v0.64 chunk 6) */
    skillsUserRegistry: cfg.get<string>('skills.userRegistry', ''),
    skillsTeamRegistries: cfg.get<string[]>('skills.teamRegistries', []),
    skillsAutoPull: cfg.get<'on-start' | 'manual'>('skills.autoPull', 'on-start'),
    skillsTrustedRegistries: cfg.get<string[]>('skills.trustedRegistries', []),
    skillsOffline: cfg.get<boolean>('skills.offline', false),
    /* Diagnostics & Thinking (v0.71) */
    diagnosticsReactiveFixEnabled: cfg.get<boolean>('diagnostics.reactiveFixEnabled', false),
    diagnosticsReactiveFixDebounceMs: cfg.get<number>('diagnostics.reactiveFixDebounceMs', 2000),
    diagnosticsReactiveFixSeverity: cfg.get<'error' | 'warning'>('diagnostics.reactiveFixSeverity', 'error'),
    thinkingMode: cfg.get<'single' | 'self-debate' | 'tree-of-thought' | 'red-team'>('thinking.mode', 'single'),
    /* Auto Mode (v0.73) */
    autoModeBacklogPath: cfg.get<string>('autoMode.backlogPath', '.sidecar/backlog.md'),
    autoModeMaxTasksPerSession: clampMin(cfg.get<number>('autoMode.maxTasksPerSession'), 1, 10),
    autoModeMaxRuntimeMinutes: clampMin(cfg.get<number>('autoMode.maxRuntimeMinutes'), 1, 240),
    autoModeHaltOnFailure: cfg.get<boolean>('autoMode.haltOnFailure', false),
    autoModeAutoOpenPR: cfg.get<boolean>('autoMode.autoOpenPR', true),
    autoModeInterTaskCooldownSeconds: clampMin(cfg.get<number>('autoMode.interTaskCooldownSeconds'), 0, 30),
    /* Adaptive Paste (v0.72) */
    adaptivePasteEnabled: cfg.get<boolean>('adaptivePaste.enabled', true),
    adaptivePasteMinPasteLength: clampMin(cfg.get<number>('adaptivePaste.minPasteLength'), 20, 50),
    adaptivePasteModel: cfg.get<string>('adaptivePaste.model', ''),
    adaptivePasteAutoDetect: cfg.get<boolean>('adaptivePaste.autoDetect', true),
    /* Next Edit Suggestions (v0.72) */
    nextEditEnabled: cfg.get<boolean>('nextEdit.enabled', false),
    nextEditDebounceMs: clampMin(cfg.get<number>('nextEdit.debounceMs'), 100, 600),
    nextEditMaxHops: clampMin(cfg.get<number>('nextEdit.maxHops'), 1, 2),
    nextEditTopK: clampMin(cfg.get<number>('nextEdit.topK'), 1, 3),
    nextEditCrossFileEnabled: cfg.get<boolean>('nextEdit.crossFileEnabled', true),
    nextEditModel: cfg.get<string>('nextEdit.model', ''),
    nextEditAutoTriggerOnSave: cfg.get<boolean>('nextEdit.autoTriggerOnSave', false),
  };
}

export function getConfig(): SideCarConfig {
  if (!_cachedConfig) {
    _cachedConfig = readConfig();
  }
  return _cachedConfig;
}

/**
 * Drop the memoized config so the next `getConfig()` re-reads via
 * `workspace.getConfiguration`. Exported for the SecretStorage helpers
 * in ./settings/secrets.ts, which invalidate the cache whenever an API
 * key changes so the next read picks up the new value. Production code
 * also invalidates via the `onDidChangeConfiguration` listener above.
 */
export function invalidateConfigCache(): void {
  _cachedConfig = null;
}

/** Test-only alias for invalidateConfigCache — preserved for existing tests. */
export function __resetConfigCacheForTests(): void {
  _cachedConfig = null;
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------
// Implementation lives in ./settings/costs.ts. Re-exported here so every
// `import { estimateCost, ... } from '../config/settings.js'` keeps working.

export {
  registerModelCost,
  ingestOpenRouterCatalog,
  estimateCost,
  _resetUnknownModelWarnings,
  _resetRuntimeModelCosts,
} from './settings/costs.js';
