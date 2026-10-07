/**
 * Chat message handling — thin orchestrator.
 *
 * The bulk of the logic has been extracted into focused submodules:
 *   - messageUtils.ts        — continuation detection, error classification, relevance
 *   - systemPrompt.ts        — base prompt, context injection, message enrichment
 *   - fileHandlers.ts        — file attach/drop/save/create/move/undo/revert
 *   - connectionHandlers.ts  — provider connection, retry, restart, reconnect
 *   - chatUtilHandlers.ts    — show prompt, delete message, export chat, image messages
 *   - generateHandlers.ts    — commit generation, selective section regen
 *
 * This file keeps:
 *   - handleUserMessage (the core agent-loop orchestrator)
 *   - handleReconnect (calls handleUserMessage — must be co-located)
 *   - handleRegenerateResponse (calls handleUserMessage — must be co-located)
 *   - Budget / cost helpers (called at start + end of handleUserMessage)
 *   - Re-exports from all submodules for backward compatibility
 */

import type { ChatState } from '../chatState.js';
import type { ChatMessage } from '../../ollama/types.js';
import { logger } from '../../system/logger.js';
import { getConfig, estimateCost, resolveMode } from '../../config/settings.js';
import { parseModelSentinel } from '../../ollama/modelSentinels.js';
import {
  DEFAULT_MAX_SYSTEM_CHARS,
  contextCapForModel,
  LOCAL_MAX_SYSTEM_CHARS,
  INPUT_TOKEN_RATIO,
} from '../../config/constants.js';
import { tokensToChars, estimateTokensFromText } from '../../config/tokenEstimation.js';
import { surfaceNativeToast } from '../errorSurface.js';
import { healthStatus } from '../../ollama/healthStatus.js';
import { getWorkspaceRoot, getContextLimit } from '../../config/workspace.js';
import { runAgentLoop, type AgentOptions } from '../../agent/loop.js';
import { SteerQueue } from '../../agent/steerQueue.js';
import type { ApprovalMode } from '../../agent/executor.js';
import { computeUnifiedDiff } from '../../agent/diff.js';

// --- Submodule re-exports for backward compatibility ---
// External callers (chatView.ts, tests, dispatchHandlers.ts) import from this file.

export {
  isContinuationRequest,
  isPlanApproval,
  isPlanRejection,
  isUndoRequest,
  isCommitRequest,
  isShowDiffRequest,
  classifySmallTalk,
  isDeferredAnswer,
  shouldAutoEnablePlanMode,
  resolveToolTier,
  classifyError,
  keywordOverlap,
  updateWorkspaceRelevance,
  prepareUserMessageText,
  resolveNumberedListRef,
  lastUserTextMessage,
  languageToExtension,
} from './messageUtils.js';

export {
  handleAttachFile,
  handleAttachActiveFile,
  handleDroppedPaths,
  handleSaveCodeBlock,
  handleCreateFile,
  handleRunCommand,
  handleMoveFile,
  handleUndoChanges,
  handleRevertFile,
  handleAcceptAllChanges,
} from './fileHandlers.js';

export { ensureProviderRunning, connectWithRetry, handleRestartOllama } from './connectionHandlers.js';

export {
  handleShowSystemPrompt,
  handleDeleteMessage,
  handleExportChat,
  handleUserMessageWithImages,
} from './chatUtilHandlers.js';

export { handleGenerateCommit, handleRegenSection } from './generateHandlers.js';

// --- Local imports from submodules (used within this file) ---

import {
  classifyError,
  updateWorkspaceRelevance,
  prepareUserMessageText,
  shouldAutoEnablePlanMode,
  resolveToolTier,
  lastUserTextMessage,
  isContinuationRequest,
} from './messageUtils.js';
import { getContentText } from '../../ollama/types.js';
import { buildBaseSystemPrompt, injectSystemContext, enrichAndPruneMessages } from './systemPrompt.js';
import { connectWithRetry, ensureProviderRunning } from './connectionHandlers.js';
import { createAgentCallbacks } from './agentCallbacks.js';
import { PlanStore } from '../../agent/plans/planStore.js';

// ---------------------------------------------------------------------------
// Budget management
// ---------------------------------------------------------------------------

export function checkBudgetLimits(state: ChatState, config: ReturnType<typeof getConfig>): 'blocked' | 'ok' {
  if (config.dailyBudget <= 0 && config.weeklyBudget <= 0) return 'ok';
  const { daily: dailySpend, weekly: weeklySpend } = state.metricsCollector.getSpendBreakdown();

  if (config.dailyBudget > 0 && dailySpend >= config.dailyBudget) {
    state.postMessage({
      command: 'assistantMessage',
      content: `⚠️ **Daily spending limit reached** — $${dailySpend.toFixed(4)} of $${config.dailyBudget.toFixed(2)} budget used today. Adjust \`sidecar.dailyBudget\` in settings to continue.`,
    });
    return 'blocked';
  }
  if (config.weeklyBudget > 0 && weeklySpend >= config.weeklyBudget) {
    state.postMessage({
      command: 'assistantMessage',
      content: `⚠️ **Weekly spending limit reached** — $${weeklySpend.toFixed(4)} of $${config.weeklyBudget.toFixed(2)} budget used this week. Adjust \`sidecar.weeklyBudget\` in settings to continue.`,
    });
    return 'blocked';
  }

  if (config.dailyBudget > 0 && dailySpend >= config.dailyBudget * 0.8) {
    state.postMessage({
      command: 'assistantMessage',
      content: `💰 Approaching daily budget: $${dailySpend.toFixed(4)} of $${config.dailyBudget.toFixed(2)} (${Math.round((dailySpend / config.dailyBudget) * 100)}% used)\n\n`,
    });
  } else if (config.weeklyBudget > 0 && weeklySpend >= config.weeklyBudget * 0.8) {
    state.postMessage({
      command: 'assistantMessage',
      content: `💰 Approaching weekly budget: $${weeklySpend.toFixed(4)} of $${config.weeklyBudget.toFixed(2)} (${Math.round((weeklySpend / config.weeklyBudget) * 100)}% used)\n\n`,
    });
  }
  return 'ok';
}

// ---------------------------------------------------------------------------
// Cost recording
// ---------------------------------------------------------------------------

export function recordRunCost(state: ChatState): void {
  const runConfig = getConfig();
  const currentTokens = state.metricsCollector.getCurrentRunTokens();
  if (currentTokens <= 0) return;
  const inputTokens = Math.round(currentTokens * INPUT_TOKEN_RATIO);
  const outputTokens = currentTokens - inputTokens;
  const runCost = estimateCost(runConfig.model, inputTokens, outputTokens);
  state.metricsCollector.recordCost(runCost);
}

// ---------------------------------------------------------------------------
// System prompt assembly for a run
// ---------------------------------------------------------------------------

/**
 * Decide the run's context window and the system prompt's size budget.
 *
 * - The window: only Ollama lets SideCar choose it, so only there does the
 *   user's `contextLimit` win and the per-model cap apply. Any other server's
 *   reported window is the real limit (vLLM rejects requests past
 *   --max-model-len), with `contextLimit` as the fallback when it reports none.
 * - The system prompt may take 40% of the window. For a model on this machine
 *   that is capped at LOCAL_MAX_SYSTEM_CHARS: with a 128K window the uncapped
 *   budget is ~204K chars (~51K tokens), which overwhelms small models and
 *   makes them answer in text instead of calling tools, ending the agent loop
 *   after one iteration.
 */
export function resolveContextBudget(p: {
  isLocal: boolean;
  ollamaSetsContext: boolean;
  rawContextLength: number | null;
  userContextLimit: number;
  model: string;
}): { contextLength: number | null; maxSystemChars: number } {
  let contextLength: number | null;
  if (p.userContextLimit > 0) {
    contextLength = p.ollamaSetsContext ? p.userContextLimit : (p.rawContextLength ?? p.userContextLimit);
  } else {
    const modelCap = contextCapForModel(p.model);
    contextLength =
      p.ollamaSetsContext && p.rawContextLength && p.rawContextLength > modelCap ? modelCap : p.rawContextLength;
  }
  const rawMaxSystemChars = contextLength ? Math.floor(tokensToChars(contextLength) * 0.4) : DEFAULT_MAX_SYSTEM_CHARS;
  const maxSystemChars = p.isLocal ? Math.min(rawMaxSystemChars, LOCAL_MAX_SYSTEM_CHARS) : rawMaxSystemChars;
  return { contextLength, maxSystemChars };
}

async function buildSystemPromptForRun(
  state: ChatState,
  config: ReturnType<typeof getConfig>,
  text: string,
  effectiveApprovalMode: ApprovalMode,
  resolvedSystemPrompt: string | undefined,
  signal?: AbortSignal,
): Promise<{
  systemPrompt: string;
  contextLength: number | null;
  matchedSkill: import('../../agent/skillLoader.js').Skill | null;
}> {
  // Model runs on this machine (local Ollama, or an OpenAI-compatible server on
  // loopback): apply the prompt-size limits meant for small self-hosted models.
  const isLocal = state.client.isLocalEndpoint();
  // Only Ollama lets SideCar choose the context window, so only Ollama's
  // window follows the user's contextLimit and the per-model cap. Any other
  // server's reported limit is the real one.
  const ollamaSetsContext = state.client.isLocalOllama();
  const pkg = state.context.extension?.packageJSON || {};
  const extensionVersion = pkg.version || 'unknown';
  const root = getWorkspaceRoot();
  let systemPrompt = buildBaseSystemPrompt({
    isLocal,
    extensionVersion,
    repoUrl: pkg.repository?.url || 'https://github.com/nedonatelli/sidecar',
    docsUrl: 'https://nedonatelli.github.io/sidecar/',
    root,
    approvalMode: effectiveApprovalMode,
    wholeFileRewrite: config.wholeFileRewriteStrategyEnabled === true,
  });

  if (resolvedSystemPrompt) {
    systemPrompt += `\n\n## Active Mode: ${config.agentMode}\n${resolvedSystemPrompt}`;
  }

  // Prepend notebook mode citation constraints when active.
  const { isNotebookModeActive, getNotebookRequireCitations, notebookSystemPromptPrefix } =
    await import('./notebookHandlers.js');
  if (isNotebookModeActive(state)) {
    systemPrompt = notebookSystemPromptPrefix(getNotebookRequireCitations(state)) + systemPrompt;
  }

  signal?.throwIfAborted();
  state.postMessage({ command: 'typingStatus', content: 'Building context...' });
  const ctxT0 = Date.now();
  const rawContextLength = await state.client.getModelContextLength(signal);
  const modelInfoMs = Date.now() - ctxT0;
  signal?.throwIfAborted();
  const { contextLength, maxSystemChars } = resolveContextBudget({
    isLocal,
    ollamaSetsContext,
    rawContextLength,
    userContextLimit: getContextLimit(),
    model: state.client.getModel(),
  });

  const { prompt: injectedPrompt, matchedSkill } = await injectSystemContext(
    systemPrompt,
    maxSystemChars,
    state,
    config,
    text,
    isLocal,
    signal,
  );
  const contextTotalMs = Date.now() - ctxT0;
  if (contextTotalMs > 1000) {
    logger.info(`[context] "Building context" total ${contextTotalMs}ms (model-info probe ${modelInfoMs}ms)`);
  }
  return { systemPrompt: injectedPrompt, contextLength, matchedSkill };
}

// ---------------------------------------------------------------------------
// Post-loop processing
// ---------------------------------------------------------------------------

/**
 * Tell the webview where its bubbles now sit in state.messages. It numbers
 * them with a local counter, and the extension takes that number as a direct
 * index for edit, delete and regenerate. A turn breaks it three ways: it
 * appends tool entries the counter never saw, pruning before the loop drops
 * old turns from the front, and trimHistory drops more.
 *
 * `loopPrompt` is the user message the loop started from, at index
 * `loopStartCount - 1`. When it is no longer there, the loop compacted
 * history and nothing maps one to one, so the webview re-renders instead.
 */
function syncWebviewIndices(
  state: ChatState,
  updatedMessages: ChatMessage[],
  prePruneMessageCount: number,
  turn: { loopStartCount: number; loopPrompt: ChatMessage },
  trimmed: number,
): void {
  const atPrompt = updatedMessages[turn.loopStartCount - 1];
  const promptInPlace =
    atPrompt === turn.loopPrompt ||
    // In-loop compression copies a message it shrinks; same role and text is still the prompt.
    (atPrompt?.role === turn.loopPrompt.role &&
      getContentText(atPrompt.content) === getContentText(turn.loopPrompt.content));
  if (!promptInPlace) {
    state.postMessage({ command: 'init', messages: state.messages });
    return;
  }
  const turnFrom = turn.loopStartCount - trimmed;
  let lastAssistantIndex: number | undefined;
  for (let i = state.messages.length - 1; i >= Math.max(0, turnFrom); i--) {
    const m = state.messages[i];
    if (m.role === 'assistant' && getContentText(m.content).trim()) {
      lastAssistantIndex = i;
      break;
    }
  }
  state.postMessage({
    command: 'syncMessageIndices',
    messageCount: state.messages.length,
    shift: prePruneMessageCount - turn.loopStartCount + trimmed,
    turnStart: prePruneMessageCount,
    lastAssistantIndex,
  });
}

export async function postLoopProcessing(
  state: ChatState,
  updatedMessages: ChatMessage[],
  prePruneMessageCount: number,
  turn?: { loopStartCount: number; loopPrompt: ChatMessage },
): Promise<void> {
  const newUserMessages = state.messages.slice(prePruneMessageCount);
  state.messages = [...updatedMessages, ...newUserMessages];
  const mergedLength = state.messages.length;
  state.trimHistory();
  state.saveHistory();
  state.autoSave();
  if (turn)
    syncWebviewIndices(state, updatedMessages, prePruneMessageCount, turn, mergedLength - state.messages.length);

  state.pendingQuestion = null;
  const lastMsg = state.messages[state.messages.length - 1];
  if (lastMsg?.role === 'assistant') {
    const msgText =
      typeof lastMsg.content === 'string'
        ? lastMsg.content
        : (lastMsg.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === 'text')
            .map((b) => b.text || '')
            .join('');
    void state.logMessage('assistant', msgText);
    const trimmed = msgText.trim();
    if (/\?\s*$/.test(trimmed) || /\?\s*```\s*$/.test(trimmed)) {
      const sentences = trimmed.split(/(?<=[.!?])\s+/);
      const lastSentence = sentences[sentences.length - 1]?.trim();
      if (lastSentence && lastSentence.endsWith('?')) {
        state.pendingQuestion = lastSentence;
      }
    }
  }

  if (state.changelog.hasChanges()) {
    const changes = await state.changelog.getChangeSummary();
    const summaryItems = changes
      .map((c) => ({
        filePath: c.filePath,
        diff: computeUnifiedDiff(c.filePath, c.original, c.current),
        isNew: c.original === null,
        isDeleted: c.current === null,
      }))
      .filter((item) => item.diff.length > 0);
    if (summaryItems.length > 0) {
      state.postMessage({ command: 'changeSummary', changeSummary: summaryItems });
    }
  }
}

// ---------------------------------------------------------------------------
// Main message handler
// ---------------------------------------------------------------------------

/**
 * The prompt a FINISHED run left unanswered, if history ends on one: the model
 * failed on it mid-run (5xx, timeout, rate limit) or the user stopped it before
 * any answer. Tool results are a run's work, not a prompt, and do not count.
 */
function unansweredTrailingPrompt(messages: ChatMessage[]): ChatMessage | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return null;
  if (Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')) return null;
  return last;
}

export interface UserMessageOptions {
  /**
   * This message continues the turn a failed run left unanswered (/resume,
   * resuming a checkpoint): keep that prompt ahead of it rather than treating
   * the new message as the user moving on.
   */
  continuesFailedTurn?: boolean;
  /**
   * This run carries out or revises a plan the user approved, so it must not
   * plan again: in plan mode it runs as cautious. Applies to this run only.
   */
  leavePlanMode?: boolean;
}

/**
 * The agent mode a run uses. Leaving plan mode used to be done by writing
 * agentMode to the user's GLOBAL settings and back: a workspace value shadowed
 * the write (so the run planned again), and the write-back undid a mode the
 * user picked while the run was going.
 */
export function runAgentMode(configuredMode: string, options: UserMessageOptions): string {
  return options.leavePlanMode && configuredMode === 'plan' ? 'cautious' : configuredMode;
}

export async function handleUserMessage(
  state: ChatState,
  text: string,
  options: UserMessageOptions = {},
): Promise<void> {
  // Read BEFORE the abort below: a prompt left unanswered by a run that is
  // still going is that run's to settle, not this one's.
  const runWasActive = state.abortController !== null;
  if (state.abortController) {
    state.abortController.abort();
    state.abortController = null;
    state.chatGeneration++;
  }

  // @-prefixed model sentinels. Strip the sentinel from the stored message
  // text so it doesn't clutter chat history or get sent as prose to the model;
  // the model pin is applied further down, AFTER `updateModel(config.model)`
  // resets the client — that reset would otherwise overwrite our turn-override.
  const sentinel = text ? parseModelSentinel(text) : { cleaned: text, override: null };
  const turnText = sentinel.cleaned;

  let pushedUserMessage: ChatMessage | null = null;
  let superseded = false;
  if (turnText) {
    const messageText = prepareUserMessageText(state, turnText);
    // A prompt the last run failed on stays in history so Retry and /resume can
    // re-run it (#76). What arrives next decides what that prompt becomes:
    //   - the same message: a RETRY. Re-use the kept prompt. Both Retry buttons
    //     re-send the last bubble's text, and pushing it again sent the model
    //     [.., count?, count?] and kept the unanswered copy for good.
    //   - a continuation (/resume, a checkpoint, a typed "continue"): keep it;
    //     the new message builds on it.
    //   - anything else: the user moved on. Drop it, or the new prompt follows
    //     an unanswered one and the model answers both -- the v0.124.0 bug.
    const kept = runWasActive ? null : unansweredTrailingPrompt(state.messages);
    const keptText = kept ? getContentText(kept.content) : null;
    if (kept && (keptText === messageText || keptText === turnText)) {
      pushedUserMessage = kept;
    } else {
      if (kept && !options.continuesFailedTurn && !isContinuationRequest(turnText)) {
        state.messages.pop();
        // The partial answer /resume would offer belongs to the dropped prompt.
        state.pendingPartialAssistant = null;
        superseded = true;
      }
      pushedUserMessage = { role: 'user', content: messageText };
      state.messages.push(pushedUserMessage);
      void state.logMessage('user', messageText);
    }
    state.saveHistory();
    // The webview numbered its bubbles against the old history; re-render so
    // edit/delete on any bubble targets the right message (as handleDeleteMessage does).
    if (superseded) state.postMessage({ command: 'init', messages: state.messages });
  }
  // When the run stops before the model ever sees the prompt (backend
  // unreachable, budget blocked), take the prompt back out of history. Left
  // in, the user's retyped prompt would follow an unanswered copy and the
  // model would answer both.
  const withdrawUnsentUserMessage = () => {
    if (pushedUserMessage && state.messages[state.messages.length - 1] === pushedUserMessage) {
      state.messages.pop();
      state.saveHistory();
      // Resync the webview's message-index counter, which already counted
      // the withdrawn prompt's bubble.
      state.postMessage({ command: 'done', messageCount: state.messages.length });
    }
  };

  state.pendingPartialAssistant = null;
  state.postMessage({ command: 'setLoading', isLoading: true });
  // This run's own controller. state.abortController is shared: a message
  // sent while this run is still unwinding replaces it, so every check below
  // (and the cleanup in `finally`) goes through `runController` instead.
  const runController = new AbortController();
  state.abortController = runController;
  // True once a newer run has taken over the shared run state. A session load
  // nulls abortController instead, and has already done its own teardown.
  const supersededByNewerRun = () => state.abortController !== null && state.abortController !== runController;

  // Steer queue: one instance per agent run. Subscribes to mutations so
  // the webview strip UI re-renders from a single authoritative source.
  // When a prior run crashed mid-turn and stashed pending steers, restore
  // them here so intent survives stream-failure / resume.
  const steerQueue = new SteerQueue({ maxPending: getConfig().steerQueueMaxPending });
  if (state.pendingSteerSnapshot && state.pendingSteerSnapshot.length > 0) {
    steerQueue.restore(state.pendingSteerSnapshot);
    state.pendingSteerSnapshot = null;
  }
  state.editCancelFns = new Map();
  state.currentSteerQueue = steerQueue;
  const steerDisposer = steerQueue.onChange((snapshot) => {
    state.postMessage({
      command: 'steerQueueUpdate',
      steerQueue: snapshot.map((s) => ({ id: s.id, text: s.text, urgency: s.urgency, createdAt: s.createdAt })),
      steerEnabled: true,
    });
  });
  state.currentSteerDisposer = steerDisposer;
  state.postMessage({ command: 'steerQueueUpdate', steerQueue: [], steerEnabled: true });

  updateWorkspaceRelevance(state, turnText);

  try {
    const config = getConfig();
    const started = await connectWithRetry(state);
    // Stopped or replaced while connecting: the newer run (or session) owns
    // the panel now, so this one must not go on to build a prompt and run.
    if (runController.signal.aborted) return;

    if (!started) {
      state.postMessage(
        state.client.isLocalOllama()
          ? {
              command: 'error',
              content: 'Ollama is not running and could not be started after 3 retries.',
              errorType: 'connection',
              errorAction: 'Reconnect',
              errorActionCommand: 'reconnect',
            }
          : {
              command: 'error',
              content: `Cannot reach API at ${config.baseUrl} after 3 retries.`,
              errorType: 'connection',
              errorAction: 'Reconnect',
              errorActionCommand: 'reconnect',
            },
      );
      withdrawUnsentUserMessage();
      return;
    }

    if (checkBudgetLimits(state, config) === 'blocked') {
      state.postMessage({ command: 'setLoading', isLoading: false });
      withdrawUnsentUserMessage();
      return;
    }

    state.client.updateConnection(config.baseUrl, config.apiKey);
    state.client.updateModel(config.model);

    // Apply the sentinel pin AFTER `updateModel` so it's not clobbered
    // by the reset above. Cleared in the `finally` block below.
    if (sentinel.override) {
      state.client.setTurnOverride(sentinel.override);
    }

    const agentMode = runAgentMode(config.agentMode, options);
    const runConfig = agentMode === config.agentMode ? config : { ...config, agentMode };
    const resolved = resolveMode(agentMode, config.customModes);

    let effectiveApprovalMode: ApprovalMode = resolved.approvalBehavior;
    if (effectiveApprovalMode !== 'plan' && shouldAutoEnablePlanMode(turnText, state.messages.length)) {
      effectiveApprovalMode = 'plan';
      state.postMessage({
        command: 'assistantMessage',
        content:
          '🎯 **Plan mode auto-enabled** — This looks like a large task. I will generate a structured plan first before execution. You can then approve, revise, or reject the plan.\n\n',
      });
      state.postMessage({ command: 'finalizeAssistantMessage' });
    }

    const { systemPrompt, contextLength, matchedSkill } = await buildSystemPromptForRun(
      state,
      runConfig,
      turnText,
      effectiveApprovalMode,
      resolved.systemPrompt,
      runController.signal,
    );
    state.client.updateSystemPrompt(systemPrompt);

    // Skills 2.0 — disableModelInvocation: return the skill body directly.
    if (matchedSkill?.disableModelInvocation) {
      state.postMessage({ command: 'assistantMessage', content: matchedSkill.content });
      // Record the reply: an unanswered prompt in history gets answered again
      // alongside the next one.
      state.messages.push({ role: 'assistant', content: matchedSkill.content });
      state.saveHistory();
      state.postMessage({ command: 'done', messageCount: state.messages.length });
      return;
    }

    const generationAtStart = state.chatGeneration;

    const prePruneMessageCount = state.messages.length;
    const chatMessages = [...state.messages];

    // Use the model's actual context window as the token budget, bounded by
    // the user's agentMaxTokens cap. Then subtract the actual assembled
    // system prompt size (+ 15% headroom) so compression thresholds are
    // relative to the real message-history budget, not the full window.
    const rawMaxTokens = contextLength ? Math.min(contextLength, config.agentMaxTokens) : config.agentMaxTokens;
    const systemPromptTokens = Math.ceil(estimateTokensFromText(systemPrompt) * 1.15);
    const effectiveMaxTokens = Math.max(rawMaxTokens - systemPromptTokens, Math.floor(rawMaxTokens / 2));

    await enrichAndPruneMessages(chatMessages, config, systemPrompt, effectiveMaxTokens, state, config.verboseMode);
    // Where the turn starts in the (possibly pruned) history the loop gets.
    const turn = { loopStartCount: chatMessages.length, loopPrompt: chatMessages[chatMessages.length - 1] };

    if (config.verboseMode) {
      state.postMessage({ command: 'verboseLog', content: systemPrompt, verboseLabel: 'System Prompt' });
    }

    state.postMessage({ command: 'typingStatus', content: 'Sending to model...' });
    state.postMessage({ command: 'setLoading', isLoading: true, expandThinking: config.expandThinking });

    // Attribute the run to its model — this is what lets the next run be
    // scaffolded by measured performance instead of a guess from the filename.
    state.metricsCollector.startRun(state.client.getModel());
    if (state.auditLog) {
      const sessionId = state.agentMemory?.getSessionId() || `s-${Date.now()}`;
      state.auditLog.setContext(sessionId, config.model, effectiveApprovalMode);
    }
    const planStore = state.sidecarDir ? new PlanStore(state.sidecarDir) : undefined;
    if (contextLength) {
      const initialUsed = Math.ceil(
        estimateTokensFromText(
          chatMessages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(' '),
        ) + systemPromptTokens,
      );
      state.postMessage({ command: 'contextFill', contextUsed: initialUsed, contextTotal: contextLength });
    }

    const { callbacks: agentCbs, cancel: cancelAgentCbs } = createAgentCallbacks(
      state,
      config,
      chatMessages,
      planStore,
      rawMaxTokens,
    );
    state.cancelCallbacks = cancelAgentCbs;
    // Skills 2.0 — build tool override from the skill's allowedTools list.
    let skillToolOverride: import('../../ollama/types.js').ToolDefinition[] | undefined;
    if (matchedSkill?.allowedTools && matchedSkill.allowedTools.length > 0) {
      const { getEnabledBuiltInTools } = await import('../../agent/tools.js');
      skillToolOverride = getEnabledBuiltInTools()
        .filter((t) => matchedSkill.allowedTools!.includes(t.definition.name))
        .map((t) => t.definition);
    }

    // Skills 2.0 — activate named built-in guards from the skill's guards list.
    let skillExtraPolicyHooks: import('../../agent/loop/policyHook.js').PolicyHook[] | undefined;
    if (matchedSkill?.guards && matchedSkill.guards.length > 0) {
      const { workspace: ws } = await import('vscode');
      const workspaceRoot = ws.workspaceFolders?.[0]?.uri.fsPath ?? '';
      if (workspaceRoot) {
        const { resolveGuardsByIds } = await import('../../agent/guards/builtInGuards.js');
        const { RegressionGuardHook } = await import('../../agent/guards/regressionGuardHook.js');
        const guardConfigs = resolveGuardsByIds(matchedSkill.guards, workspaceRoot);
        if (guardConfigs.length > 0) {
          skillExtraPolicyHooks = guardConfigs.map((g) => new RegressionGuardHook(g));
        }
      }
    }

    // One-shot: a resumed checkpoint's plan seeds exactly the next run.
    const resumePlan = state.pendingResumePlan;
    state.pendingResumePlan = null;
    // One-shot: /sandbox flags exactly the next run for shadow isolation.
    const forceShadow = state.forceShadowNextRun;
    state.forceShadowNextRun = false;
    const loopOptions: Parameters<typeof runAgentLoop>[4] = {
      logger: state.agentLogger,
      durableMemoryStore: state.durableMemoryStore ?? undefined,
      mcpManager: state.mcpManager,
      approvalMode: effectiveApprovalMode,
      maxIterations: matchedSkill?.maxIterations ?? config.agentMaxIterations,
      maxTokens: effectiveMaxTokens,
      ...(skillToolOverride && { toolOverride: skillToolOverride }),
      ...(resumePlan && { initialPlan: resumePlan }),
      ...(matchedSkill?.preferredModel && { modelOverride: matchedSkill.preferredModel }),
      ...approvalUiOptions(state),
      ...(skillExtraPolicyHooks && { extraPolicyHooks: skillExtraPolicyHooks }),
      modeToolPermissions: resolved.toolPermissions,
      workspaceIndex: state.workspaceIndex ?? undefined,
      steerQueue,
      toolTier: resolveToolTier(turnText),
      episodicMemory: state.episodicMemoryStore ?? undefined,
      testController: state.testController ?? undefined,
    };

    // Shadow isolation: an explicit /sandbox request or shadowWorkspace.mode
    // 'always' routes through the sandbox wrapper (ephemeral git worktree +
    // accept/reject at run's end). The loop works on a COPY of chatMessages,
    // so both paths must take the run's history from the returned value —
    // reading chatMessages back dropped every turn of a sandboxed run.
    let updatedMessages: typeof chatMessages;
    if (forceShadow || config.shadowWorkspaceMode === 'always') {
      const { runAgentLoopInSandbox } = await import('../../agent/shadow/sandbox.js');
      const sandboxResult = await runAgentLoopInSandbox(
        state.client,
        chatMessages,
        agentCbs,
        runController.signal,
        loopOptions,
        { forceShadow },
      );
      updatedMessages = sandboxResult.messages ?? chatMessages;
    } else {
      updatedMessages = await runAgentLoop(state.client, chatMessages, agentCbs, runController.signal, loopOptions);
    }

    if (state.chatGeneration !== generationAtStart) {
      return;
    }

    await postLoopProcessing(state, updatedMessages, prePruneMessageCount, turn);

    state.postMessage({ command: 'setLoading', isLoading: false });
    healthStatus.setOk();
  } catch (err) {
    // Recover any messages from iterations that completed before the error
    // so they're not silently discarded from history.
    const partialMessages = (err as { partialMessages?: ChatMessage[] })?.partialMessages;
    if (partialMessages && partialMessages.length > state.messages.length) {
      state.messages = partialMessages;
      state.trimHistory();
    }
    state.saveHistory();
    state.autoSave();

    if (err instanceof Error && err.name === 'AbortError') {
      // A newer run's spinner and bubbles are on screen; don't end them.
      if (supersededByNewerRun()) return;
      state.postMessage({ command: 'done', messageCount: state.messages.length });
      state.postMessage({ command: 'setLoading', isLoading: false });
      return;
    }
    // Non-abort error bubbling out of runAgentLoop. Stash pending steers so
    // the user's typed intent survives the crash and rematerializes on the
    // next run (resume or fresh turn).
    const snapshot = state.currentSteerQueue?.serialize();
    if (snapshot && snapshot.length > 0) {
      state.pendingSteerSnapshot = snapshot;
    }
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    const classified = classifyError(errorMessage);
    const errorModel = classified.errorType === 'model' ? getConfig().model : undefined;
    state.postMessage({
      command: 'error',
      content: `Error: ${errorMessage}`,
      ...classified,
      ...(errorModel ? { errorModel } : {}),
    });
    void surfaceNativeToast(errorMessage, classified);
  } finally {
    // Call the locally-captured disposer directly. Reading state.currentSteerDisposer
    // here would race with a session load that already replaced it with a new
    // session's disposer, causing the new session's listener to be torn down.
    steerDisposer();
    if (state.currentSteerDisposer === steerDisposer) {
      state.currentSteerDisposer = null;
    }
    // Everything below is shared run state. When the user sent another message
    // while this run was unwinding, it belongs to that run: resetting it here
    // hid its spinner, disabled its steering, dropped its cancel hooks and
    // cleared its @model pin. (This run's metrics are dropped too, rather than
    // ending the newer run's.)
    if (!supersededByNewerRun()) {
      recordRunCost(state);
      state.metricsCollector.endRun();
      state.abortController = null;
      state.cancelCallbacks = null;
      state.currentSteerQueue = null;
      state.editCancelFns = null;
      state.postMessage({ command: 'steerQueueUpdate', steerQueue: [], steerEnabled: false });
      state.postMessage({ command: 'setLoading', isLoading: false });
      // Clear any sentinel pin so the next user message routes normally.
      state.client.setTurnOverride(null);
    }
  }
}

// ---------------------------------------------------------------------------
// Reconnect — must be co-located with handleUserMessage (calls it directly)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Edit message — truncate history to before the edited message and re-run
// ---------------------------------------------------------------------------

export async function handleEditMessage(state: ChatState, index: number, text: string): Promise<void> {
  if (!text?.trim()) return;
  if (state.abortController) {
    state.postMessage({
      command: 'error',
      content: 'Cannot edit a message while the agent is running. Press Escape to stop first.',
      errorType: 'unknown',
    });
    return;
  }
  if (index < 0 || index >= state.messages.length) return;
  const target = state.messages[index];
  if (target.role !== 'user') return;
  const hasText =
    typeof target.content === 'string' ||
    (Array.isArray(target.content) && target.content.some((b) => (b as { type: string }).type === 'text'));
  if (!hasText) return;

  state.messages = state.messages.slice(0, index);
  state.saveHistory();
  state.postMessage({ command: 'chatCleared' });
  if (state.messages.length > 0) {
    state.postMessage({ command: 'init', messages: state.messages });
  }
  await handleUserMessage(state, text);
}

export async function handleReconnect(state: ChatState): Promise<void> {
  state.postMessage({ command: 'setLoading', isLoading: true });
  state.postMessage({ command: 'typingStatus', content: 'Reconnecting...' });

  const started = await ensureProviderRunning(state);
  if (started) {
    state.postMessage({
      command: 'assistantMessage',
      content: 'Reconnected to model successfully.\n',
    });
    state.postMessage({ command: 'done', messageCount: state.messages.length });

    const last = lastUserTextMessage(state.messages);
    if (last) {
      // Splice from the user message index onward (removing it plus any
      // trailing assistant/tool messages) so handleUserMessage starts clean.
      state.messages.splice(last.index);
      state.saveHistory();
      await handleUserMessage(state, last.text);
    }
  } else {
    state.postMessage({
      command: 'error',
      content: 'Still unable to connect. Check that Ollama is running and try again.',
      errorType: 'connection',
      errorAction: 'Reconnect',
      errorActionCommand: 'reconnect',
    });
  }
}

// ---------------------------------------------------------------------------
// Regenerate — must be co-located with handleUserMessage (calls it directly)
// ---------------------------------------------------------------------------

/** Re-run the last user message, discarding the most recent assistant turn. */
export async function handleRegenerateResponse(state: ChatState): Promise<void> {
  const last = lastUserTextMessage(state.messages);
  if (!last) return;

  // Remove from the last user message onward — which strips the stale assistant
  // turn AND every tool_use/tool_result pair it produced. Splicing at the last
  // `role: 'user'` message instead would cut between a tool_use and its result.
  state.messages.splice(last.index);
  state.saveHistory();

  await handleUserMessage(state, last.text);
}

/**
 * The options through which a run asks the user and records its edits: the
 * approval card, diff preview, ghost-text edits, clarifying questions, the
 * review-mode queue and the changelog. Every chat-panel run needs all of them;
 * without a confirmFn the executor denies every approval, and without
 * pendingEdits review mode writes straight to disk.
 */
export function approvalUiOptions(
  state: ChatState,
): Pick<
  AgentOptions,
  | 'confirmFn'
  | 'isChatVisible'
  | 'diffPreviewFn'
  | 'inlineEditFn'
  | 'clarifyFn'
  | 'pendingEdits'
  | 'editTimeline'
  | 'changelog'
> {
  return {
    changelog: state.changelog,
    pendingEdits: state.pendingEdits,
    editTimeline: state.editTimeline,
    confirmFn: (msg, actions, options) => state.requestConfirm(msg, actions, options),
    isChatVisible: () => state.isChatViewVisible?.() ?? false,
    diffPreviewFn: state.contentProvider
      ? async (filePath: string, proposedContent: string) => {
          const { openDiffPreview } = await import('../../edits/streamingDiffPreview.js');
          const session = await openDiffPreview(
            filePath,
            proposedContent,
            state.contentProvider!,
            (msg, actions, diffBlock) => state.requestConfirm(msg, actions, { diffBlock }),
            () => state.isChatViewVisible?.() ?? false,
          );
          try {
            return await session.finalize();
          } finally {
            session.dispose();
          }
        }
      : undefined,
    inlineEditFn: state.inlineEditProvider
      ? (filePath: string, searchText: string, replaceText: string) =>
          state.inlineEditProvider!.proposeEdit(filePath, searchText, replaceText)
      : undefined,
    clarifyFn: (question, options, allowCustom) => state.requestClarification(question, options, allowCustom),
  };
}
