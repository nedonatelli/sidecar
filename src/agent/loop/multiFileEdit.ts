import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks, AgentOptions } from '../loop.js';
import { planToLayers, type EditPlan, type PlannedEdit } from '../editPlan.js';
import { executeOneToolUse, type ExecutionContext } from './executeToolUses.js';
import type { LoopState } from './state.js';

// ---------------------------------------------------------------------------
// Multi-file edit executor (v0.65 chunk 4.3).
//
// Walks a validated EditPlan as a DAG: each layer runs in parallel up
// to `maxParallel`, later layers wait for their predecessors. Delegates
// per-edit dispatch to `executeOneToolUse` so we reuse the existing
// approval / streaming-diff / pending-edit / confirm plumbing exactly
// as the non-planned path.
//
// Responsibilities:
//   - Align plan entries with the original `pendingToolUses` by path.
//     The plan does not carry `content` (that's back in the tool_use);
//     matching by path is how we rehydrate the write. Planner output
//     that references a path not in the pending batch is treated as
//     "planner invented a write" — we log + skip it rather than silently
//     invent content.
//   - Preserve result-array alignment with the ORIGINAL pendingToolUses.
//     Callers downstream (gate recording, token accounting, hook bus)
//     walk pendingToolUses and toolResults in lockstep. Deduped tool_uses
//     (multiple writes to the same path) each get a result: the first
//     gets the real executed result, subsequent ones get a
//     "merged-by-plan" informational result so is_error semantics stay
//     honest.
//   - Bounded parallelism via a simple semaphore-per-layer. Tasks within
//     a layer are independent by construction (the DAG edge ensures
//     deps are in earlier layers), so we parallelize freely up to
//     maxParallel.
// ---------------------------------------------------------------------------

export async function executeMultiFilePlan(
  plan: EditPlan,
  pendingToolUses: readonly ToolUseContentBlock[],
  state: LoopState,
  client: SideCarClient,
  options: AgentOptions,
  callbacks: AgentCallbacks,
  signal: AbortSignal,
  maxParallel: number,
): Promise<ToolResultContentBlock[]> {
  const layers = planToLayers(plan);
  const ctx: ExecutionContext = { state, client, options, callbacks, signal };

  // Map each path → the FIRST tool_use targeting that path. Subsequent
  // duplicates get a synthetic "merged-by-plan" result and never
  // execute. This matches normalizeEditPlan's edit+edit merging.
  const firstUseByPath = new Map<string, ToolUseContentBlock>();
  for (const tu of pendingToolUses) {
    const path = extractPath(tu);
    if (!path) continue;
    if (!firstUseByPath.has(path)) firstUseByPath.set(path, tu);
  }

  // Execute layers in sequence; within each, parallel up to cap.
  // Results accumulate into a map keyed by tool_use id so we can
  // rebuild alignment to `pendingToolUses` at the end.
  const resultById = new Map<string, ToolResultContentBlock>();
  const cap = Math.max(1, maxParallel);

  for (const layer of layers) {
    if (signal.aborted) break;
    const tasks = layer
      .map((edit) => buildLayerTask(edit, firstUseByPath, ctx))
      .filter((t): t is () => Promise<ToolResultContentBlock> => t !== null);
    const settled = await runWithCap(tasks, cap);
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      if (outcome.status === 'fulfilled') {
        resultById.set(outcome.value.tool_use_id, outcome.value);
      } else {
        // Rejected task — surface a synthetic error keyed by the
        // originating tool_use so index alignment downstream stays clean.
        const path = layer[i].path;
        const tu = firstUseByPath.get(path);
        if (tu) {
          const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          resultById.set(tu.id, {
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `Multi-file edit failed: ${msg}`,
            is_error: true,
          });
          state.logger?.warn(`Multi-file write ${tu.name} (${path}) threw: ${msg}`);
          callbacks.onToolResult(tu.name, `Multi-file edit failed: ${msg}`, true, tu.id);
        }
      }
    }
  }

  // Rebuild results aligned 1:1 with the original pendingToolUses.
  // Dedup logic: for each pending tool_use, if its id is in resultById,
  // use that. Otherwise it's either a same-path duplicate (synthetic
  // merged-by-plan result) or a plan-invented path we skipped (synthetic
  // error).
  const results: ToolResultContentBlock[] = [];
  const pathOfFirstById = new Map<string, string>(); // tool_use_id → path it corresponds to
  for (const [path, tu] of firstUseByPath) pathOfFirstById.set(tu.id, path);

  for (const tu of pendingToolUses) {
    const existing = resultById.get(tu.id);
    if (existing) {
      results.push(existing);
      continue;
    }
    const path = extractPath(tu);
    if (!path) {
      // tool_use has no path — the planner can't have touched it;
      // treat as a structural error. This is unreachable under normal
      // dispatch (the planner pass shouldn't fire on pure non-writes)
      // but defend against it anyway.
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: 'Multi-file edit: tool_use had no path; skipped.',
        is_error: true,
      });
      continue;
    }
    const firstForPath = firstUseByPath.get(path);
    if (firstForPath && firstForPath.id !== tu.id) {
      // Duplicate same-path write — the planner merged it into the
      // first occurrence.
      const mergedResult = resultById.get(firstForPath.id);
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: `Merged by edit plan into earlier write on ${path} (result: ${
          mergedResult?.is_error ? 'error' : 'ok'
        })`,
        is_error: false,
      });
      continue;
    }
    // First occurrence for this path, but no result — planner's layer
    // didn't include this path. Either (a) planner omitted it, or (b)
    // signal aborted before this layer ran. Record a plan-skipped
    // result so alignment holds.
    results.push({
      type: 'tool_result',
      tool_use_id: tu.id,
      content: `Multi-file edit: path ${path} was not executed (planner omitted or run was aborted).`,
      is_error: true,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a thunk that runs one layer entry when awaited. Returns null
 * when the plan entry references a path that wasn't in the original
 * pending batch (planner invented a write we have no content for) —
 * a caller filter drops those before dispatch and they surface as
 * synthetic "planner omitted" results at the alignment step.
 */
function buildLayerTask(
  edit: PlannedEdit,
  firstUseByPath: Map<string, ToolUseContentBlock>,
  ctx: ExecutionContext,
): (() => Promise<ToolResultContentBlock>) | null {
  const tu = firstUseByPath.get(edit.path);
  if (!tu) {
    ctx.state.logger?.warn(`Edit plan references path "${edit.path}" that was not in the pending batch — skipping.`);
    return null;
  }
  return () => executeOneToolUse(ctx, tu);
}

function extractPath(tu: ToolUseContentBlock): string | null {
  const input = tu.input as { path?: unknown; file_path?: unknown };
  if (typeof input.path === 'string' && input.path.length > 0) return input.path;
  if (typeof input.file_path === 'string' && input.file_path.length > 0) return input.file_path;
  return null;
}

/**
 * Run `tasks` with at most `cap` in flight at a time. Returns a
 * `PromiseSettledResult[]` aligned 1:1 with `tasks` so callers can
 * map outcomes back to their input nodes. Rejected tasks never
 * crash the pool — the worker loop records the rejection and picks
 * the next task.
 */
export async function runWithCap<T>(
  tasks: readonly (() => Promise<T>)[],
  cap: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      try {
        const value = await tasks[i]();
        results[i] = { status: 'fulfilled', value };
      } catch (err) {
        results[i] = { status: 'rejected', reason: err };
      }
    }
  }
  const workerCount = Math.min(Math.max(1, cap), tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
