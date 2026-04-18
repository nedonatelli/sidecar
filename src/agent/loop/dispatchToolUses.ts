import type { ToolUseContentBlock, ToolResultContentBlock, ChatMessage } from '../../ollama/types.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks, AgentOptions } from '../loop.js';
import type { LoopState } from './state.js';
import type { SideCarConfig } from '../../config/settings.js';
import { shouldRunPlannerPass, requestEditPlan, NO_PLAN_SENTINEL } from '../editPlanner.js';
import { executeMultiFilePlan } from './multiFileEdit.js';
import { executeToolUses } from './executeToolUses.js';

// ---------------------------------------------------------------------------
// Dispatch orchestration for a turn's tool_uses (v0.65 chunk 4.3b).
//
// Sits between `streamOneTurn` and tool execution. Decides:
//
//   A. "Pure file-write batch with fanout ≥ threshold" → run the Edit
//      Plan pass (planner turn), walk the resulting DAG via
//      `executeMultiFilePlan`. If the planner fails validation twice,
//      fall back to `executeToolUses` (identical to the B path).
//
//   B. Everything else → `executeToolUses` directly (legacy path,
//      unchanged).
//
// The gate deliberately rejects mixed-tool turns (any non-write
// tool_use forces path B) — planning a partial batch is complex and
// the common multi-file workflow is a pure-writes turn anyway. If a
// real workload demands mixed-turn planning, it's one more gate
// adjustment here.
// ---------------------------------------------------------------------------

const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'create_file', 'delete_file']);

export async function dispatchPendingToolUses(
  state: LoopState,
  pendingToolUses: ToolUseContentBlock[],
  client: SideCarClient,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  signal: AbortSignal,
  config: SideCarConfig,
): Promise<ToolResultContentBlock[]> {
  // Clear any plan left over from a previous turn. The prior turn's
  // plan stayed set through the post-turn hook bus so regression
  // guards + audit review could observe it; this top-of-turn clear
  // is where it ages out.
  state.currentEditPlan = null;

  if (
    isPureWriteBatch(pendingToolUses) &&
    shouldRunPlannerPass(pendingToolUses, {
      enabled: config.multiFileEditsEnabled,
      planningPass: config.multiFileEditsPlanningPass,
      minFilesForPlan: config.multiFileEditsMinFilesForPlan,
      userPromptText: latestUserPromptText(state.messages),
    })
  ) {
    state.logger?.info(`Multi-file edit: planner pass triggered for ${pendingToolUses.length} pending writes`);
    const planResult = await requestEditPlan(client, state.messages, pendingToolUses, {
      signal,
      plannerModel: config.multiFileEditsPlannerModel || undefined,
      log: (line) => state.logger?.info(line),
    });
    if (planResult.plan) {
      callbacks.onEditPlan?.(planResult.plan);
      // Seed each edit's UI status as 'pending' immediately after the
      // plan card renders — the executor flips each to 'writing' when
      // its layer dispatches, then 'done'/'failed' on completion.
      for (const edit of planResult.plan.edits) {
        callbacks.onEditPlanProgress?.({ path: edit.path, status: 'pending' });
      }
      callbacks.onText(
        `\n📋 Planning ${planResult.plan.edits.length} file edits (parallelism cap ${config.multiFileEditsMaxParallel})\n`,
      );
      state.currentEditPlan = planResult.plan;
      try {
        return await executeMultiFilePlan(
          planResult.plan,
          pendingToolUses,
          state,
          client,
          options,
          callbacks,
          signal,
          config.multiFileEditsMaxParallel,
        );
      } finally {
        // currentEditPlan intentionally stays set after DAG execution
        // — the loop's post-turn hook bus (regression guards, audit
        // review) runs between here and the next iteration, and they
        // read state.currentEditPlan to detect "these writes came from
        // a grouped plan." The top-of-next-dispatch clear ages it out.
      }
    }
    state.logger?.warn('Edit planner returned no valid plan after retry; falling back to direct tool dispatch.');
  }
  return executeToolUses(state, pendingToolUses, client, options, callbacks, signal);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPureWriteBatch(pendingToolUses: readonly ToolUseContentBlock[]): boolean {
  if (pendingToolUses.length === 0) return false;
  for (const tu of pendingToolUses) {
    if (!FILE_WRITE_TOOLS.has(tu.name)) return false;
  }
  return true;
}

/**
 * Pull the most-recent user message's text for the `@no-plan` sentinel
 * scan. Only plain-string content counts — content-block arrays (images,
 * tool_results) don't carry a user-prompt string. Returns empty string
 * when no user message is found, which conservatively leaves the
 * planner pass eligible (no sentinel present = don't suppress).
 */
function latestUserPromptText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    // Content-block array — scan text blocks.
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
      }
    }
  }
  return '';
}

export { NO_PLAN_SENTINEL };
