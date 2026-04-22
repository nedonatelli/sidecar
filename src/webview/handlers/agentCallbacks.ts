import type { ChatState } from '../chatState.js';
import type { ChatMessage } from '../../ollama/types.js';
import type { AgentCallbacks } from '../../agent/loop.js';
import { getConfig } from '../../config/settings.js';

// ---------------------------------------------------------------------------
// Agent callbacks factory (v0.65 chunk 5c — extracted from chatHandlers.ts).
//
// Builds the `AgentCallbacks` bundle that connects the agent loop to the
// chat webview: text streaming, tool-call surfacing, iteration progress,
// plan cards, stream-failure stash, checkpoint confirms. Extracting this
// into its own module lets us unit-test each callback in isolation
// without standing up the full handleUserMessage plumbing.
//
// Behavior-preserving: the logic below is a verbatim lift from
// chatHandlers.ts. Changes should land here; chatHandlers.ts now just
// re-exports `createAgentCallbacks`.
// ---------------------------------------------------------------------------

export const STREAM_FLUSH_MS = 50;
export const TOOL_CALL_SUMMARY_MAX = 60;
export const TOOL_RESULT_PREVIEW_MAX = 200;

export function createAgentCallbacks(
  state: ChatState,
  config: ReturnType<typeof getConfig>,
  chatMessages: ChatMessage[],
): AgentCallbacks {
  const verbose = config.verboseMode;
  const verboseLog = (label: string, content: string) => {
    if (verbose) {
      state.postMessage({ command: 'verboseLog', content, verboseLabel: label });
    }
  };

  let textBuffer = '';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushTextBuffer = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (textBuffer) {
      state.postMessage({ command: 'assistantMessage', content: textBuffer });
      textBuffer = '';
    }
  };

  let currentIteration = 0;

  return {
    onText: (t) => {
      textBuffer += t;
      if (!flushTimer) {
        flushTimer = setTimeout(flushTextBuffer, STREAM_FLUSH_MS);
      }
    },
    onThinking: (thinking) => {
      state.postMessage({ command: 'thinking', content: thinking });
    },
    onToolCall: (name, input, id) => {
      flushTextBuffer();
      const summary = Object.entries(input)
        .map(([k, v]) => {
          const val =
            typeof v === 'string' && v.length > TOOL_CALL_SUMMARY_MAX
              ? v.slice(0, TOOL_CALL_SUMMARY_MAX) + '...'
              : String(v);
          return `${k}: ${val}`;
        })
        .join(', ');
      state.postMessage({ command: 'toolCall', toolName: name, toolCallId: id, content: `${name}(${summary})` });
      state.logMessage('tool', `${name}(${summary})`);
      state.metricsCollector.recordToolStart();
      state.auditLog?.recordToolCall(name, input, id, currentIteration);
      if (verbose) {
        verboseLog('Tool Selected', `Invoking ${name} with: ${summary}`);
      }
      if (state.workspaceIndex && typeof input.path === 'string') {
        const accessType = name === 'read_file' ? 'read' : 'write';
        if (['read_file', 'write_file', 'edit_file'].includes(name)) {
          state.workspaceIndex.trackFileAccess(input.path as string, accessType);
        }
      }
    },
    onToolResult: (name, result, isError, id) => {
      const preview =
        result.length > TOOL_RESULT_PREVIEW_MAX ? result.slice(0, TOOL_RESULT_PREVIEW_MAX) + '...' : result;
      state.postMessage({ command: 'toolResult', toolName: name, toolCallId: id, content: preview });
      const durationMs = state.metricsCollector.getToolDuration();
      state.metricsCollector.recordToolEnd(name, isError);
      state.auditLog?.recordToolResult(name, id, result, isError, durationMs);
    },
    onToolOutput: (name, chunk, id) => {
      state.postMessage({ command: 'toolOutput', content: chunk, toolName: name, toolCallId: id });
    },
    onIterationStart: (info) => {
      currentIteration = info.iteration;
      state.postMessage({
        command: 'agentProgress',
        iteration: info.iteration,
        maxIterations: info.maxIterations,
        elapsedMs: info.elapsedMs,
        estimatedTokens: info.estimatedTokens,
        messageCount: info.messageCount,
        messagesRemaining: info.messagesRemaining,
        atCapacity: info.atCapacity,
      });
      if (verbose) {
        const elapsed = (info.elapsedMs / 1000).toFixed(1);
        const capacityWarning = info.atCapacity ? ' ⚠️ At message limit!' : '';
        verboseLog(
          `Iteration ${info.iteration}/${info.maxIterations}`,
          `Starting iteration ${info.iteration}. Elapsed: ${elapsed}s, ~${info.estimatedTokens} tokens used, ${info.messageCount} messages${capacityWarning}`,
        );
      }
    },
    onPlanGenerated: (plan) => {
      state.pendingPlan = plan;
      state.pendingPlanMessages = [...chatMessages];
      state.postMessage({ command: 'planReady', content: plan });
    },
    onMemory: (type, category, content) => {
      if (config.enableAgentMemory && state.agentMemory) {
        try {
          state.agentMemory.add(type, category, content, `Session: ${new Date().toISOString()}`);
        } catch (err) {
          console.warn('Failed to record agent memory:', err);
        }
      }
    },
    onToolChainRecord: (toolName, succeeded) => {
      if (config.enableAgentMemory && state.agentMemory) {
        state.agentMemory.recordToolUse(toolName, succeeded);
      }
    },
    onToolChainFlush: () => {
      if (config.enableAgentMemory && state.agentMemory) {
        state.agentMemory.flushToolChain();
      }
    },
    onSuggestNextSteps: (suggestions) => {
      if (suggestions.length > 0) {
        state.postMessage({ command: 'suggestNextSteps', suggestions });
      }
    },
    onProgressSummary: (summary) => {
      state.postMessage({ command: 'agentProgress', content: summary });
    },
    onEditPlan: (plan) => {
      flushTextBuffer();
      state.postMessage({
        command: 'editPlanCard',
        editPlan: {
          edits: plan.edits.map((e) => ({
            path: e.path,
            op: e.op,
            rationale: e.rationale,
            dependsOn: e.dependsOn.slice(),
          })),
        },
      });
    },
    onEditPlanProgress: (update) => {
      state.postMessage({
        command: 'editPlanProgress',
        editProgress: {
          path: update.path,
          status: update.status,
          errorMessage: update.errorMessage,
        },
      });
    },
    onStreamFailure: (partial, error) => {
      flushTextBuffer();
      state.pendingPartialAssistant = partial;
      // Stash any pending steers so /resume can restore them. The
      // live queue is disposed in the run's finally block, which
      // would otherwise drop the user's typed intent on the floor
      // when a backend stream dies mid-turn.
      const snapshot = state.currentSteerQueue?.serialize();
      const steerCount = snapshot?.length ?? 0;
      if (snapshot && snapshot.length > 0) {
        state.pendingSteerSnapshot = snapshot;
      }
      // Surface a resume affordance so the user doesn't have to know about /resume
      state.postMessage({
        command: 'assistantMessage',
        content: `\n\n⚠️ Stream interrupted: ${error.message}\n\nType \`/resume\` or click **Resume** below to continue from where it left off.\n\n`,
      });
      state.postMessage({ command: 'resumeAvailable', steerCount });
      if (verbose) {
        verboseLog(
          'Stream failure captured',
          `Saved ${partial.length} chars of partial assistant content. Run /resume to continue from the cutoff. Error: ${error.message}`,
        );
      }
    },
    onCheckpoint: async (summary, _used, remaining) => {
      try {
        const choice = await state.requestConfirm(
          `**Checkpoint:** ${summary}\n\n${remaining} iterations remaining. Continue?`,
          ['Continue', 'Stop here'],
        );
        return choice === 'Continue';
      } catch {
        return true;
      }
    },
    onDone: () => {
      flushTextBuffer();
      state.postMessage({ command: 'done' });
    },
  };
}
