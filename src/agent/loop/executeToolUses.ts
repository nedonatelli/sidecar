import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks, AgentOptions } from '../loop.js';
import { executeTool } from '../executor.js';
import { spawnSubAgent } from '../subagent.js';
import { runLocalWorker } from '../localWorker.js';
import type { LoopState } from './state.js';

// ---------------------------------------------------------------------------
// Parallel tool execution for runAgentLoop.
//
// Dispatches each tool_use block to one of three code paths:
//
//   1. `spawn_agent` — recursive sub-agent. Runs another full
//      runAgentLoop via spawnSubAgent with approval/mode inherited
//      from the caller. Sub-agent token usage is charged against the
//      parent's char budget (state.totalChars) because both run on
//      the same paid backend.
//
//   2. `delegate_task` — local Ollama worker. Runs a scoped
//      read-only agent via runLocalWorker. Worker token usage is
//      NOT charged against state.totalChars because the worker runs
//      on the free local backend. This is the entire point of the
//      delegate_task tool — offload heavy I/O to a free model.
//
//   3. Everything else — normal `executeTool` call with the full
//      executor context (approval mode, confirm fn, tool runtime,
//      streaming diff preview, pending-edit shadow store). After
//      execution, records the tool call in agent memory (pattern on
//      success, failure cause on error) and in the tool-chain
//      recorder, then fires `onToolResult` for observers.
//
// All three paths run in parallel via `Promise.allSettled` so one
// slow or failing tool doesn't block the others. Rejected promises
// are promoted to synthetic error tool_result blocks so the caller
// always sees a complete result-per-use array in the same order as
// the input.
// ---------------------------------------------------------------------------

/**
 * Parameters shared across every branch of the execution dispatch.
 * Bundled together so the branches can pull exactly what they need
 * without a 12-parameter helper signature.
 */
interface ExecutionContext {
  state: LoopState;
  client: SideCarClient;
  options: AgentOptions;
  callbacks: AgentCallbacks;
  signal: AbortSignal;
}

/**
 * Execute every tool_use block in parallel. Returns a result array
 * aligned 1:1 with `pendingToolUses` — even rejected promises are
 * turned into synthetic error tool_result blocks so the caller can
 * always index `toolResults[i]` for the corresponding `pendingToolUses[i]`.
 *
 * Side effects inside:
 *   - state.totalChars is bumped for spawn_agent sub-agents (parent
 *     pays for sub-agent tokens).
 *   - callbacks.onMemory / onToolChainRecord / onToolResult fire
 *     per tool call so downstream observers see every result.
 *   - state.logger records each tool_result at info level.
 */
export async function executeToolUses(
  state: LoopState,
  pendingToolUses: ToolUseContentBlock[],
  client: SideCarClient,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  signal: AbortSignal,
): Promise<ToolResultContentBlock[]> {
  const ctx: ExecutionContext = { state, client, options, callbacks, signal };

  const executionPromises = pendingToolUses.map((toolUse) => executeOne(ctx, toolUse));

  const settled = await Promise.allSettled(executionPromises);
  const toolResults: ToolResultContentBlock[] = [];
  for (let idx = 0; idx < settled.length; idx++) {
    const outcome = settled[idx];
    if (outcome.status === 'fulfilled') {
      toolResults.push(outcome.value);
    } else {
      // Rejected promise → synthetic error result so the result array
      // stays aligned with pendingToolUses and downstream consumers
      // (gate recording, token accounting, post-turn policies) can
      // still walk the two in lockstep.
      const errMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      const pending = pendingToolUses[idx];
      toolResults.push({
        type: 'tool_result',
        tool_use_id: pending.id,
        content: `Internal error: ${errMsg}`,
        is_error: true,
      });
      state.logger?.warn(`Tool ${pending.name} threw: ${errMsg}`);
      callbacks.onToolResult(pending.name, `Internal error: ${errMsg}`, true, pending.id);
    }
  }
  return toolResults;
}

/**
 * Dispatch one tool_use block to its execution path. Internal helper
 * — exposed indirectly via `executeToolUses`.
 */
async function executeOne(ctx: ExecutionContext, toolUse: ToolUseContentBlock): Promise<ToolResultContentBlock> {
  const { state, options, callbacks, signal } = ctx;

  if (toolUse.name === 'spawn_agent') {
    return runSpawnAgent(ctx, toolUse);
  }

  if (toolUse.name === 'delegate_task') {
    return runDelegateTask(ctx, toolUse);
  }

  const result = await executeTool(toolUse, {
    approvalMode: state.approvalMode,
    changelog: state.changelog,
    mcpManager: state.mcpManager,
    logger: state.logger,
    confirmFn: options.confirmFn,
    diffPreviewFn: options.diffPreviewFn,
    executorContext: {
      onOutput: (chunk) => callbacks.onToolOutput?.(toolUse.name, chunk, toolUse.id),
      signal,
      clarifyFn: options.clarifyFn,
      modeToolPermissions: options.modeToolPermissions,
      toolRuntime: options.toolRuntime,
    },
    inlineEditFn: options.inlineEditFn,
    streamingDiffPreviewFn: options.streamingDiffPreviewFn,
    pendingEdits: options.pendingEdits,
  });
  state.logger?.logToolResult(toolUse.name, result.content, result.is_error || false);

  // Record tool use in agent memory — both successes and failures
  // are useful signals for the memory system.
  const inputStr = typeof toolUse.input === 'object' ? JSON.stringify(toolUse.input) : String(toolUse.input);
  if (!result.is_error) {
    callbacks.onMemory?.(
      'pattern',
      `tool:${toolUse.name}`,
      `${toolUse.name} works well with args like: ${inputStr.slice(0, 100)}`,
    );
  } else {
    callbacks.onMemory?.(
      'failure',
      `tool:${toolUse.name}`,
      `${toolUse.name} can fail when: ${result.content.slice(0, 120)}`,
    );
  }
  callbacks.onToolChainRecord?.(toolUse.name, !result.is_error);
  callbacks.onToolResult(toolUse.name, result.content, result.is_error || false, toolUse.id);
  return result;
}

/**
 * Handle `spawn_agent`: recursive sub-agent that runs a full
 * runAgentLoop under the current approval mode. Charges sub-agent
 * token usage to the parent's budget since both run on the same
 * paid backend.
 */
async function runSpawnAgent(ctx: ExecutionContext, toolUse: ToolUseContentBlock): Promise<ToolResultContentBlock> {
  const { state, client, options, callbacks, signal } = ctx;
  const subResult = await spawnSubAgent(
    client,
    toolUse.input.task as string,
    toolUse.input.context as string | undefined,
    callbacks,
    signal,
    {
      logger: state.logger,
      changelog: state.changelog,
      approvalMode: state.approvalMode,
      maxIterations: Math.min(state.maxIterations, 15),
      depth: options.depth || 0,
    },
  );
  state.totalChars += subResult.charsConsumed;
  callbacks.onCharsConsumed?.(subResult.charsConsumed);
  return {
    type: 'tool_result',
    tool_use_id: toolUse.id,
    content: subResult.output || '(no output)',
    is_error: !subResult.success,
  };
}

/**
 * Handle `delegate_task`: offload a focused read-only research
 * subtask to a local Ollama worker. The worker's token consumption
 * does NOT count against state.totalChars — that's the entire
 * point of the tool: shift heavy I/O onto the free backend.
 */
async function runDelegateTask(ctx: ExecutionContext, toolUse: ToolUseContentBlock): Promise<ToolResultContentBlock> {
  const { state, options, callbacks, signal } = ctx;
  const workerResult = await runLocalWorker(
    toolUse.input.task as string,
    toolUse.input.context as string | undefined,
    callbacks,
    signal,
    {
      logger: state.logger,
      changelog: state.changelog,
      mcpManager: state.mcpManager,
      depth: options.depth || 0,
    },
  );
  return {
    type: 'tool_result',
    tool_use_id: toolUse.id,
    content: workerResult.output,
    is_error: !workerResult.success,
  };
}
