import { runAgentLoop, type AgentCallbacks, type AgentOptions } from '../../src/agent/loop.js';
import { SideCarClient } from '../../src/ollama/client.js';
import type { ChatMessage } from '../../src/ollama/types.js';
import { ToolRuntime } from '../../src/agent/tools/runtime.js';
import { installSandbox, type WorkspaceFixture } from './workspaceSandbox.js';
import type { AgentEvalCase, AgentCaseResult, TrajectoryEvent } from './agentTypes.js';
import { scoreAgentCase } from './agentScorers.js';

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
  readonly name: 'ollama' | 'anthropic' | 'openai';
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
    return process.env.SIDECAR_EVAL_BACKEND !== 'anthropic' && process.env.SIDECAR_EVAL_BACKEND !== 'openai';
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

const AGENT_BACKENDS: Record<string, AgentEvalBackend> = {
  ollama: new OllamaAgentBackend(),
  anthropic: new AnthropicAgentBackend(),
  openai: new OpenAIAgentBackend(),
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
 * Run one agent-loop eval case end-to-end. Throws on infrastructure
 * errors (sandbox setup, backend unreachable); returns a pass/fail
 * result otherwise.
 */
export async function runAgentCase(
  evalCase: AgentEvalCase,
  backend: AgentEvalBackend,
  timeoutMs = 120_000,
): Promise<AgentCaseResult> {
  const start = Date.now();
  const sandbox = await installSandbox(evalCase.workspace, evalCase.id);
  let snapshot: WorkspaceFixture = {};
  const trajectory: TrajectoryEvent[] = [];
  const textBuffer: string[] = [];
  let iterationsUsed = 0;

  const toolRuntime = new ToolRuntime();
  const client = new SideCarClient(backend.defaultModel(), backend.baseUrl(), backend.apiKey());
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
      trajectory,
      finalText: textBuffer.join(''),
      workspaceAfter: snapshot,
      durationMs,
      iterationsUsed,
    };
  }

  return scoreAgentCase(evalCase, {
    trajectory,
    finalText: textBuffer.join(''),
    workspaceAfter: snapshot,
    durationMs,
    iterationsUsed,
  });
}
