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
import { DurableMemoryStore, renderDurableMemorySection } from '../../src/agent/memory/durableMemory.js';

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
   * Prepend this many characters of canned small-talk exchanges to the history
   * before turn 1. Model-independent compaction forcing: bulky/many case turns
   * both failed to cross the token threshold on terse models (haiku, ministral,
   * qwen — verbosity moves the target), while a static seed's token mass is
   * exact. Pure chit-chat by construction: no instruction-shaped text (latch
   * pollution), no file references (task pollution).
   */
  seedSmallTalkChars?: number;
  /**
   * Inject this many chars of seed exposition INTO the running history after
   * the turn at this index completes. Ordering matters: a leading seed gets
   * summarized while the turn-1 constraint is still in the keep-recent window
   * (observed: splices=1, latched=0 — the compaction consumed only the seed).
   * A mid-seed lands AFTER the constraint, so the next compaction must carry
   * the constraint through summarization — the thing the case tests.
   */
  midSeedAfterTurn?: number;
  midSeedChars?: number;
  /** Multiple seed points — every session that must trigger compaction needs
   *  its own forcing mass (found live: a supersession stated in un-seeded
   *  session 2 never compacted, never persisted, and session 3 got the stale
   *  rule). Each injection uses a distinct part-offset so entries never
   *  collide with earlier seed text. */
  midSeedsAfterTurns?: number[];
  /**
   * Session boundary: after the turn at this index completes, the message
   * history is DISCARDED (fresh session) — only the system prompt survives,
   * including the remembered-instructions section rendered from the sandbox's
   * durable-memory store. Cross-session recall cases hinge on this.
   */
  sessionBoundaryAfterTurn?: number;
  /** Multiple boundaries (supersession cases need rule → boundary → update → boundary → apply). */
  sessionBoundariesAfterTurns?: number[];
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
  /**
   * `## Standing instructions` sections present in the FINAL message history —
   * the mechanism-fired signal for the compaction.durableInstructions A/B
   * (the latch writes into the summary message, which the harness returns).
   */
  standingInstructionsInSummary: number;
  /** Durable-memory entries on disk at case end — the cross-session persist counter. */
  durableMemoryEntries: number;
  /** '[Earlier conversation summary' splices in final history — distinguishes
   *  REAL summarization from the token-drop heuristic's false positives
   *  (tool-result truncation alone also drops tokens). */
  summarySpliceCount: number;
  /**
   * HOW the case failed — a model that eventually reaches the solution is a
   * different animal from one that can't ever reach it, and PASS/FAIL at a
   * fixed budget conflates them (campaigns 3/4: three "failing" models were
   * convergent runs executed by the 480s case budget mid-flight; doubling the
   * budget flipped them to passers with no code change).
   *
   *   converged   — passed
   *   progressing — failed with the failing turn EMPTY or cut off mid-work
   *                 (budget/abort artifact, not a capability verdict)
   *   stuck       — failing turn shows ≥3 errors from one tool on one target
   *                 (the repeat-thrash signature; more budget won't help)
   *   diverged    — failed while actively doing the wrong thing
   */
  failureMode: 'converged' | 'progressing' | 'stuck' | 'diverged';
}

/**
 * Canned seed pairs: calculator-app DESIGN exposition. On-topic prose is the
 * realistic hard case for the summarizer — topically relevant content
 * competing with the constraint — unlike throwaway chit-chat. Still
 * deliberately instruction-free (nothing matches the standing-instruction
 * markers), and it names no workspace files or config values any case
 * asserts on, so the seed adds tokens and messages, never semantics.
 */
const SMALL_TALK: Array<[string, string]> = [
  [
    'Before we get into tasks — how would you sketch the overall design of a small calculator app?',
    'A clean split is three layers: a tokenizer that turns the input string into numbers and operator symbols, a parser that applies precedence to build a tiny expression tree, and an evaluator that walks the tree to produce a result. Keeping the layers separate makes each one easy to reason about, and the evaluator stays a few dozen lines. A thin presentation layer — CLI or buttons — sits on top and stays ignorant of the math underneath.',
  ],
  [
    'How does operator precedence usually get handled in a design like that?',
    'The classic options are recursive descent with one function per precedence level, or the shunting-yard algorithm producing postfix output. Recursive descent reads naturally for a fixed grammar: an expression is a sum of terms, a term is a product of factors, a factor is a number or a parenthesized expression. Precedence falls out of the call structure rather than a table, which keeps surprises low for a calculator-sized grammar.',
  ],
  [
    'What is worth thinking about for the display and formatting side of a calculator?',
    'Formatting is sneakily deep: floating-point results want rounding to a sensible number of significant digits, very large and very small values read better in scientific notation, and trailing zeros are noise to most eyes. A formatting helper that owns those choices keeps the evaluator pure. Locale is a further wrinkle — decimal commas versus points — though a small app can reasonably pick one and note it.',
  ],
  [
    'How would the history or memory feature of a calculator typically work?',
    'A simple append-only list of entry/result pairs covers most needs: recall shows recent computations, and an ans reference lets the next expression reuse the last result. Persistence can be a small file the app reads at startup and writes on exit. The interesting design choice is whether history entries store the raw input, the normalized expression, or both — both is cheap and keeps replay honest.',
  ],
];

/** Build alternating user/assistant small-talk until ~targetChars of content. */
export function buildSmallTalkSeed(targetChars: number, partOffset = 0): ChatMessage[] {
  const out: ChatMessage[] = [];
  let used = 0;
  let i = partOffset;
  while (used < targetChars) {
    const [q, a] = SMALL_TALK[i % SMALL_TALK.length];
    const stamp = i >= SMALL_TALK.length ? ` (part ${Math.floor(i / SMALL_TALK.length) + 1})` : '';
    out.push({ role: 'user', content: q + stamp });
    out.push({ role: 'assistant', content: a });
    used += q.length + a.length;
    i++;
  }
  return out;
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
  const durableMemoryStore = new DurableMemoryStore(`${sandbox.root}/.sidecar/memory`);
  await durableMemoryStore.load();
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
    insertApiV2: baseConfig.insertApiV2Enabled === true,
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

  let messages: ChatMessage[] = lhCase.seedSmallTalkChars ? buildSmallTalkSeed(lhCase.seedSmallTalkChars) : [];
  const turnResults: LongHorizonTurnResult[] = [];
  let compressionCount = 0;
  let peakTokens = 0;
  let apiUnavailable = false;
  let apiUnavailableReason: string | undefined;

  let carriedSplices = 0;
  let carriedLatched = 0;
  let memoryInjected = false;

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
        // The loop's compression budget reads ONLY options.maxTokens (default
        // 100k) — config.agentMaxTokens caps backend OUTPUT tokens, not this.
        // Without this wire the 70% threshold sat at 70k tokens and REAL
        // summarization never fired in any long-horizon eval; every prior
        // "compaction" was tool-result truncation + the token-drop heuristic.
        maxTokens: (baseConfig.agentMaxTokens as number | undefined) ?? 100_000,
        durableMemoryStore,
        toolRuntime,
        confirmFn: async () => 'Allow',
        clarifyFn: async () => 'Yes — go ahead and answer based on what you found.',
        config: baseConfig,
      };

      messages.push({ role: 'user', content: turn.userMessage });
      let updated: ChatMessage[];
      try {
        updated = await runAgentLoop(client, messages, callbacks, abort.signal, options);
      } catch (err) {
        // Never swallow the reason — three "API-UNAVAIL" cells in a row were
        // undiagnosable because this catch discarded the actual exception.
        apiUnavailableReason = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console -- eval diagnostics must reach the log
        console.error(`[longHorizon] run aborted at turn ${t + 1}: ${apiUnavailableReason}`);
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
      if (lhCase.midSeedAfterTurn === t && lhCase.midSeedChars) {
        messages.push(...buildSmallTalkSeed(lhCase.midSeedChars, /* partOffset */ 100));
      }
      const seedIdx = lhCase.midSeedsAfterTurns?.indexOf(t) ?? -1;
      if (seedIdx >= 0 && lhCase.midSeedChars) {
        messages.push(...buildSmallTalkSeed(lhCase.midSeedChars, /* partOffset */ 200 + seedIdx * 100));
      }
      if (lhCase.sessionBoundaryAfterTurn === t || lhCase.sessionBoundariesAfterTurns?.includes(t)) {
        // New session: history gone; remembered instructions re-enter ONLY via
        // the system prompt, exactly as production injects them. Mechanism
        // counters (splices/latched) are CARRIED from the discarded history —
        // the boundary is the point of the test, not an accounting hole
        // (found live: session 1 compacted, final-history scan said VACUOUS).
        for (const m of messages) {
          const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          if (text.includes('[Earlier conversation summary')) carriedSplices++;
          if (text.includes('## Standing instructions')) carriedLatched++;
        }
        messages = [];
        await durableMemoryStore.load();
        const memorySection = renderDurableMemorySection(durableMemoryStore.getEntries());
        memoryInjected = memorySection !== '';
        client.updateSystemPrompt(systemPrompt + memorySection);
      }
    }
  } finally {
    clearTimeout(timer);
    await sandbox.teardown();
    toolRuntime.dispose();
  }

  return summarizeLongHorizon({
    caseId: lhCase.id,
    timeoutMs,
    totalTurns: lhCase.turns.length,
    requiresCompression: Boolean(lhCase.requiresCompression),
    turns: turnResults,
    compressionCount,
    finalHistoryLength: messages.length,
    finalMessages: messages,
    durableMemoryEntries: durableMemoryStore.size(),
    carriedSplices,
    carriedLatched,
    memoryInjected,
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
  /** The case's wall-clock budget — lets the failure-mode classifier detect budget exhaustion. */
  timeoutMs?: number;
  /** Final threaded message history — scanned for mechanism markers (standing-instructions sections). */
  finalMessages?: ChatMessage[];
  durableMemoryEntries?: number;
  carriedSplices?: number;
  carriedLatched?: number;
  memoryInjected?: boolean;
}): LongHorizonResult {
  // Vacuity keys on REAL summarization (summary splices in final history), not
  // the token-drop heuristic — tool-result truncation also drops tokens, and
  // counting it as "compaction" let requiresCompression cases pass while the
  // summarizer never ran (found live: compaction=2, splices=0).
  const preSplices = input.finalMessages
    ? input.finalMessages.reduce((n, m) => {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return n + (text.includes('[Earlier conversation summary') ? 1 : 0);
      }, 0)
    : 0;
  const vacuous = input.requiresCompression && preSplices + (input.carriedSplices ?? 0) === 0;
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

  const summarySpliceCount =
    (input.carriedSplices ?? 0) +
    (input.finalMessages
      ? input.finalMessages.reduce((n, m) => {
          const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          return n + (text.includes('[Earlier conversation summary') ? 1 : 0);
        }, 0)
      : 0);
  const carriedLatchedCount = input.carriedLatched ?? 0;
  const standingInstructionsInSummary =
    carriedLatchedCount +
    ((input.finalMessages
      ? input.finalMessages.reduce((n, m) => {
          const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          return n + (text.includes('## Standing instructions') ? 1 : 0);
        }, 0)
      : 0) ?? 0);

  const passed = allTurnsPassed && !vacuous && !input.apiUnavailable;
  const failureMode = classifyFailureMode(passed, input.turns, {
    durationMs: input.durationMs,
    timeoutMs: input.timeoutMs ?? Number.POSITIVE_INFINITY,
  });

  return {
    caseId: input.caseId,
    passed,
    turns: input.turns,
    compressionCount: input.compressionCount,
    finalHistoryLength: input.finalHistoryLength,
    vacuous,
    apiUnavailable: input.apiUnavailable,
    durationMs: input.durationMs,
    editDiffShownCount,
    steerFiredCount,
    actionRepromptFiredCount,
    failureMode,
    standingInstructionsInSummary,
    summarySpliceCount,
    durableMemoryEntries: input.durableMemoryEntries ?? 0,
  };
}

/**
 * Classify HOW a failed run failed, from signals the harness already records.
 * Pure so the boundaries are unit-testable. See LongHorizonResult.failureMode.
 */
export function classifyFailureMode(
  passed: boolean,
  turns: LongHorizonTurnResult[],
  budget?: { durationMs: number; timeoutMs: number },
): LongHorizonResult['failureMode'] {
  if (passed) return 'converged';
  // Wall-clock exhaustion dominates every other signal: a run that died with
  // its budget consumed is a budget artifact regardless of what its last
  // event was. Live miss (haiku ceiling, 2026-07-24): a machine-sleep-clipped
  // turn showed 3 events for 996s and read as 'diverged' — the frozen clock,
  // not the model, was the story.
  if (budget && budget.durationMs >= budget.timeoutMs * 0.98) return 'progressing';
  const failing = turns.find((t) => !t.passed);
  if (!failing) return 'progressing'; // no turn even ran — aborted before start
  const events = failing.trajectory.filter((e) => e.type !== 'done');
  if (events.length === 0) return 'progressing'; // budget killed the turn before it began
  // Repeat-thrash signature: ≥3 errors from the same tool in the failing turn.
  const errorsByTool = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'tool_result' && e.isError) {
      errorsByTool.set(e.name, (errorsByTool.get(e.name) ?? 0) + 1);
    }
  }
  if ([...errorsByTool.values()].some((n) => n >= 3)) return 'stuck';
  // Active work, few/no errors, still failed: either mid-flight when the
  // budget hit (last event is a call with no result) or genuinely wrong.
  const last = events[events.length - 1];
  if (last.type === 'tool_call') return 'progressing'; // cut off awaiting a result
  return 'diverged';
}
