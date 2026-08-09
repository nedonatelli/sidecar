import * as fs from 'node:fs';
import * as path from 'node:path';
import { runAgentLoop, type AgentCallbacks, type AgentOptions } from '../../src/agent/loop.js';
import { parsePlanFromText } from '../../src/agent/plans/externalPlan.js';
import { SideCarClient } from '../../src/ollama/client.js';
import type { ChatMessage } from '../../src/ollama/types.js';
import { ToolRuntime } from '../../src/agent/tools/runtime.js';
import { installSandbox, type WorkspaceFixture } from './workspaceSandbox.js';
import type { AgentEvalCase, AgentCaseResult, TrajectoryEvent } from './agentTypes.js';
import { scoreAgentCase } from './agentScorers.js';
import { buildBaseSystemPrompt } from '../../src/webview/handlers/basePrompt.js';
import { getConfig } from '../../src/config/settings.js';
import { needsColdStart, hasProblematicThinking } from '../../src/config/modelAgentBehavior.js';

// ---------------------------------------------------------------------------
// Agent-loop eval runner.
//
// Drives one AgentEvalCase end-to-end:
//
//   1. Pick a backend + model from env vars (defaults to local Ollama
//      because agent-loop evals burn real tokens and we want the
//      default dev experience to be free).
//   2. Install the workspace sandbox so tool calls land in a temp
//      dir instead of the real project tree.
//   3. Construct a SideCarClient pointed at the chosen backend.
//   4. Build trajectory-recording AgentCallbacks.
//   5. Invoke runAgentLoop with approvalMode='autonomous' so tools
//      execute without the interactive confirmation modal.
//   6. Tear down the sandbox, tally the trajectory against the
//      case's expectations, and return an AgentCaseResult.
//
// Failure modes are surfaced distinctly: infra errors (backend
// unreachable, sandbox setup failed) throw up to the caller, which
// the vitest runner treats as "not a regression, infra broke"; case
// failures (the model's trajectory didn't match expectations) return
// a result with passed=false and the scorer's failure list. This
// mirrors prompt.eval.ts's split between "network failed" and
// "response regressed".
// ---------------------------------------------------------------------------

/** Where to point the SideCarClient for the eval run. */
export interface AgentEvalBackend {
  readonly name: 'ollama' | 'anthropic' | 'openai' | 'groq' | 'fireworks' | 'openrouter' | 'gemini';
  available(): boolean;
  baseUrl(): string;
  apiKey(): string;
  defaultModel(): string;
}

class OllamaAgentBackend implements AgentEvalBackend {
  readonly name = 'ollama' as const;
  available(): boolean {
    // We can't reliably probe the daemon synchronously without adding
    // async to the signature, so treat Ollama as "available unless
    // explicitly disabled". The actual connection error surfaces in
    // the first streamChat call with a clear message.
    const b = process.env.SIDECAR_EVAL_BACKEND;
    return (
      b !== 'anthropic' && b !== 'openai' && b !== 'groq' && b !== 'fireworks' && b !== 'openrouter' && b !== 'gemini'
    );
  }
  baseUrl(): string {
    return process.env.SIDECAR_EVAL_BASE_URL || 'http://localhost:11434';
  }
  apiKey(): string {
    return 'ollama';
  }
  defaultModel(): string {
    return process.env.SIDECAR_EVAL_MODEL || 'ministral-3:latest';
  }
}

class AnthropicAgentBackend implements AgentEvalBackend {
  readonly name = 'anthropic' as const;
  available(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }
  baseUrl(): string {
    return process.env.SIDECAR_EVAL_BASE_URL || 'https://api.anthropic.com';
  }
  apiKey(): string {
    return process.env.ANTHROPIC_API_KEY || '';
  }
  defaultModel(): string {
    return process.env.SIDECAR_EVAL_MODEL || 'claude-haiku-4-5-20251001';
  }
}

class OpenAIAgentBackend implements AgentEvalBackend {
  readonly name = 'openai' as const;
  available(): boolean {
    return Boolean(process.env.OPENAI_API_KEY);
  }
  baseUrl(): string {
    return process.env.SIDECAR_EVAL_BASE_URL || 'https://api.openai.com';
  }
  apiKey(): string {
    return process.env.OPENAI_API_KEY || '';
  }
  defaultModel(): string {
    return process.env.SIDECAR_EVAL_MODEL || 'gpt-4o-mini';
  }
}

class GroqAgentBackend implements AgentEvalBackend {
  readonly name = 'groq' as const;
  available(): boolean {
    return Boolean(process.env.GROQ_API_KEY);
  }
  baseUrl(): string {
    return process.env.SIDECAR_EVAL_BASE_URL || 'https://api.groq.com/openai';
  }
  apiKey(): string {
    return process.env.GROQ_API_KEY || '';
  }
  defaultModel(): string {
    return process.env.SIDECAR_EVAL_MODEL || 'llama-3.3-70b-versatile';
  }
}

class FireworksAgentBackend implements AgentEvalBackend {
  readonly name = 'fireworks' as const;
  available(): boolean {
    return Boolean(process.env.FIREWORKS_API_KEY);
  }
  baseUrl(): string {
    return process.env.SIDECAR_EVAL_BASE_URL || 'https://api.fireworks.ai/inference';
  }
  apiKey(): string {
    return process.env.FIREWORKS_API_KEY || '';
  }
  defaultModel(): string {
    return process.env.SIDECAR_EVAL_MODEL || 'accounts/fireworks/models/deepseek-v4-pro';
  }
}

class OpenRouterAgentBackend implements AgentEvalBackend {
  readonly name = 'openrouter' as const;
  available(): boolean {
    return Boolean(process.env.OPENROUTER_API_KEY);
  }
  baseUrl(): string {
    return process.env.SIDECAR_EVAL_BASE_URL || 'https://openrouter.ai/api';
  }
  apiKey(): string {
    return process.env.OPENROUTER_API_KEY || '';
  }
  defaultModel(): string {
    return process.env.SIDECAR_EVAL_MODEL || 'google/gemini-2.5-flash';
  }
}

class GeminiAgentBackend implements AgentEvalBackend {
  readonly name = 'gemini' as const;
  available(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
  }
  baseUrl(): string {
    return process.env.SIDECAR_EVAL_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai';
  }
  apiKey(): string {
    return process.env.GEMINI_API_KEY || '';
  }
  defaultModel(): string {
    return process.env.SIDECAR_EVAL_MODEL || 'gemini-2.5-flash';
  }
}

export const AGENT_BACKENDS: Record<string, AgentEvalBackend> = {
  ollama: new OllamaAgentBackend(),
  anthropic: new AnthropicAgentBackend(),
  openai: new OpenAIAgentBackend(),
  groq: new GroqAgentBackend(),
  fireworks: new FireworksAgentBackend(),
  openrouter: new OpenRouterAgentBackend(),
  gemini: new GeminiAgentBackend(),
};

/**
 * Pick the first available agent-eval backend. Preference order:
 *   1. Explicit SIDECAR_EVAL_BACKEND env var
 *   2. Ollama (default — free, local, no env var required)
 *   3. Anthropic (if key present)
 *   4. OpenAI (if key present)
 *
 * Returns null only when an explicit backend was requested but its
 * credentials are missing. The default Ollama path always reports
 * available (actual reachability surfaces as a streamChat error).
 */
export function pickAgentBackend(): AgentEvalBackend | null {
  const explicit = process.env.SIDECAR_EVAL_BACKEND;
  if (explicit && AGENT_BACKENDS[explicit]) {
    const b = AGENT_BACKENDS[explicit];
    return b.available() ? b : null;
  }
  // Ollama first (always-on default), then paid backends as fallback.
  for (const name of ['ollama', 'anthropic', 'openai'] as const) {
    const b = AGENT_BACKENDS[name];
    if (b.available()) return b;
  }
  return null;
}

/**
 * Per-case wall-clock budget. Set SIDECAR_EVAL_CASE_TIMEOUT (milliseconds) to
 * override. Distinct from the ITERATION ceiling (`DEFAULT_MAX_ITERATIONS`,
 * raised to 50) — a run can finish well inside its iteration budget and still
 * be cut off by this one, and conflating the two hides which limit bound a
 * result.
 */
export const DEFAULT_CASE_TIMEOUT_MS = (() => {
  const raw = process.env.SIDECAR_EVAL_CASE_TIMEOUT;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  // Was 120s, then 300s when evals moved to THINKING ON — matching the shipped
  // default (`sidecar.ollama.disableThinking` is false for real users). Extended
  // reasoning costs ~25-30s per turn, so the old 120s budget traded a known bias
  // for a worse one: timeouts that read as capability failures.
  //
  // 600s now, because 300s was still binding and was measured doing so:
  //   - ministral-3 hit it on ~29% of its cases in the 2026-08-04 sweep
  //   - claude-sonnet-5 hit it on `run-tests-after-fix` at 300006ms — a
  //     FRONTIER model brushing the cap on a case whose whole purpose is
  //     shelling out to a test runner
  //
  // That last one is the argument. A limit a frontier model reaches is not
  // separating capable models from incapable ones, it is measuring how long a
  // subprocess takes. Nothing observed needed more than 600s once the machine
  // stayed awake.
  //
  // A cap-hit is NOT automatically a failure: the abort stops the loop and the
  // workspace is scored as it stands, so a truncated run can still pass — which
  // is exactly why this was easy to miss. Per-model exceptions belong in
  // MODELS_WITH_PROBLEMATIC_THINKING.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
})();

/**
 * Config overrides applied to EVERY case in this process, on top of each
 * case's own `configOverrides` (env wins). Lets any eval file sweep feature
 * flags without editing cases:
 *
 *   SIDECAR_EVAL_CONFIG_OVERRIDES='{"criticEnabled":true}' npm run eval:guardprobe
 *   SIDECAR_EVAL_CONFIG_OVERRIDES='{"planExternalizedEnabled":true}' npm run eval:smoke
 *
 * Malformed JSON throws at module load — a silent fallback would run the
 * whole sweep under the wrong arm and label the results as if it hadn't.
 */
const ENV_CONFIG_OVERRIDES = (() => {
  const raw = process.env.SIDECAR_EVAL_CONFIG_OVERRIDES;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`SIDECAR_EVAL_CONFIG_OVERRIDES is not valid JSON: ${raw}`);
  }
})();

/**
 * The run-level config a case executes under, minus the case's own overrides.
 *
 * Built here rather than by the caller so provenance is described by the same
 * layering the run uses. Per-case `configOverrides` are excluded on purpose:
 * they belong to the case, are versioned in git beside it, and so are identical
 * across two runs of the same committed cases — whereas the layers below them
 * are exactly what varies run to run.
 */
export function runConfigForProvenance(): Record<string, unknown> {
  return { ...getConfig(), sandboxEnabled: false, ...ENV_CONFIG_OVERRIDES } as Record<string, unknown>;
}

/**
 * True when a run died because the infrastructure was unavailable, not because
 * the model behaved incorrectly.
 *
 * The list is wider than "the request failed" on purpose. One `fetch failed`
 * trips SideCar's own circuit breaker, and every case after it dies with
 * "backend is temporarily disabled after repeated failures" — a message that
 * matched none of the original patterns. A full ceiling run therefore reported
 * "16 failed | 55 passed" when the truth was 54 passes and one network blip,
 * with nothing in the summary to tell the two apart.
 *
 * The breaker is infrastructure announcing that infrastructure is down. It must
 * never be readable as a regression.
 */
/**
 * Marker on the error `runAgentCase` throws for infra breakage, so a caller can
 * recognise it without matching prose.
 *
 * The throw is deliberate: in `agent.eval.ts` every case is its own `it`, so it
 * fails that one test and the suite carries on. The BASELINE recorder runs all
 * cases inside a single `it`, so the same throw killed the entire model run —
 * llama3.2 died at case 16 of 70 on "This operation was aborted" and left a
 * 16-case file where a 69-case one had been. Wrapping strips `err.name`, so
 * `isInfraFailure` cannot recognise the re-thrown error either; hence a marker.
 */
export const INFRA_FAILURE_PREFIX = 'Agent run failed (infra, not a regression): ';

/** True when an error is the wrapped infra failure thrown by `runAgentCase`. */
export function isWrappedInfraFailure(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith(INFRA_FAILURE_PREFIX);
}

export function isInfraFailure(err: Error): boolean {
  if (err.name === 'AbortError') return true;
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|timed out|terminated|temporarily disabled after repeated failures|\b429\b|too many requests|overloaded|service unavailable|\b50[23]\b/i.test(
    err.message,
  );
}

/**
 * Persist one case run's full trajectory as a JSONL line when
 * SIDECAR_EVAL_TRAJECTORY_DIR is set. Append-mode so multi-model sweeps
 * accumulate into one grep-able file — any future "do models actually
 * do X?" question gets answered by jq over this file instead of a new
 * scorer. Non-fatal on write failure: trajectories are telemetry, the
 * case result is the primary output.
 */
function dumpTrajectory(
  caseId: string,
  model: string,
  backendName: string,
  result: AgentCaseResult,
  configOverrides?: AgentEvalCase['configOverrides'],
): void {
  // Capture by DEFAULT. This used to require SIDECAR_EVAL_TRAJECTORY_DIR to be
  // set, so the question the comment above promises to answer — "do models
  // actually do X?" — could not be answered for any run where someone forgot the
  // variable, which was most of them. A full ceiling run finished with no
  // trajectories and the tool-usage question unanswerable. Set the variable to
  // 'off' to opt out.
  const configured = process.env.SIDECAR_EVAL_TRAJECTORY_DIR;
  if (configured === 'off') return;
  const dir = configured || '.sidecar/logs/eval-trajectories';
  try {
    fs.mkdirSync(dir, { recursive: true });
    const mergedOverrides = { ...configOverrides, ...ENV_CONFIG_OVERRIDES };
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      caseId,
      model,
      backend: backendName,
      // The active config arm — without this, sweep runs across option
      // variants would be indistinguishable in the accumulated JSONL.
      ...(Object.keys(mergedOverrides).length > 0 ? { configOverrides: mergedOverrides } : {}),
      passed: result.passed,
      ...(result.apiUnavailable ? { apiUnavailable: true } : {}),
      durationMs: result.durationMs,
      iterationsUsed: result.iterationsUsed,
      trajectory: result.trajectory,
    });
    fs.appendFileSync(path.join(dir, 'trajectories.jsonl'), line + '\n');
  } catch {
    // Telemetry only — never fail a case over a dump-write error.
  }
}

/**
 * Run one agent-loop eval case end-to-end. Throws on infrastructure
 * errors (sandbox setup, backend unreachable); returns a pass/fail
 * result otherwise.
 *
 * @param evalCase  The eval case to run.
 * @param backend   The backend to use for the run.
 * @param timeoutMs  Milliseconds before the run is aborted. Defaults to
 *   `DEFAULT_CASE_TIMEOUT_MS` (120 000 ms, or SIDECAR_EVAL_CASE_TIMEOUT).
 * @param modelOverride  Override the backend's `defaultModel()`. Pass
 *   explicitly when running a comparison across multiple models on the
 *   same backend so each call uses a different model without mutating
 *   the backend object.
 */
export async function runAgentCase(
  evalCase: AgentEvalCase,
  backend: AgentEvalBackend,
  timeoutMs?: number,
  modelOverride?: string,
): Promise<AgentCaseResult>;
/** @deprecated Pass timeoutMs as the third argument. */
export async function runAgentCase(
  evalCase: AgentEvalCase,
  backend: AgentEvalBackend,
  timeoutMsOrOpts?: number,
  modelOverride?: string,
): Promise<AgentCaseResult> {
  const timeoutMs = timeoutMsOrOpts ?? DEFAULT_CASE_TIMEOUT_MS;
  const start = Date.now();
  const sandbox = await installSandbox(evalCase.workspace, evalCase.id);

  if (evalCase.setupCommands?.length) {
    const { execSync } = await import('node:child_process');
    for (const cmd of evalCase.setupCommands) {
      execSync(cmd, { cwd: sandbox.root, stdio: 'pipe' });
    }
  }

  let snapshot: WorkspaceFixture = {};
  const trajectory: TrajectoryEvent[] = [];
  const textBuffer: string[] = [];
  let iterationsUsed = 0;

  const toolRuntime = new ToolRuntime(sandbox.root);
  const model = modelOverride ?? backend.defaultModel();
  const client = new SideCarClient(model, backend.baseUrl(), backend.apiKey());
  const promptConfig = { ...getConfig(), ...evalCase.configOverrides, ...ENV_CONFIG_OVERRIDES } as Record<
    string,
    unknown
  >;
  let systemPrompt = buildBaseSystemPrompt({
    isLocal: backend.name === 'ollama',
    extensionVersion: '0.0.0-eval',
    repoUrl: '',
    docsUrl: '',
    root: sandbox.root,
    approvalMode: evalCase.approvalMode || 'autonomous',
    wholeFileRewrite: promptConfig.wholeFileRewriteStrategyEnabled === true,
  });
  // Inject SIDECAR.md when present in the workspace fixture, mirroring
  // what injectSystemContext does in production for real workspaces.
  if (evalCase.workspace['SIDECAR.md']) {
    systemPrompt += `\n\nProject instructions (from SIDECAR.md):\n${evalCase.workspace['SIDECAR.md']}`;
  }
  client.updateSystemPrompt(systemPrompt);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let clarifyFnCalled = false;

  const callbacks: AgentCallbacks = {
    onText: (text) => {
      textBuffer.push(text);
      trajectory.push({ type: 'text', text });
    },
    onThinking: (thinking) => {
      trajectory.push({ type: 'thinking', thinking });
    },
    onToolCall: (name, input, id) => {
      trajectory.push({ type: 'tool_call', name, input, id });
    },
    onToolResult: (name, result, isError, id) => {
      trajectory.push({ type: 'tool_result', name, result, isError, id });
    },
    onIterationStart: (info) => {
      iterationsUsed = info.iteration;
    },
    onDone: () => {
      trajectory.push({ type: 'done' });
    },
  };

  const options: AgentOptions = {
    approvalMode: evalCase.approvalMode || 'autonomous',
    // No eval-only cap. This was `|| 8` — three times below the shipped
    // DEFAULT_MAX_ITERATIONS of 25 — so 62 of 154 local failures across 32 cases
    // were runs cut off mid-work, recorded as "this model cannot do this". Only
    // one of those cases asks for 8. Whenever a case was seen running out, it
    // got an explicit `maxIterations: 12`; the fallback that caused it never
    // moved, so the fix kept landing on the symptom. Omitting the field lets the
    // loop apply DEFAULT_MAX_ITERATIONS, which is what a user gets.
    ...(evalCase.maxIterations ? { maxIterations: evalCase.maxIterations } : {}),
    ...(evalCase.maxTokens ? { maxTokens: evalCase.maxTokens } : {}),
    ...(evalCase.seedPlanText &&
    (evalCase.configOverrides as { planExternalizedEnabled?: boolean } | undefined)?.planExternalizedEnabled
      ? { initialPlan: parsePlanFromText(evalCase.seedPlanText) ?? undefined }
      : {}),
    toolRuntime,
    ...(evalCase.mcpManager ? { mcpManager: evalCase.mcpManager } : {}),
    // Permissive confirmFn for the rare case an irrecoverable-gate
    // or alwaysRequireApproval tool fires under autonomous mode.
    confirmFn: async () => 'Allow',
    // Cooperative clarifyFn: the test plays a helpful user. A clarifying
    // question is a legitimate move (better than guessing wrong), so we answer
    // it and let the agent continue — the case measures whether the model
    // ultimately addresses the issue, not whether it avoided asking. Cases can
    // supply a specific `clarifyResponse`; the default nudges it to proceed.
    // (The reply surfaces in the trajectory as the ask_user tool_result.)
    clarifyFn: async (question: string, clarifyOptions: string[] = []) => {
      clarifyFnCalled = true;
      const cr = evalCase.clarifyResponse;
      return typeof cr === 'function'
        ? cr(question, clarifyOptions)
        : (cr ?? 'Yes — go ahead and answer based on what you found. Use your best judgment.');
    },
    // Disable macOS seatbelt for eval runs — the sandbox is already a
    // controlled temp dir; seatbelt wrapping causes shell init hangs
    // when the ShellSession CWD is /var/folders (not the VS Code workspace).
    config: { ...getConfig(), sandboxEnabled: false, ...evalCase.configOverrides, ...ENV_CONFIG_OVERRIDES },
  };

  // Determine whether this model needs a cold start (no prior context).
  // Models like gemma4:e4b perform WORSE with setup messages — prior context
  // switches them from tool-use mode to chat-response mode.
  const coldStart = needsColdStart(model);
  const keepSetup = evalCase.setupMessages && (!coldStart || evalCase.setupMessagesRequired);
  const initialMessages: ChatMessage[] = [
    ...(keepSetup ? evalCase.setupMessages! : []),
    { role: 'user', content: evalCase.userMessage },
  ];

  // Suppress thinking mode for models where it causes stalling or text-only output.
  if (hasProblematicThinking(model) && options.config) {
    options.config = { ...options.config, ollamaDisableThinking: true };
  } else if (hasProblematicThinking(model)) {
    options.config = { ...getConfig(), ollamaDisableThinking: true };
  }

  let runError: Error | null = null;
  try {
    await runAgentLoop(client, initialMessages, callbacks, abort.signal, options);

    // Cooperative user, text channel: a run that ENDS on a genuine clarifying
    // question (rather than routing it through ask_user) used to dead-end —
    // ministral and ornith both identified the ambiguity, named the real
    // candidates, asked correctly in chat text, and were scored as if they had
    // done nothing (ask-user-ambiguous-rename, 2026-08-07). A real user would
    // simply reply. The harness now does the same, once: answer the question
    // and let the loop continue, so the case measures whether the model USES
    // the answer — the same bar the ask_user path has always had. Guarded to
    // question-shaped endings with a clarify signal, so a "shall I proceed?"
    // permission stall does not earn a free continuation hint.
    if (!abort.signal.aborted && evalCase.clarifyResponse !== undefined && !clarifyFnCalled) {
      const finalTail = textBuffer.join('').slice(-400);
      // Interrogative ("Which one…?") or imperative ("please clarify which…")
      // — ministral asks correctly with no question mark at all.
      const isClarifyingQuestion =
        (/\?/.test(finalTail) || /\bplease (clarify|specify|confirm)\b/i.test(finalTail)) &&
        /\b(which|clarif\w*|specify|did you mean|choose|prefer)\b/i.test(finalTail);
      if (isClarifyingQuestion) {
        const cr = evalCase.clarifyResponse;
        const answer = typeof cr === 'function' ? cr(finalTail, []) : cr;
        trajectory.push({ type: 'text', text: `\n[cooperative user reply] ${answer}\n` });
        const continuation: ChatMessage[] = [
          ...initialMessages,
          { role: 'assistant', content: textBuffer.join('') },
          { role: 'user', content: answer },
        ];
        await runAgentLoop(client, continuation, callbacks, abort.signal, options);
      }
    }
  } catch (err) {
    runError = err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
    snapshot = await sandbox.snapshot().catch(() => ({}));
    await sandbox.teardown();
    toolRuntime.dispose();
  }

  const durationMs = Date.now() - start;

  // Detect API unavailability: the run used most of its timeout budget but the
  // model produced zero output (no text, tool calls, or results). This pattern
  // — empty trajectory + long duration — means the API was hanging (overloaded,
  // rate-limit queue, cold start) rather than the model behaving incorrectly.
  // Flagging these separately lets the report exclude them from pass/fail and
  // lets the circuit breaker in agent.eval.ts stop early when the API is down.
  const hasModelContent = trajectory.some(
    (e) => e.type === 'text' || e.type === 'tool_call' || e.type === 'tool_result',
  );
  const apiUnavailable = !hasModelContent && durationMs >= timeoutMs * 0.8;

  if (runError) {
    // Re-throw infra errors (aborts, network failures) so the runner
    // treats them as infra breakage rather than case regressions.
    // The distinction matches prompt.eval.ts's pattern.
    if (isInfraFailure(runError)) {
      throw new Error(`${INFRA_FAILURE_PREFIX}${runError.message}`);
    }
    // Everything else counts as a case failure — record it so the
    // report shows which case died and why.
    const errorResult: AgentCaseResult = {
      id: evalCase.id,
      description: evalCase.description,
      passed: false,
      failures: [`runAgentLoop threw: ${runError.message}`],
      softFailures: [],
      trajectory,
      finalText: textBuffer.join(''),
      workspaceAfter: snapshot,
      durationMs,
      iterationsUsed,
    };
    dumpTrajectory(evalCase.id, model, backend.name, errorResult, evalCase.configOverrides);
    return errorResult;
  }

  const scored = scoreAgentCase(evalCase, {
    trajectory,
    finalText: textBuffer.join(''),
    workspaceAfter: snapshot,
    durationMs,
    iterationsUsed,
  });
  const finalResult = apiUnavailable ? { ...scored, apiUnavailable: true } : scored;
  dumpTrajectory(evalCase.id, model, backend.name, finalResult, evalCase.configOverrides);
  return finalResult;
}
