// Genuine multi-turn / long-horizon harness.
//
// The existing runner drives ONE user turn: the agent's own output never becomes
// the context for a following turn, the sandbox is thrown away, and compression
// never fires because the conversation never gets long. So the entire subject of
// the `long-horizon-state` branch — context accumulating across real turns,
// compression mid-conversation, <plan_state> surviving a summarization pass,
// episodic recall of an early fact — has had NO coverage. The four "multi-turn"
// cases inject a FABRICATED history and then run a single turn; they test
// latching, not long horizon.
//
// This harness runs a real conversation: install the sandbox ONCE, then for each
// user turn append it to the running message history, invoke the agent loop, and
// thread the returned history (assistant text + tool_use + tool_result, plus any
// compression the loop performed) into the next turn. Each turn is scored on its
// own expectations, against the workspace as it stands AFTER that turn's edits.
//
// The instrument's own honesty rule: a case tagged as exercising compression must
// actually TRIGGER it. `onCompression` is observed and the count returned, so a
// "survives compression" case that never compressed is reported as vacuous rather
// than a spurious pass — the same discipline as refusing a lift with no discordant
// pairs.

import type { ChatMessage } from '../../src/ollama/types.js';
import type { AgentCallbacks, AgentOptions } from '../../src/agent/loop.js';
import { runAgentLoop } from '../../src/agent/loop.js';
import { SideCarClient } from '../../src/ollama/client.js';
import { ToolRuntime } from '../../src/agent/tools/runtime.js';
import { buildBaseSystemPrompt } from '../../src/webview/handlers/basePrompt.js';
import { getConfig } from '../../src/config/settings.js';
import { hasProblematicThinking } from '../../src/config/modelAgentBehavior.js';
import { installSandbox, type WorkspaceFixture } from './workspaceSandbox.js';
import { scoreAgentCase } from './agentScorers.js';
import type { AgentEvalBackend } from './agentHarness.js';
import { DEFAULT_CASE_TIMEOUT_MS } from './agentHarness.js';
import type { AgentExpectations, TrajectoryEvent } from './agentTypes.js';

export interface LongHorizonTurn {
  /** What the user says on this turn. */
  userMessage: string;
  /** Assertions scored against the state AFTER this turn. Same shape as single-turn. */
  expect: AgentExpectations;
  /** Optional label for the report. */
  label?: string;
}

export interface LongHorizonCase {
  id: string;
  description: string;
  tags: string[];
  /** Starting workspace, shared and mutated across every turn. */
  workspace: WorkspaceFixture;
  turns: LongHorizonTurn[];
  /** Per-turn overrides (e.g. a low compression threshold to force it early). */
  configOverrides?: Record<string, unknown>;
  /**
   * When true, the case CLAIMS to exercise compression: the run is only
   * meaningful if compression actually fired at least once. Reported vacuous
   * otherwise, never a silent pass.
   */
  requiresCompression?: boolean;
}

export interface LongHorizonTurnResult {
  index: number;
  label: string;
  passed: boolean;
  failures: string[];
  /** Tool-call trajectory for this turn — kept so a FAILED turn can be diagnosed
   *  ("what did the model actually do?") instead of only reporting the assertion. */
  trajectory: TrajectoryEvent[];
}

export interface LongHorizonResult {
  caseId: string;
  passed: boolean;
  turns: LongHorizonTurnResult[];
  /** How many times context compression fired across the whole conversation. */
  compressionCount: number;
  /** Total user+assistant+tool turns in the final history — the horizon actually reached. */
  finalHistoryLength: number;
  /** Set when requiresCompression is true but compression never fired: the case proved nothing. */
  vacuous: boolean;
  apiUnavailable: boolean;
  durationMs: number;
  /**
   * How many edit_file results carried the outcome-visibility diff ("What
   * changed…") across the WHOLE run. Observable regardless of pass/fail, so an
   * off/on A/B of `editFile.resultDiffChars` can VERIFY the flag actually fired —
   * grepping the log for the marker fails on a passing run, whose tool results are
   * never dumped. Verify the mechanism, don't assume it.
   */
  editDiffShownCount: number;
  /**
   * How many times the edit→write steer fired (maybeSteerEditToWrite's onText
   * marker) across the run — the mechanism-fired signal for the
   * `editFile.steerToWrite` A/B. Same rationale as editDiffShownCount: a null
   * A/B result is worthless until firing counts prove the arm was live.
   */
  steerFiredCount: number;
  /**
   * How many times the action reprompt fired (maybeInjectActionReprompt's onText
   * marker) across the run — observable evidence for the code-as-text guard A/B.
   */
  actionRepromptFiredCount: number;
}

/**
 * Drive one long-horizon case as a real conversation. Reuses the single-turn
 * setup (sandbox, client, system prompt, thinking/cold-start handling) and adds
 * the turn loop + threaded history that make it long-horizon.
 */
export async function runLongHorizonCase(
  lhCase: LongHorizonCase,
  backend: AgentEvalBackend,
  timeoutMs = DEFAULT_CASE_TIMEOUT_MS,
  modelOverride?: string,
): Promise<LongHorizonResult> {
  const start = Date.now();
  const sandbox = await installSandbox(lhCase.workspace, lhCase.id);
  const toolRuntime = new ToolRuntime(sandbox.root);
  const model = modelOverride ?? backend.defaultModel();
  const client = new SideCarClient(model, backend.baseUrl(), backend.apiKey());

  // SIDECAR_EVAL_CONFIG_OVERRIDES lets a run toggle a scaffold without editing
  // cases — e.g. testing whether plan.externalized (which re-injects plan state
  // every turn to survive compaction) fixes the long-horizon memory failures.
  // Computed BEFORE the system prompt so prompt-level strategies
  // (wholeFileRewriteStrategyEnabled) are overridable per-run too.
  const envOverrides = (() => {
    const raw = process.env.SIDECAR_EVAL_CONFIG_OVERRIDES;
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`SIDECAR_EVAL_CONFIG_OVERRIDES is not valid JSON: ${raw}`);
    }
  })();
  let baseConfig = { ...getConfig(), sandboxEnabled: false, ...lhCase.configOverrides, ...envOverrides };

  let systemPrompt = buildBaseSystemPrompt({
    isLocal: backend.name === 'ollama',
    extensionVersion: '0.0.0-eval',
    repoUrl: '',
    docsUrl: '',
    root: sandbox.root,
    approvalMode: 'autonomous',
    wholeFileRewrite: baseConfig.wholeFileRewriteStrategyEnabled === true,
  });
  if (lhCase.workspace['SIDECAR.md']) {
    systemPrompt += `\n\nProject instructions (from SIDECAR.md):\n${lhCase.workspace['SIDECAR.md']}`;
  }
  client.updateSystemPrompt(systemPrompt);
  if (hasProblematicThinking(model)) baseConfig = { ...baseConfig, ollamaDisableThinking: true };
  // NB: cold-start models (gemma4) perform worse WITH prior context — but a
  // long-horizon test is prior context by definition, so we deliberately do NOT
  // strip history here the way the single-turn harness does. If gemma4 degrades
  // across turns, that degradation IS the finding, not a harness artifact to hide.

  let messages: ChatMessage[] = [];
  const turnResults: LongHorizonTurnResult[] = [];
  let compressionCount = 0;
  let peakTokens = 0;
  let apiUnavailable = false;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    for (let t = 0; t < lhCase.turns.length; t++) {
      const turn = lhCase.turns[t];
      const trajectory: TrajectoryEvent[] = [];
      const textBuffer: string[] = [];

      // Compression has no callback — it fires internally. Its observable trace
      // is `estimatedTokens` DROPPING between iterations: applyBudgetCompression
      // summarizes old turns, so the next iteration reports a lower count. Track
      // the running peak and count a compaction each time the estimate falls back
      // by more than a fifth of the peak. Heuristic, but grounded in a real signal
      // rather than a callback that does not exist.
      const callbacks: AgentCallbacks = {
        onText: (text) => {
          textBuffer.push(text);
          trajectory.push({ type: 'text', text });
        },
        onToolCall: (name, input, id) => trajectory.push({ type: 'tool_call', name, input, id }),
        onToolResult: (name, result, isError, id) =>
          trajectory.push({ type: 'tool_result', name, result, isError, id }),
        onIterationStart: (info) => {
          if (info.estimatedTokens > peakTokens) peakTokens = info.estimatedTokens;
          else if (peakTokens - info.estimatedTokens > peakTokens * 0.2) {
            compressionCount++;
            peakTokens = info.estimatedTokens;
          }
        },
        onDone: () => trajectory.push({ type: 'done' }),
      };

      const options: AgentOptions = {
        approvalMode: 'autonomous',
        maxIterations: 8,
        toolRuntime,
        confirmFn: async () => 'Allow',
        clarifyFn: async () => 'Yes — go ahead and answer based on what you found.',
        config: baseConfig,
      };

      messages.push({ role: 'user', content: turn.userMessage });
      let updated: ChatMessage[];
      try {
        updated = await runAgentLoop(client, messages, callbacks, abort.signal, options);
      } catch {
        apiUnavailable = true;
        break;
      }
      // Thread the FULL returned history (incl. any compression) into the next turn.
      messages = updated;

      const snapshot = await sandbox.snapshot().catch(() => ({}));
      const scored = scoreAgentCase(
        {
          id: `${lhCase.id}#${t}`,
          description: turn.label ?? '',
          tags: lhCase.tags,
          workspace: lhCase.workspace,
          userMessage: turn.userMessage,
          expect: turn.expect,
        },
        // Field is `workspaceAfter`, not `workspace` — the scorer reads
        // run.workspaceAfter[path], so the wrong name made every file assertion
        // throw "Cannot read properties of undefined". (Caught by the sonnet
        // ceiling check: a frontier model "failing" all four cases meant the
        // harness was broken, not the model — which is why the ceiling check runs
        // first.)
        { finalText: textBuffer.join(''), trajectory, workspaceAfter: snapshot, iterationsUsed: 0, durationMs: 0 },
      );
      turnResults.push({
        index: t,
        label: turn.label ?? `turn ${t + 1}`,
        passed: scored.passed,
        failures: scored.failures,
        trajectory,
      });
      if (!scored.passed) {
        // A failed turn poisons everything downstream (the conversation diverges),
        // so stop and report — continuing would score noise.
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    await sandbox.teardown();
    toolRuntime.dispose();
  }

  return summarizeLongHorizon({
    caseId: lhCase.id,
    totalTurns: lhCase.turns.length,
    requiresCompression: Boolean(lhCase.requiresCompression),
    turns: turnResults,
    compressionCount,
    finalHistoryLength: messages.length,
    apiUnavailable,
    durationMs: Date.now() - start,
  });
}

/**
 * Compute the verdict from a completed run's raw counts. Pure, so the honesty
 * rules can be unit-tested without a model:
 *
 *   - a case that REQUIRES compression but never triggered it is VACUOUS — it
 *     proved nothing, and must not be scored as a pass;
 *   - a case passes only when EVERY turn passed (a failed turn stops the run);
 *   - api-unavailable is neither pass nor fail.
 */
export function summarizeLongHorizon(input: {
  caseId: string;
  totalTurns: number;
  requiresCompression: boolean;
  turns: LongHorizonTurnResult[];
  compressionCount: number;
  finalHistoryLength: number;
  apiUnavailable: boolean;
  durationMs: number;
}): LongHorizonResult {
  const vacuous = input.requiresCompression && input.compressionCount === 0;
  const allTurnsPassed =
    input.turns.length === input.totalTurns && input.turns.length > 0 && input.turns.every((r) => r.passed);

  // Count edit_file results that carried the outcome-visibility diff, across every
  // turn's trajectory — the mechanism-fired signal for the editFile.resultDiffChars
  // A/B. Marker matches editDiffSuffix() in fs.ts.
  const editDiffShownCount = input.turns.reduce(
    (n, t) =>
      n +
      t.trajectory.filter(
        (e) => e.type === 'tool_result' && e.name === 'edit_file' && e.result.includes('What changed (verify'),
      ).length,
    0,
  );

  // Mechanism-fired counters for the guard A/Bs — same rationale: a null result
  // is uninterpretable until the firing count proves the arm was live. Markers
  // match the guards' onText notifications (maybeSteerEditToWrite in
  // circularRewrite.ts, maybeInjectActionReprompt in actionReprompt.ts).
  const countTextMarker = (marker: string) =>
    input.turns.reduce(
      (n, t) => n + t.trajectory.filter((e) => e.type === 'text' && e.text.includes(marker)).length,
      0,
    );
  const steerFiredCount = countTextMarker('🛑 edit_file keeps failing');
  const actionRepromptFiredCount = countTextMarker('⚙️ No tool calls detected');

  return {
    caseId: input.caseId,
    passed: allTurnsPassed && !vacuous && !input.apiUnavailable,
    turns: input.turns,
    compressionCount: input.compressionCount,
    finalHistoryLength: input.finalHistoryLength,
    vacuous,
    apiUnavailable: input.apiUnavailable,
    durationMs: input.durationMs,
    editDiffShownCount,
    steerFiredCount,
    actionRepromptFiredCount,
  };
}
