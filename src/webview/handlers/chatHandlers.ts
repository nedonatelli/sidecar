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
import { runAgentLoop } from '../../agent/loop.js';
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
  isDeferredAnswer,
  shouldAutoEnablePlanMode,
  resolveToolTier,
  classifyError,
  keywordOverlap,
  updateWorkspaceRelevance,
  prepareUserMessageText,
  resolveNumberedListRef,
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
} from './messageUtils.js';
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
  const isLocal = state.client.isLocalOllama();
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
  const rawContextLength = await state.client.getModelContextLength();
  const modelInfoMs = Date.now() - ctxT0;
  signal?.throwIfAborted();
  const userContextLimit = getContextLimit();
  let contextLength: number | null;
  if (userContextLimit > 0) {
    contextLength = isLocal ? userContextLimit : (rawContextLength ?? userContextLimit);
  } else {
    const modelCap = contextCapForModel(state.client.getModel());
    contextLength = isLocal && rawContextLength && rawContextLength > modelCap ? modelCap : rawContextLength;
  }
  // Allow the system prompt to occupy up to 40% of the context window during
  // assembly. After injection the actual size is measured and used to set a
  // tighter message-history budget (see effectiveMaxTokens calculation below).
  // For local models the 40% rule is capped at LOCAL_MAX_SYSTEM_CHARS: with a
  // 128K context window the uncapped budget is ~204K chars (~51K tokens), which
  // overwhelms small models and causes them to produce text-only responses
  // instead of tool calls, making the agent loop exit after one iteration.
  const rawMaxSystemChars = contextLength ? Math.floor(tokensToChars(contextLength) * 0.4) : DEFAULT_MAX_SYSTEM_CHARS;
  const maxSystemChars = isLocal ? Math.min(rawMaxSystemChars, LOCAL_MAX_SYSTEM_CHARS) : rawMaxSystemChars;

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

export async function postLoopProcessing(
  state: ChatState,
  updatedMessages: ChatMessage[],
  prePruneMessageCount: number,
): Promise<void> {
  const newUserMessages = state.messages.slice(prePruneMessageCount);
  state.messages = [...updatedMessages, ...newUserMessages];
  state.trimHistory();
  state.saveHistory();
  state.autoSave();

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

export async function handleUserMessage(state: ChatState, text: string): Promise<void> {
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

  if (turnText) {
    const messageText = prepareUserMessageText(state, turnText);
    state.messages.push({ role: 'user', content: messageText });
    void state.logMessage('user', messageText);
    state.saveHistory();
  }

  state.pendingPartialAssistant = null;
  state.postMessage({ command: 'setLoading', isLoading: true });
  state.abortController = new AbortController();

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
      return;
    }

    if (checkBudgetLimits(state, config) === 'blocked') {
      state.postMessage({ command: 'setLoading', isLoading: false });
      return;
    }

    state.client.updateConnection(config.baseUrl, config.apiKey);
    state.client.updateModel(config.model);

    // Apply the sentinel pin AFTER `updateModel` so it's not clobbered
    // by the reset above. Cleared in the `finally` block below.
    if (sentinel.override) {
      state.client.setTurnOverride(sentinel.override);
    }

    const resolved = resolveMode(config.agentMode, config.customModes);

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
      config,
      turnText,
      effectiveApprovalMode,
      resolved.systemPrompt,
      state.abortController.signal,
    );
    state.client.updateSystemPrompt(systemPrompt);

    // Skills 2.0 — disableModelInvocation: return the skill body directly.
    if (matchedSkill?.disableModelInvocation) {
      state.postMessage({ command: 'assistantMessage', content: matchedSkill.content });
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

    if (config.verboseMode) {
      state.postMessage({ command: 'verboseLog', content: systemPrompt, verboseLabel: 'System Prompt' });
    }

    state.postMessage({ command: 'typingStatus', content: 'Sending to model...' });
    state.postMessage({ command: 'setLoading', isLoading: true, expandThinking: config.expandThinking });

    state.metricsCollector.startRun();
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
    const updatedMessages = await runAgentLoop(state.client, chatMessages, agentCbs, state.abortController.signal, {
      logger: state.agentLogger,
      changelog: state.changelog,
      mcpManager: state.mcpManager,
      approvalMode: effectiveApprovalMode,
      maxIterations: matchedSkill?.maxIterations ?? config.agentMaxIterations,
      maxTokens: effectiveMaxTokens,
      ...(skillToolOverride && { toolOverride: skillToolOverride }),
      ...(resumePlan && { initialPlan: resumePlan }),
      ...(matchedSkill?.preferredModel && { modelOverride: matchedSkill.preferredModel }),
      confirmFn: (msg, actions, options) => state.requestConfirm(msg, actions, options),
      diffPreviewFn: state.contentProvider
        ? async (filePath: string, proposedContent: string) => {
            const { openDiffPreview } = await import('../../edits/streamingDiffPreview.js');
            const session = await openDiffPreview(
              filePath,
              proposedContent,
              state.contentProvider!,
              (msg, actions, diffBlock) => state.requestConfirm(msg, actions, { diffBlock }),
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
      ...(skillExtraPolicyHooks && { extraPolicyHooks: skillExtraPolicyHooks }),
      modeToolPermissions: resolved.toolPermissions,
      pendingEdits: state.pendingEdits,
      editTimeline: state.editTimeline,
      workspaceIndex: state.workspaceIndex ?? undefined,
      steerQueue,
      toolTier: resolveToolTier(turnText),
      episodicMemory: state.episodicMemoryStore ?? undefined,
      testController: state.testController ?? undefined,
    });

    if (state.chatGeneration !== generationAtStart) {
      return;
    }

    await postLoopProcessing(state, updatedMessages, prePruneMessageCount);

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
    recordRunCost(state);
    state.metricsCollector.endRun();
    state.abortController = null;
    state.cancelCallbacks = null;
    // Call the locally-captured disposer directly. Reading state.currentSteerDisposer
    // here would race with a session load that already replaced it with a new
    // session's disposer, causing the new session's listener to be torn down.
    steerDisposer();
    if (state.currentSteerDisposer === steerDisposer) {
      state.currentSteerDisposer = null;
    }
    state.currentSteerQueue = null;
    state.editCancelFns = null;
    state.postMessage({ command: 'steerQueueUpdate', steerQueue: [], steerEnabled: false });
    state.postMessage({ command: 'setLoading', isLoading: false });
    // Clear any sentinel pin so the next user message routes normally.
    state.client.setTurnOverride(null);
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

    const lastUserMsg = [...state.messages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) {
      const text =
        typeof lastUserMsg.content === 'string'
          ? lastUserMsg.content
          : lastUserMsg.content
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
      // Splice from the user message index onward (removing it plus any
      // trailing assistant messages) so handleUserMessage starts clean.
      const lastUserIdx = state.messages.lastIndexOf(lastUserMsg);
      if (lastUserIdx >= 0) state.messages.splice(lastUserIdx);
      state.saveHistory();
      await handleUserMessage(state, text);
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
  const lastUserMsg = [...state.messages].reverse().find((m) => m.role === 'user');
  if (!lastUserMsg) return;

  const text =
    typeof lastUserMsg.content === 'string'
      ? lastUserMsg.content
      : lastUserMsg.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n');

  // Remove from the last user message onward (strips the stale assistant turn).
  const idx = state.messages.lastIndexOf(lastUserMsg);
  if (idx >= 0) state.messages.splice(idx);
  state.saveHistory();

  await handleUserMessage(state, text);
}
