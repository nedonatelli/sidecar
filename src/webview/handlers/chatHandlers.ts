/**
 * Chat message handling — thin orchestrator.
 *
 * The bulk of the logic has been extracted into focused submodules:
 *   - messageUtils.ts  — continuation detection, error classification, relevance
 *   - systemPrompt.ts  — base prompt, context injection, message enrichment
 *   - fileHandlers.ts  — file attach/drop/save/create/move/undo/revert
 *
 * This file keeps:
 *   - handleUserMessage (the core agent-loop orchestrator)
 *   - Provider connection + budget management
 *   - Agent callback factory
 *   - Secondary handlers (reconnect, images, delete, export, commit, show prompt)
 *   - Re-exports from submodules for backward compatibility
 */

import { window, workspace, Uri } from 'vscode';
import type { ChatState } from '../chatState.js';
import type { ContentBlock } from '../../ollama/types.js';
import { getContentText } from '../../ollama/types.js';
import { getConfig, estimateCost, resolveMode } from '../../config/settings.js';
import { parseModelSentinel } from '../../ollama/modelSentinels.js';
import { isProviderReachable } from '../../config/providerReachability.js';
import {
  CHARS_PER_TOKEN,
  SYSTEM_PROMPT_BUDGET_FRACTION,
  DEFAULT_MAX_SYSTEM_CHARS,
  LOCAL_CONTEXT_CAP,
  INPUT_TOKEN_RATIO,
} from '../../config/constants.js';
import { GitCLI } from '../../github/git.js';
import { surfaceNativeToast } from '../errorSurface.js';
import { healthStatus } from '../../ollama/healthStatus.js';
import { getWorkspaceRoot, getContextLimit } from '../../config/workspace.js';
import { runAgentLoop } from '../../agent/loop.js';
import { SteerQueue } from '../../agent/steerQueue.js';
import type { ChatMessage } from '../../ollama/types.js';
import type { ApprovalMode } from '../../agent/executor.js';
import { computeUnifiedDiff } from '../../agent/diff.js';

// --- Submodule re-exports for backward compatibility ---
// External callers (chatView.ts, tests) import from this file.

export {
  isContinuationRequest,
  isPlanApproval,
  isPlanRejection,
  isUndoRequest,
  isCommitRequest,
  isShowDiffRequest,
  isDeferredAnswer,
  shouldAutoEnablePlanMode,
  classifyError,
  keywordOverlap,
  updateWorkspaceRelevance,
  prepareUserMessageText,
  resolveNumberedListRef,
  languageToExtension,
} from './messageUtils.js';

export {
  type SystemPromptParams,
  buildBaseSystemPrompt,
  injectSystemContext,
  enrichAndPruneMessages,
} from './systemPrompt.js';

export {
  handleAttachFile,
  handleDroppedPaths,
  handleSaveCodeBlock,
  handleCreateFile,
  handleRunCommand,
  handleMoveFile,
  handleUndoChanges,
  handleRevertFile,
  handleAcceptAllChanges,
} from './fileHandlers.js';

// --- Local imports from submodules (used within this file) ---

import { classifyError, updateWorkspaceRelevance, prepareUserMessageText } from './messageUtils.js';
import { shouldAutoEnablePlanMode } from './messageUtils.js';
import { buildBaseSystemPrompt, injectSystemContext, enrichAndPruneMessages } from './systemPrompt.js';

// ---------------------------------------------------------------------------
// Legacy disposer — no-op, kept for backward compat with extension.ts import.
// ---------------------------------------------------------------------------

export function disposeSidecarMdWatcher(): void {
  // No-op — the watcher lives on ChatState now. See chatState.ts.
}

// ---------------------------------------------------------------------------
// Provider connection
// ---------------------------------------------------------------------------

async function ensureProviderRunning(state: ChatState): Promise<boolean> {
  if (await isProviderReachable(state.client.getProviderType())) return true;

  // Auto-start Kickstand if the provider is kickstand
  if (state.client.getProviderType() === 'kickstand') {
    const { ensureKickstandRunning } = await import('../../config/providerReachability.js');
    return ensureKickstandRunning(getConfig().baseUrl);
  }

  if (!state.client.isLocalOllama()) return false;

  try {
    const { spawn } = await import('child_process');
    const child = spawn('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    return false;
  }

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isProviderReachable(state.client.getProviderType())) return true;
  }

  return false;
}

async function connectWithRetry(state: ChatState): Promise<boolean> {
  state.postMessage({ command: 'typingStatus', content: 'Connecting to model...' });
  let started = await ensureProviderRunning(state);
  if (started) return true;

  const retryDelays = [2000, 4000, 8000];
  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    state.postMessage({
      command: 'typingStatus',
      content: `Connection failed — retrying (${attempt + 1}/${retryDelays.length})...`,
    });
    await new Promise((r) => setTimeout(r, retryDelays[attempt]));
    if (state.abortController?.signal.aborted) return false;
    started = await isProviderReachable(state.client.getProviderType());
    if (started) return true;
  }
  return false;
}

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
// System prompt assembly for a run
// ---------------------------------------------------------------------------

async function buildSystemPromptForRun(
  state: ChatState,
  config: ReturnType<typeof getConfig>,
  text: string,
  effectiveApprovalMode: ApprovalMode,
  resolvedSystemPrompt: string | undefined,
): Promise<{ systemPrompt: string; contextLength: number | null }> {
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

  state.postMessage({ command: 'typingStatus', content: 'Building context...' });
  const rawContextLength = await state.client.getModelContextLength();
  const userContextLimit = getContextLimit();
  let contextLength: number | null;
  if (userContextLimit > 0) {
    contextLength = isLocal ? userContextLimit : (rawContextLength ?? userContextLimit);
  } else {
    contextLength =
      isLocal && rawContextLength && rawContextLength > LOCAL_CONTEXT_CAP ? LOCAL_CONTEXT_CAP : rawContextLength;
  }
  const maxSystemChars = contextLength
    ? Math.floor(contextLength * CHARS_PER_TOKEN * SYSTEM_PROMPT_BUDGET_FRACTION)
    : DEFAULT_MAX_SYSTEM_CHARS;

  systemPrompt = await injectSystemContext(systemPrompt, maxSystemChars, state, config, text, isLocal, contextLength);
  return { systemPrompt, contextLength };
}

// ---------------------------------------------------------------------------
// Agent callback factory — extracted to ./agentCallbacks.ts (v0.65 chunk 5c)
// so each callback's behavior can be unit-tested without standing up the
// full handleUserMessage pipeline. Re-imported here for the internal call
// site in handleUserMessage; the factory itself is unchanged.
// ---------------------------------------------------------------------------

import { createAgentCallbacks } from './agentCallbacks.js';

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
    state.logMessage('assistant', msgText);
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

  // @-prefixed model sentinels (v0.64 phase 4d.1). Strip the sentinel
  // from the stored message text so it doesn't clutter chat history or
  // get sent as prose to the model; the model pin is applied further
  // down, AFTER `updateModel(config.model)` resets the client — that
  // reset would otherwise overwrite our turn-override.
  const sentinel = text ? parseModelSentinel(text) : { cleaned: text, override: null };
  const turnText = sentinel.cleaned;

  if (turnText) {
    const messageText = prepareUserMessageText(state, turnText);
    state.messages.push({ role: 'user', content: messageText });
    state.logMessage('user', messageText);
    state.saveHistory();
  }

  state.pendingPartialAssistant = null;
  state.postMessage({ command: 'setLoading', isLoading: true });
  state.abortController = new AbortController();

  // Steer queue: one instance per agent run (v0.65 chunk 3.3).
  // Subscribes to mutations so the webview strip UI re-renders
  // from a single authoritative source. When a prior run crashed
  // mid-turn and stashed pending steers (chunk 3.4), restore them
  // here so intent survives stream-failure / resume.
  const steerQueue = new SteerQueue({ maxPending: getConfig().steerQueueMaxPending });
  if (state.pendingSteerSnapshot && state.pendingSteerSnapshot.length > 0) {
    steerQueue.restore(state.pendingSteerSnapshot);
    state.pendingSteerSnapshot = null;
  }
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
    }

    const { systemPrompt, contextLength } = await buildSystemPromptForRun(
      state,
      config,
      turnText,
      effectiveApprovalMode,
      resolved.systemPrompt,
    );
    state.client.updateSystemPrompt(systemPrompt);

    const generationAtStart = state.chatGeneration;

    const prePruneMessageCount = state.messages.length;
    const chatMessages = [...state.messages];

    // Use the model's actual context window as the token budget when
    // available, bounded by the user's agentMaxTokens cap. Without this,
    // a large-context cloud model (e.g. 200K) would still be capped at
    // the agentMaxTokens default, and the pre-loop history pruning would
    // pass more history than the loop can handle — causing compression to
    // exhaust immediately.
    const effectiveMaxTokens = contextLength ? Math.min(contextLength, config.agentMaxTokens) : config.agentMaxTokens;

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
    const updatedMessages = await runAgentLoop(
      state.client,
      chatMessages,
      createAgentCallbacks(state, config, chatMessages),
      state.abortController.signal,
      {
        logger: state.agentLogger,
        changelog: state.changelog,
        mcpManager: state.mcpManager,
        approvalMode: effectiveApprovalMode,
        maxIterations: config.agentMaxIterations,
        maxTokens: effectiveMaxTokens,
        confirmFn: (msg, actions, options) => state.requestConfirm(msg, actions, options),
        diffPreviewFn: state.contentProvider
          ? async (filePath: string, proposedContent: string) => {
              const { openDiffPreview } = await import('../../edits/streamingDiffPreview.js');
              const session = await openDiffPreview(filePath, proposedContent, state.contentProvider!, (msg, actions) =>
                state.requestConfirm(msg, actions),
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
        modeToolPermissions: resolved.toolPermissions,
        pendingEdits: state.pendingEdits,
        steerQueue,
      },
    );

    if (state.chatGeneration !== generationAtStart) {
      return;
    }

    await postLoopProcessing(state, updatedMessages, prePruneMessageCount);

    state.postMessage({ command: 'setLoading', isLoading: false });
    healthStatus.setOk();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      state.autoSave();
      state.postMessage({ command: 'done' });
      state.postMessage({ command: 'setLoading', isLoading: false });
      return;
    }
    // Non-abort error bubbling out of runAgentLoop. Stash pending
    // steers so the user's typed intent survives the crash and
    // rematerializes on the next run (resume or fresh turn).
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
    state.currentSteerDisposer?.();
    state.currentSteerDisposer = null;
    state.currentSteerQueue = null;
    state.postMessage({ command: 'steerQueueUpdate', steerQueue: [], steerEnabled: false });
    state.postMessage({ command: 'setLoading', isLoading: false });
    // Clear any sentinel pin so the next user message routes normally.
    state.client.setTurnOverride(null);
  }
}

// ---------------------------------------------------------------------------
// Secondary handlers
// ---------------------------------------------------------------------------

export function handleUserMessageWithImages(
  state: ChatState,
  text: string,
  images: { mediaType: string; data: string }[],
): void {
  const content: ContentBlock[] = images.map((img) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: img.mediaType as 'image/png', data: img.data },
  }));
  content.push({ type: 'text', text: text || '' });
  state.messages.push({ role: 'user', content });
  state.saveHistory();
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
    state.postMessage({ command: 'done' });

    const lastUserMsg = [...state.messages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) {
      const text =
        typeof lastUserMsg.content === 'string'
          ? lastUserMsg.content
          : lastUserMsg.content
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
      state.messages.pop();
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

export async function handleShowSystemPrompt(state: ChatState): Promise<void> {
  const config = getConfig();

  const pkg = state.context.extension?.packageJSON || {};
  const extensionVersion = pkg.version || 'unknown';
  const repoUrl = pkg.repository?.url || 'https://github.com/nedonatelli/sidecar';
  const docsUrl = 'https://nedonatelli.github.io/sidecar/';
  let systemPrompt = `You are SideCar v${extensionVersion}, an AI coding assistant running inside VS Code. GitHub: ${repoUrl} | Docs: ${docsUrl}\nProject root: ${getWorkspaceRoot()}\n\n(Use /verbose to see the full prompt sent during agent runs)`;

  const sidecarMd = await state.loadSidecarMd();
  if (sidecarMd) {
    systemPrompt += `\n\nProject instructions (from SIDECAR.md):\n${sidecarMd}`;
  }

  const userSystemPrompt = config.systemPrompt;
  if (userSystemPrompt) {
    systemPrompt += `\n\n${userSystemPrompt}`;
  }

  state.postMessage({ command: 'verboseLog', content: systemPrompt, verboseLabel: 'System Prompt' });
}

export function handleDeleteMessage(state: ChatState, index: number): void {
  if (index < 0 || index >= state.messages.length) return;
  if (state.abortController) {
    state.postMessage({
      command: 'error',
      content: 'Cannot delete a message while the agent is running. Press Escape to stop the run first.',
      errorType: 'unknown',
    });
    return;
  }
  state.messages.splice(index, 1);
  state.saveHistory();
}

export async function handleExportChat(state: ChatState): Promise<void> {
  if (state.messages.length === 0) return;
  const lines: string[] = [];
  for (const msg of state.messages) {
    const label = msg.role === 'user' ? '## User' : '## Assistant';
    const text = getContentText(msg.content);
    lines.push(`${label}\n\n${text}\n`);
  }
  const content = lines.join('\n---\n\n');
  const uri = await window.showSaveDialog({
    filters: { Markdown: ['md'] },
    defaultUri: Uri.file('sidecar-chat.md'),
  });
  if (!uri) return;
  await workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
  window.showInformationMessage(`Chat exported to ${uri.fsPath.split('/').pop()}`);
}

export async function handleGenerateCommit(state: ChatState): Promise<void> {
  const cwd = getWorkspaceRoot();
  if (!cwd) {
    state.postMessage({ command: 'error', content: 'No workspace folder open.' });
    return;
  }

  const git = new GitCLI(cwd);

  try {
    const status = await git.status();
    if (status === 'Working tree clean.') {
      state.postMessage({ command: 'assistantMessage', content: 'No changes to commit.' });
      state.postMessage({ command: 'done' });
      return;
    }

    const { diff } = await git.diff();
    if (diff === 'No diff output.') {
      state.postMessage({ command: 'assistantMessage', content: 'No diff found. Stage files first or make changes.' });
      state.postMessage({ command: 'done' });
      return;
    }

    const maxDiff = 15_000;
    const truncated = diff.length > maxDiff ? diff.slice(0, maxDiff) + '\n... (truncated)' : diff;

    state.postMessage({ command: 'setLoading', isLoading: true });
    state.postMessage({ command: 'assistantMessage', content: 'Generating commit message...\n\n' });

    const config = getConfig();
    state.client.updateConnection(config.baseUrl, config.apiKey);
    state.client.updateModel(config.model);

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: `Generate a concise git commit message for these changes. Follow conventional commits format (type: description). First line max 72 chars. Add a blank line then bullet points for details if needed. Output ONLY the commit message, nothing else.\n\n\`\`\`diff\n${truncated}\n\`\`\``,
      },
    ];

    let message = await state.client.complete(messages, 512);
    message = message
      .replace(/^```\w*\n?/, '')
      .replace(/\n?```$/, '')
      .trim();

    await git.stage();
    const result = await git.commit(message);

    state.postMessage({ command: 'assistantMessage', content: result + '\n' });
    state.postMessage({ command: 'done' });
    state.postMessage({ command: 'setLoading', isLoading: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.postMessage({ command: 'error', content: `Commit failed: ${msg}` });
    state.postMessage({ command: 'setLoading', isLoading: false });
  }
}
