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
  isGemini,
  detectProvider,
  providerDisplayLabel,
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
  /** Cheaper model used for tool-execution turns in the architect/editor split. Empty = disabled. */
  editorModel: string;
  provider:
    | 'auto'
    | 'ollama'
    | 'anthropic'
    | 'openai'
    | 'kickstand'
    | 'openrouter'
    | 'groq'
    | 'fireworks'
    | 'gemini'
    | 'copilot';
  systemPrompt: string;
  baseUrl: string;
  apiKey: string;
  webSearchProvider: 'duckduckgo' | 'tavily' | 'brave';
  webSearchApiKey: string;
  includeActiveFile: boolean;
  agentMode: string;
  agentTemperature: number;
  ollamaNumCtx: number | null;
  ollamaDisableThinking: boolean;
  agentMaxIterations: number;
  agentMaxMessages: number;
  agentMaxTokens: number;
  enableInlineCompletions: boolean;
  completionModel: string;
  completionDraftModel: string;
  speculativeDecoding: {
    enabled: boolean;
    minAcceptRateToKeepEnabled: number;
  };
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
  firstTokenTimeout: number;
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
  retrievalQueryRewrite: 'off' | 'rule' | 'llm' | 'expand';
  facetsEnabled: boolean;
  facetsMaxConcurrent: number;
  facetsRpcTimeoutMs: number;
  facetsRegistry: string[];
  designMdEnabled: boolean;
  sidecarMdMode: 'full' | 'sections' | 'retrieval';
  sidecarMdRetrievalTopK: number;
  sidecarMdRetrievalMinScore: number;
  sidecarMdAlwaysIncludeHeadings: string[];
  sidecarMdLowPriorityHeadings: string[];
  sidecarMdMaxScopedSections: number;
  forkEnabled: boolean;
  forkDefaultCount: number;
  forkMaxConcurrent: number;
  arenaEnabled: boolean;
  arenaDefaultModels: string[];
  kickstandNCtx: number;
  kickstandRopeFreqBase: number;
  kickstandRopeFreqScale: number;
  kickstandYarnExtFactor: number;
  kickstandYarnOrigCtx: number;
  kickstandFlashAttn: boolean;
  criticEnabled: boolean;
  criticModel: string;
  criticBlockOnHighSeverity: boolean;
  fetchUrlContext: boolean;
  fallbackBaseUrl: string;
  fallbackApiKey: string;
  fallbackModel: string;
  dailyBudget: number;
  weeklyBudget: number;
  /* Role-Based Model Routing */
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
  /* External context providers (GitHub Issues, Linear, Jira) */
  contextProviders: import('../context/types.js').ContextProviderConfig[];
  /* RAG and documentation retrieval */
  enableDocumentationRAG: boolean;
  ragMaxDocEntries: number;
  /* Agent memory and learning */
  enableAgentMemory: boolean;
  agentMemoryMaxEntries: number;
  /* Pinned Memory */
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
  /* Terminal-integrated shell execution */
  terminalExecutionEnabled: boolean;
  terminalExecutionTerminalName: string;
  terminalExecutionFallbackToChildProcess: boolean;
  terminalExecutionShellIntegrationTimeoutMs: number;
  /** Wrap agent shell commands in macOS Seatbelt (sandbox-exec). macOS only; no-op on other platforms. */
  sandboxEnabled: boolean;
  /* Shadow Workspaces */
  shadowWorkspaceMode: 'off' | 'opt-in' | 'always';
  shadowWorkspaceAutoCleanup: boolean;
  shadowWorkspaceGateCommand: string;
  /** Sweep orphan shadow worktrees left behind by a prior VS Code crash at activation.
   *  Default `true`. Disable when doing crash-recovery forensics on your own shadows. */
  shadowWorkspaceSweepOnActivation: boolean;
  /* Audit Mode */
  auditAutoApproveReads: boolean;
  auditBufferGitCommits: boolean;
  /* Project Knowledge Index */
  projectKnowledgeEnabled: boolean;
  projectKnowledgeMaxSymbolsPerFile: number;
  /** Storage backend for the symbol embedding index. `flat` (default) uses
   *  in-memory Float32Array; `lance` uses LanceDB for persistent on-disk
   *  storage — requires `@lancedb/lancedb` installed, falls back to flat
   *  with a warning if the package is absent. */
  projectKnowledgeBackend: 'flat' | 'lance';
  /** Max hops to walk the symbol graph from a direct vector hit (0 = disabled). */
  projectKnowledgeGraphWalkDepth: number;
  /* Skill Sync & Registry */
  /** Git URL (or absolute local folder) cloned into ~/.sidecar/user-skills/ at activation. Empty → disabled. */
  skillsUserRegistry: string;
  /** Array of git URLs, each cloned into ~/.sidecar/team-skills/<slug>/. Empty → no team registries. */
  skillsTeamRegistries: string[];
  /** When to pull configured registries. `on-start` syncs at activation; `hourly`/`daily` add a background schedule; `manual` only on explicit command. */
  skillsAutoPull: 'on-start' | 'hourly' | 'daily' | 'manual';
  /** Registry URLs that skip the first-install trust prompt. Empty by default; unknown registries always prompt. */
  skillsTrustedRegistries: string[];
  /** Air-gapped mode — when `true`, every registry-sync network call is skipped. Cached skills still load. */
  skillsOffline: boolean;
  /**
   * Whether the Merkle-addressed fingerprint layer is active. When on +
   * `projectKnowledgeEnabled` is also on, every symbol mutation mirrors into
   * a hash tree + descent-based query pruning activates. Kept on a separate
   * toggle so retrieval-quality issues can be debugged by disabling Merkle
   * without losing the entire PKI.
   */
  merkleIndexEnabled: boolean;
  /* Diagnostics & Thinking */
  diagnosticsReactiveFixEnabled: boolean;
  diagnosticsReactiveFixDebounceMs: number;
  diagnosticsReactiveFixSeverity: 'error' | 'warning';
  thinkingMode: 'single' | 'self-debate' | 'tree-of-thought' | 'red-team';
  /* Next Edit Suggestions */
  nextEditEnabled: boolean;
  nextEditDebounceMs: number;
  nextEditMaxHops: number;
  nextEditTopK: number;
  nextEditCrossFileEnabled: boolean;
  nextEditModel: string;
  nextEditAutoTriggerOnSave: boolean;
  /* Auto Mode */
  autoModeBacklogPath: string;
  autoModeMaxTasksPerSession: number;
  autoModeMaxRuntimeMinutes: number;
  autoModeHaltOnFailure: boolean;
  autoModeAutoOpenPR: boolean;
  autoModeInterTaskCooldownSeconds: number;
  /* Literature / PDF retrieval */
  literatureEnabled: boolean;
  /* Zotero bridge */
  zoteroUserId: string;
  zoteroApiKey: string;
  zoteroBaseUrl: string;
  /* Database integration */
  databaseProfiles: import('../db/provider.js').ConnectionProfile[];
  databaseQueryTimeoutMs: number;
  databaseQueryRowLimit: number;
  /* Visual verification */
  visualVerifyEnabled: boolean;
  visualVerifyVlm: string;
  visualVerifyScreenshotsDir: string;
  visualVerifyMaxAttempts: number;
  visualVerifyMode: 'strict' | 'warn' | 'advisory';
  visualVerifyCheapChecksOnly: boolean;
  visualVerifyAllowedDomains: string[];
  /* Doc-to-Test Synthesis Loop */
  docTestsEnabled: boolean;
  docTestsOutputDir: string;
  docTestsFloatTolerance: number;
  docTestsExtractionModel: string;
  docTestsRequireConstraintApproval: boolean;
  /* Adaptive Paste */
  adaptivePasteEnabled: boolean;
  adaptivePasteMinPasteLength: number;
  adaptivePasteModel: string;
  adaptivePasteAutoDetect: boolean;
  /* Notebook Mode — Source-Grounded Research */
  notebookModeEnabled: boolean;
  notebookModeRequireCitations: 'strict' | 'advisory' | 'off';
  notebookModeWebUrlEnabled: boolean;
  notebookModeStudyAidsEnabled: boolean;
  /* API call audit log */
  verboseLogs: boolean;
  /* Dependency Drift */
  depsEnabled: boolean;
  depsCheckVulnerabilities: boolean;
  /* Research Assistant */
  researchEnabled: boolean;
  researchActiveProject: string;
  /* Code Profiling */
  profilingEnabled: boolean;
  profilingTopN: number;
  /* Eval history DB */
  evalHistoryEnabled: boolean;
  /* LaTeX Agentic Debugging */
  latexEnabled: boolean;
  latexCompiler: 'latexmk' | 'pdflatex';
  /* Executive Function — task checkpointing */
  executiveFunctionEnabled: boolean;
  /* MCP Task Delegation — delegate_to_mcp tool */
  mcpDelegationEnabled: boolean;
  mcpDelegationAllowedServers: string[];
  /* MCP Agent Server — SideCar as an MCP server */
  mcpServerEnabled: boolean;
  mcpServerPort: number;
  mcpServerRequireAuth: boolean;
  mcpServerAuthToken: string | null;
  mcpServerMaxConcurrent: number;
  /* Zen Mode — RAG hit score filtering */
  zenModeEnabled: boolean;
  zenModeMinScore: number;
  /* Monorepo — cross-package semantic search */
  monorepoEnabled: boolean;
  /* Voice input — Whisper transcription */
  voiceEnabled: boolean;
  voiceModel: string;
  voiceTranscriptionUrl: string;
  /* CI failure analysis — GitHub Actions log fetching + parsing */
  ciAnalysisEnabled: boolean;
  ciAnalysisMaxLogBytes: number;
  ciAnalysisJobFilter: string[];
  /* Branch protection awareness — pre-push guard on protected branches */
  branchProtectionEnabled: boolean;
  branchProtectionWarnEvenIfPassing: boolean;
  codeLensEnabled: boolean;
}

/**
 * Read all SideCar settings from workspace configuration.
 * Results are cached and invalidated automatically when settings change.
 */
let _cachedConfig: SideCarConfig | null = null;

/**
 * Register the configuration-cache invalidation listener.
 * Must be called once from `activate()` so the listener is tied to the
 * extension context and disposed cleanly on deactivation.
 */
export function initConfigWatcher(context: import('vscode').ExtensionContext): void {
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sidecar')) {
        _cachedConfig = null;
      }
    }),
  );
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
    | 'auto'
    | 'ollama'
    | 'anthropic'
    | 'openai'
    | 'kickstand'
    | 'openrouter'
    | 'groq'
    | 'fireworks'
    | 'gemini'
    | 'copilot'
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
    editorModel: cfg.get<string>('editorModel', ''),
    webSearchProvider: cfg.get<'duckduckgo' | 'tavily' | 'brave'>('webSearch.provider', 'duckduckgo'),
    webSearchApiKey: cfg.get<string>('webSearch.apiKey', ''),
    provider: rawProvider,
    systemPrompt: cfg.get<string>('systemPrompt', ''),
    baseUrl: rawBaseUrl,
    apiKey: getCachedApiKey() ?? cfg.get<string>('apiKey', 'ollama'),
    includeActiveFile: cfg.get<boolean>('includeActiveFile', true),
    agentMode: cfg.get<string>('agentMode', 'cautious'),
    agentTemperature: clampMin(cfg.get<number>('agentTemperature'), 0, 0.2),
    ollamaNumCtx: cfg.get<number | null>('ollama.numCtx', null),
    ollamaDisableThinking: cfg.get<boolean>('ollama.disableThinking', process.env.SIDECAR_DISABLE_THINKING === 'true'),
    agentMaxIterations: clampMin(cfg.get<number>('agentMaxIterations'), 1, 50),
    agentMaxMessages: clampMin(cfg.get<number>('agentMaxMessages'), 5, 100),
    agentMaxTokens: clampMin(cfg.get<number>('agentMaxTokens'), 1000, 200000),
    enableInlineCompletions: cfg.get<boolean>('enableInlineCompletions', false),
    completionModel: cfg.get<string>('completionModel', ''),
    completionDraftModel: cfg.get<string>('completionDraftModel', ''),
    speculativeDecoding: {
      enabled: cfg.get<boolean>('speculativeDecoding.enabled', true),
      minAcceptRateToKeepEnabled: Math.min(
        Math.max(cfg.get<number>('speculativeDecoding.minAcceptRateToKeepEnabled', 0.4), 0),
        1,
      ),
    },
    completionMaxTokens: clampMin(cfg.get<number>('completionMaxTokens'), 1, 256),
    completionDebounceMs: clampMin(cfg.get<number>('completionDebounceMs'), 0, 300),
    toolPermissions: cfg.get<Record<string, 'allow' | 'deny' | 'ask'>>('toolPermissions', {}),
    hooks: cfg.get<Record<string, HookConfig>>('hooks', {}),
    eventHooks: cfg.get<EventHookConfig>('eventHooks', {}),
    scheduledTasks: cfg.get<ScheduledTask[]>('scheduledTasks', []),
    customTools: cfg.get<CustomToolConfig[]>('customTools', []),
    customModes: cfg.get<CustomModeConfig[]>('customModes', []),
    mcpServers: cfg.get<Record<string, MCPServerConfig>>('mcpServers', {}),
    verboseMode: cfg.get<boolean>('verboseMode', true),
    expandThinking: cfg.get<boolean>('expandThinking', false),
    enableMermaid: cfg.get<boolean>('enableMermaid', true),
    chatDensity: cfg.get<'compact' | 'normal' | 'comfortable'>('chatDensity', 'normal'),
    chatFontSize: clampMin(cfg.get<number>('chatFontSize'), 10, 13),
    chatAccentColor: cfg.get<string>('chatAccentColor', ''),
    terminalErrorInterception: cfg.get<boolean>('terminalErrorInterception', true),
    jsDocSyncEnabled: cfg.get<boolean>('jsDocSync.enabled', true),
    readmeSyncEnabled: cfg.get<boolean>('readmeSync.enabled', true),
    requestTimeout: clampMin(cfg.get<number>('requestTimeout'), 0, 120),
    firstTokenTimeout: clampMin(cfg.get<number>('firstTokenTimeout'), 0, 300),
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
    multiFileEditsReviewGranularity: cfg.get<'bulk' | 'per-file' | 'per-hunk'>(
      'multiFileEdits.reviewGranularity',
      'per-file',
    ),
    retrievalGraphExpansionEnabled: cfg.get<boolean>('retrieval.graphExpansion.enabled', true),
    retrievalGraphExpansionMaxHits: clampMin(cfg.get<number>('retrieval.graphExpansion.maxHits', 8), 0, 50),
    retrievalQueryRewrite: cfg.get<'off' | 'rule' | 'llm' | 'expand'>('retrieval.queryRewrite', 'rule'),
    facetsEnabled: cfg.get<boolean>('facets.enabled', true),
    facetsMaxConcurrent: clampMin(cfg.get<number>('facets.maxConcurrent', 3), 1, 16),
    facetsRpcTimeoutMs: clampMin(cfg.get<number>('facets.rpcTimeoutMs', 30_000), 1_000, 300_000),
    facetsRegistry: cfg.get<string[]>('facets.registry', []),
    designMdEnabled: cfg.get<boolean>('designMd.enabled', true),
    sidecarMdMode: cfg.get<'full' | 'sections' | 'retrieval'>('sidecarMd.mode', 'sections'),
    sidecarMdRetrievalTopK: clampMin(cfg.get<number>('sidecarMd.retrieval.topK', 5), 1, 20),
    sidecarMdRetrievalMinScore: Math.min(Math.max(cfg.get<number>('sidecarMd.retrieval.minScore', 0.3), 0), 1),
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
    arenaEnabled: cfg.get<boolean>('arena.enabled', true),
    arenaDefaultModels: cfg.get<string[]>('arena.defaultModels', []),
    kickstandNCtx: clampMin(cfg.get<number>('kickstand.nCtx', 32768), 512, 1_000_000),
    kickstandRopeFreqBase: Math.max(cfg.get<number>('kickstand.ropeFreqBase', 0), 0),
    kickstandRopeFreqScale: Math.max(cfg.get<number>('kickstand.ropeFreqScale', 0), 0),
    kickstandYarnExtFactor: cfg.get<number>('kickstand.yarnExtFactor', -1),
    kickstandYarnOrigCtx: Math.max(cfg.get<number>('kickstand.yarnOrigCtx', 0), 0),
    kickstandFlashAttn: cfg.get<boolean>('kickstand.flashAttn', false),
    criticEnabled: cfg.get<boolean>('critic.enabled', false),
    // Provider-aware default: an empty `critic.model` historically meant
    // "use the main model," which doubled per-iteration cost on paid Anthropic
    // backends. If the main model is Sonnet/Opus and the user hasn't explicitly
    // set a critic model, substitute Haiku (~12× cheaper per token). Ollama /
    // OpenAI / etc. keep the legacy "empty → main model" behavior since we
    // don't have a provider-specific cheap model to substitute.
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
    /* Role-Based Model Routing */
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
    /* RAG and documentation retrieval */
    contextProviders: cfg.get<import('../context/types.js').ContextProviderConfig[]>('contextProviders', []),
    enableDocumentationRAG: cfg.get<boolean>('enableDocumentationRAG', true),
    ragMaxDocEntries: clampMin(cfg.get<number>('ragMaxDocEntries'), 1, 20),
    /* Agent memory and learning */
    enableAgentMemory: cfg.get<boolean>('enableAgentMemory', true),
    agentMemoryMaxEntries: clampMin(cfg.get<number>('agentMemoryMaxEntries'), 10, 500),
    /* Pinned Memory */
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
    /* Terminal-integrated shell execution */
    terminalExecutionEnabled: cfg.get<boolean>('terminalExecution.enabled', true),
    terminalExecutionTerminalName: cfg.get<string>('terminalExecution.terminalName', 'SideCar Agent'),
    terminalExecutionFallbackToChildProcess: cfg.get<boolean>('terminalExecution.fallbackToChildProcess', true),
    terminalExecutionShellIntegrationTimeoutMs: clampMin(
      cfg.get<number>('terminalExecution.shellIntegrationTimeoutMs'),
      100,
      2000,
    ),
    sandboxEnabled: cfg.get<boolean>('sandbox.enabled', true),
    /* Shadow Workspaces */
    shadowWorkspaceMode: cfg.get<'off' | 'opt-in' | 'always'>('shadowWorkspace.mode', 'off'),
    shadowWorkspaceAutoCleanup: cfg.get<boolean>('shadowWorkspace.autoCleanup', true),
    shadowWorkspaceGateCommand: cfg.get<string>('shadowWorkspace.gateCommand', 'npm run check'),
    shadowWorkspaceSweepOnActivation: cfg.get<boolean>('shadowWorkspace.sweepStaleOnActivation', true),
    /* Audit Mode */
    auditAutoApproveReads: cfg.get<boolean>('audit.autoApproveReads', true),
    auditBufferGitCommits: cfg.get<boolean>('audit.bufferGitCommits', true),
    /* Project Knowledge Index */
    projectKnowledgeEnabled: cfg.get<boolean>('projectKnowledge.enabled', true),
    projectKnowledgeMaxSymbolsPerFile: cfg.get<number>('projectKnowledge.maxSymbolsPerFile', 500),
    projectKnowledgeBackend: cfg.get<'flat' | 'lance'>('projectKnowledge.backend', 'flat'),
    projectKnowledgeGraphWalkDepth: clampMin(cfg.get<number>('projectKnowledge.graphWalkDepth', 2), 0, 4),
    merkleIndexEnabled: cfg.get<boolean>('merkleIndex.enabled', true),
    /* Skill Sync & Registry */
    skillsUserRegistry: cfg.get<string>('skills.userRegistry', ''),
    skillsTeamRegistries: cfg.get<string[]>('skills.teamRegistries', []),
    skillsAutoPull: cfg.get<'on-start' | 'hourly' | 'daily' | 'manual'>('skills.autoPull', 'on-start'),
    skillsTrustedRegistries: cfg.get<string[]>('skills.trustedRegistries', []),
    skillsOffline: cfg.get<boolean>('skills.offline', false),
    /* Diagnostics & Thinking */
    diagnosticsReactiveFixEnabled: cfg.get<boolean>('diagnostics.reactiveFixEnabled', false),
    diagnosticsReactiveFixDebounceMs: cfg.get<number>('diagnostics.reactiveFixDebounceMs', 2000),
    diagnosticsReactiveFixSeverity: cfg.get<'error' | 'warning'>('diagnostics.reactiveFixSeverity', 'error'),
    thinkingMode: cfg.get<'single' | 'self-debate' | 'tree-of-thought' | 'red-team'>('thinking.mode', 'single'),
    /* Auto Mode */
    autoModeBacklogPath: cfg.get<string>('autoMode.backlogPath', '.sidecar/backlog.md'),
    autoModeMaxTasksPerSession: clampMin(cfg.get<number>('autoMode.maxTasksPerSession'), 1, 10),
    autoModeMaxRuntimeMinutes: clampMin(cfg.get<number>('autoMode.maxRuntimeMinutes'), 1, 240),
    autoModeHaltOnFailure: cfg.get<boolean>('autoMode.haltOnFailure', false),
    autoModeAutoOpenPR: cfg.get<boolean>('autoMode.autoOpenPR', true),
    autoModeInterTaskCooldownSeconds: clampMin(cfg.get<number>('autoMode.interTaskCooldownSeconds'), 0, 30),
    /* Literature / PDF retrieval */
    literatureEnabled: cfg.get<boolean>('literature.enabled', false),
    /* Zotero bridge */
    zoteroUserId: cfg.get<string>('zotero.userId', ''),
    zoteroApiKey: cfg.get<string>('zotero.apiKey', ''),
    zoteroBaseUrl: cfg.get<string>('zotero.baseUrl', 'https://api.zotero.org'),
    /* Database integration */
    databaseProfiles: cfg.get<import('../db/provider.js').ConnectionProfile[]>('databases.profiles', []),
    databaseQueryTimeoutMs: clampMin(cfg.get<number>('databases.queryTimeoutMs'), 1000, 30000),
    databaseQueryRowLimit: clampMin(cfg.get<number>('databases.queryRowLimit'), 1, 10000),
    /* Visual verification */
    visualVerifyEnabled: cfg.get<boolean>('visualVerify.enabled', false),
    visualVerifyVlm: cfg.get<string>('visualVerify.vlm', ''),
    visualVerifyScreenshotsDir: cfg.get<string>('visualVerify.screenshotsDir', '.sidecar/screenshots'),
    visualVerifyMaxAttempts: clampMin(cfg.get<number>('visualVerify.maxAttempts'), 1, 3),
    visualVerifyMode: cfg.get<'strict' | 'warn' | 'advisory'>('visualVerify.mode', 'warn'),
    visualVerifyCheapChecksOnly: cfg.get<boolean>('visualVerify.cheapChecksOnly', false),
    visualVerifyAllowedDomains: cfg.get<string[]>('visualVerify.allowedDomains', []),
    /* Doc-to-Test Synthesis Loop */
    docTestsEnabled: cfg.get<boolean>('docTests.enabled', true),
    docTestsOutputDir: cfg.get<string>('docTests.outputDir', 'tests/from_docs'),
    docTestsFloatTolerance: cfg.get<number>('docTests.floatTolerance', 1e-9),
    docTestsExtractionModel: cfg.get<string>('docTests.extractionModel', ''),
    docTestsRequireConstraintApproval: cfg.get<boolean>('docTests.requireConstraintApproval', true),
    /* Adaptive Paste */
    adaptivePasteEnabled: cfg.get<boolean>('adaptivePaste.enabled', true),
    adaptivePasteMinPasteLength: clampMin(cfg.get<number>('adaptivePaste.minPasteLength'), 20, 50),
    adaptivePasteModel: cfg.get<string>('adaptivePaste.model', ''),
    adaptivePasteAutoDetect: cfg.get<boolean>('adaptivePaste.autoDetect', true),
    /* Next Edit Suggestions */
    nextEditEnabled: cfg.get<boolean>('nextEdit.enabled', false),
    nextEditDebounceMs: clampMin(cfg.get<number>('nextEdit.debounceMs'), 100, 600),
    nextEditMaxHops: clampMin(cfg.get<number>('nextEdit.maxHops'), 1, 2),
    nextEditTopK: clampMin(cfg.get<number>('nextEdit.topK'), 1, 3),
    nextEditCrossFileEnabled: cfg.get<boolean>('nextEdit.crossFileEnabled', true),
    nextEditModel: cfg.get<string>('nextEdit.model', ''),
    nextEditAutoTriggerOnSave: cfg.get<boolean>('nextEdit.autoTriggerOnSave', false),
    /* Notebook Mode — Source-Grounded Research */
    notebookModeEnabled: cfg.get<boolean>('notebookMode.enabled', false),
    notebookModeRequireCitations: cfg.get<'strict' | 'advisory' | 'off'>('notebookMode.requireCitations', 'strict'),
    notebookModeWebUrlEnabled: cfg.get<boolean>('notebookMode.sources.webUrl', true),
    notebookModeStudyAidsEnabled: cfg.get<boolean>('notebookMode.studyAids.enabled', true),
    verboseLogs: cfg.get<boolean>('verboseLogs', false),
    /* Dependency Drift */
    depsEnabled: cfg.get<boolean>('deps.enabled', true),
    depsCheckVulnerabilities: cfg.get<boolean>('deps.checkVulnerabilities', true),
    researchEnabled: cfg.get<boolean>('research.enabled', false),
    researchActiveProject: cfg.get<string>('research.activeProject', ''),
    profilingEnabled: cfg.get<boolean>('profiling.enabled', false),
    profilingTopN: clampMin(cfg.get<number>('profiling.topN', 10), 1, 50),
    evalHistoryEnabled: cfg.get<boolean>('evalHistory.enabled', false),
    latexEnabled: cfg.get<boolean>('latex.enabled', false),
    latexCompiler: cfg.get<'latexmk' | 'pdflatex'>('latex.compiler', 'latexmk'),
    executiveFunctionEnabled: cfg.get<boolean>('executiveFunction.enabled', true),
    /* MCP Task Delegation */
    mcpDelegationEnabled: cfg.get<boolean>('mcpDelegation.enabled', false),
    mcpDelegationAllowedServers: cfg.get<string[]>('mcpDelegation.allowedServers', []),
    /* MCP Agent Server */
    mcpServerEnabled: cfg.get<boolean>('mcpServer.enabled', false),
    mcpServerPort: clampMin(cfg.get<number>('mcpServer.port'), 1024, 3457),
    mcpServerRequireAuth: cfg.get<boolean>('mcpServer.requireAuth', false),
    mcpServerAuthToken: cfg.get<string>('mcpServer.authToken', '') || null,
    mcpServerMaxConcurrent: clampMin(cfg.get<number>('mcpServer.maxConcurrent'), 1, 1),
    zenModeEnabled: cfg.get<boolean>('zenMode.enabled', false),
    zenModeMinScore: clampMin(cfg.get<number>('zenMode.minScore'), 0, 0.35),
    monorepoEnabled: cfg.get<boolean>('monorepo.enabled', true),
    voiceEnabled: cfg.get<boolean>('voice.enabled', false),
    voiceModel: cfg.get<string>('voice.model', 'Xenova/whisper-tiny'),
    voiceTranscriptionUrl: cfg.get<string>('voice.transcriptionUrl', ''),
    ciAnalysisEnabled: cfg.get<boolean>('ci.analysis.enabled', true),
    ciAnalysisMaxLogBytes: Math.max(100_000, cfg.get<number>('ci.analysis.maxLogBytes', 4_000_000)),
    ciAnalysisJobFilter: cfg.get<string[]>('ci.analysis.jobFilter', ['*']),
    branchProtectionEnabled: cfg.get<boolean>('pr.branchProtection.enabled', true),
    branchProtectionWarnEvenIfPassing: cfg.get<boolean>('pr.branchProtection.warnEvenIfPassing', false),
    codeLensEnabled: cfg.get<boolean>('codeLens.enabled', true),
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
