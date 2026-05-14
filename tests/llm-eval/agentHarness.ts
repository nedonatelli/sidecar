import { runAgentLoop, type AgentCallbacks, type AgentOptions } from '../../src/agent/loop.js';
import { SideCarClient } from '../../src/ollama/client.js';
import type { ChatMessage } from '../../src/ollama/types.js';
import { ToolRuntime } from '../../src/agent/tools/runtime.js';
import { installSandbox, type WorkspaceFixture } from './workspaceSandbox.js';
import type { AgentEvalCase, AgentCaseResult, TrajectoryEvent } from './agentTypes.js';
import { scoreAgentCase } from './agentScorers.js';
import { buildBaseSystemPrompt } from '../../src/webview/handlers/basePrompt.js';
import { getConfig } from '../../src/config/settings.js';

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
    return b !== 'anthropic' && b !== 'openai' && b !== 'groq' && b !== 'fireworks' && b !== 'openrouter' && b !== 'gemini';
  }
  baseUrl(): string {
    return process.env.SIDECAR_EVAL_BASE_URL || 'http://localhost:11434';
  }
  apiKey(): string {
    return 'ollama';
  }
  defaultModel(): string {
    return process.env.SIDECAR_EVAL_MODEL || 'qwen3-coder:30b';
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
 * Per-case timeout override. Set SIDECAR_EVAL_CASE_TIMEOUT (milliseconds) to
 * give slow local models more time to process the large system prompt before
 * the outer AbortController fires. Default is 120 000 ms (2 min), which is
 * comfortable for cloud models but tight for large Ollama models on consumer
 * hardware. Example: SIDECAR_EVAL_CASE_TIMEOUT=300000 for 5 min per case.
 */
export const DEFAULT_CASE_TIMEOUT_MS = (() => {
  const raw = process.env.SIDECAR_EVAL_CASE_TIMEOUT;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
})();

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

  const toolRuntime = new ToolRuntime();
  const model = modelOverride ?? backend.defaultModel();
  const client = new SideCarClient(model, backend.baseUrl(), backend.apiKey());
  let systemPrompt = buildBaseSystemPrompt({
    isLocal: backend.name === 'ollama',
    extensionVersion: '0.0.0-eval',
    repoUrl: '',
    docsUrl: '',
    root: sandbox.root,
    approvalMode: evalCase.approvalMode || 'autonomous',
  });
  // Inject SIDECAR.md when present in the workspace fixture, mirroring
  // what injectSystemContext does in production for real workspaces.
  if (evalCase.workspace['SIDECAR.md']) {
    systemPrompt += `\n\nProject instructions (from SIDECAR.md):\n${evalCase.workspace['SIDECAR.md']}`;
  }
  client.updateSystemPrompt(systemPrompt);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

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
    maxIterations: evalCase.maxIterations || 8,
    toolRuntime,
    // Permissive confirmFn for the rare case an irrecoverable-gate
    // or alwaysRequireApproval tool fires under autonomous mode.
    confirmFn: async () => 'Allow',
    // Merge configOverrides over defaults so cases can opt-in to
    // features off by default (critic, autoFix) without a full config.
    ...(evalCase.configOverrides ? { config: { ...getConfig(), ...evalCase.configOverrides } } : {}),
  };

  const initialMessages: ChatMessage[] = [{ role: 'user', content: evalCase.userMessage }];

  let runError: Error | null = null;
  try {
    await runAgentLoop(client, initialMessages, callbacks, abort.signal, options);
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
    if (runError.name === 'AbortError' || /fetch failed|ECONNREFUSED|timed out/i.test(runError.message)) {
      throw new Error(`Agent run failed (infra, not a regression): ${runError.message}`);
    }
    // Everything else counts as a case failure — record it so the
    // report shows which case died and why.
    return {
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
  }

  const scored = scoreAgentCase(evalCase, {
    trajectory,
    finalText: textBuffer.join(''),
    workspaceAfter: snapshot,
    durationMs,
    iterationsUsed,
  });
  return apiUnavailable ? { ...scored, apiUnavailable: true } : scored;
}
