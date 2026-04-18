import type { SideCarClient } from '../ollama/client.js';
import type { ChatMessage, ToolUseContentBlock } from '../ollama/types.js';
import { parseEditPlanJson, EditPlanValidationError, type EditPlan } from './editPlan.js';

// ---------------------------------------------------------------------------
// Edit Plan pass (v0.65 chunk 4.2).
//
// Before a multi-file write batch fires, a dedicated planner turn
// produces a typed `EditPlan` manifest that the scheduler (chunk 4.3)
// walks as a DAG. This module is the planner-turn driver:
//
//   1. `shouldRunPlannerPass(...)` — decides whether this turn's
//      tool_uses warrant a planner pass (fanout ≥ minFilesForPlan,
//      feature enabled, planningPass on, prompt lacks `@no-plan`).
//
//   2. `requestEditPlan(...)` — runs a single dedicated LLM turn with
//      a planner-specific system prompt, parses the JSON response
//      (fence-tolerant), validates it with `validateEditPlan`.
//      On validation failure, retries ONCE with the error fed back
//      as a revise-your-plan message; a second failure returns
//      `null` so the caller can fall back to the un-planned batch.
//
// The module is deliberately decoupled from `runAgentLoop` — it takes
// a client + a message array, not `LoopState`. Chunk 4.3 integrates
// this helper into the executor.
// ---------------------------------------------------------------------------

/** Tool names treated as file-write ops. Counted toward the plan-fanout threshold. */
const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'create_file', 'delete_file']);

/** Sentinel the user can add to a prompt to skip planner passes for that request. */
export const NO_PLAN_SENTINEL = '@no-plan';

export interface ShouldRunPlannerPassOptions {
  readonly enabled: boolean;
  readonly planningPass: boolean;
  readonly minFilesForPlan: number;
  /** The full user-turn text (most-recent user message) to scan for `@no-plan`. */
  readonly userPromptText: string;
}

/**
 * Returns true when the current turn's `pendingToolUses` should be
 * intercepted for an Edit Plan pass instead of executed directly.
 *
 * Counts distinct file-write targets — the scheduler cares about
 * distinct paths, not raw tool_use count, so two edits on the same
 * file count as one (the same-path merging in `normalizeEditPlan`
 * would collapse them anyway).
 */
export function shouldRunPlannerPass(
  pendingToolUses: readonly ToolUseContentBlock[],
  options: ShouldRunPlannerPassOptions,
): boolean {
  if (!options.enabled) return false;
  if (!options.planningPass) return false;
  if (options.userPromptText.includes(NO_PLAN_SENTINEL)) return false;

  const distinctPaths = new Set<string>();
  for (const tu of pendingToolUses) {
    if (!FILE_WRITE_TOOLS.has(tu.name)) continue;
    const p =
      (tu.input as { path?: unknown; file_path?: unknown }).path ?? (tu.input as { file_path?: unknown }).file_path;
    if (typeof p === 'string' && p.length > 0) distinctPaths.add(p);
  }
  return distinctPaths.size >= options.minFilesForPlan;
}

export interface RequestEditPlanOptions {
  readonly signal?: AbortSignal;
  /**
   * When set, the client's model is switched to this for the planner
   * turn only (via `setTurnOverride`) and restored on exit. Empty =
   * reuse the main model.
   */
  readonly plannerModel?: string;
  /** Logger passthrough for traceability — used on validation errors. */
  readonly log?: (line: string) => void;
}

export interface RequestEditPlanResult {
  readonly plan: EditPlan | null;
  /** Accumulated planner turn text (for debugging + verbose UI). */
  readonly rawText: string;
  /** Whether a validation-feedback retry fired. */
  readonly retried: boolean;
}

/**
 * Run the planner turn. `messages` is the current conversation history
 * (the planner is given the same context the agent had, minus the
 * aborted tool_use batch). `pendingToolUses` is the batch that
 * triggered the planner pass — surfaced to the model as "you proposed
 * these edits."
 *
 * Returns a normalized + validated `EditPlan`, or `null` when two
 * attempts (one initial + one feedback retry) both failed validation.
 * Callers that get `null` should fall back to the un-planned batch
 * rather than block the user's turn entirely.
 */
export async function requestEditPlan(
  client: SideCarClient,
  messages: readonly ChatMessage[],
  pendingToolUses: readonly ToolUseContentBlock[],
  options: RequestEditPlanOptions = {},
): Promise<RequestEditPlanResult> {
  const distinctWrites = summarizeWrites(pendingToolUses);
  const originalModel = client.getTurnOverride();
  if (options.plannerModel && options.plannerModel.length > 0) {
    client.setTurnOverride(options.plannerModel);
  }

  const convo: ChatMessage[] = [...messages, { role: 'user', content: buildPlannerPrompt(distinctWrites) }];
  let rawText = '';
  let plan: EditPlan | null = null;
  let retried = false;
  let firstError: EditPlanValidationError | null = null;

  try {
    rawText = await runPlannerTurn(client, convo, options.signal);
    try {
      plan = parsePlanFromText(rawText);
    } catch (err) {
      if (!(err instanceof EditPlanValidationError)) throw err;
      firstError = err;
      options.log?.(`Planner turn returned invalid plan (${err.reason}): ${err.message}`);
      retried = true;
      convo.push({ role: 'assistant', content: rawText });
      convo.push({ role: 'user', content: buildReviseMessage(err) });
      const retryText = await runPlannerTurn(client, convo, options.signal);
      rawText = `${rawText}\n\n---RETRY---\n\n${retryText}`;
      try {
        plan = parsePlanFromText(retryText);
      } catch (retryErr) {
        if (retryErr instanceof EditPlanValidationError) {
          options.log?.(`Planner retry also invalid (${retryErr.reason}): ${retryErr.message}`);
          plan = null;
        } else {
          throw retryErr;
        }
      }
    }
  } finally {
    if (options.plannerModel && options.plannerModel.length > 0) {
      client.setTurnOverride(originalModel);
    }
  }

  if (!plan && firstError && !retried) {
    // Defensive — unreachable in practice; retry path above always
    // sets `retried = true` before returning null. Kept so future
    // callers that bypass retry see a useful error object.
    options.log?.(`Planner failed: ${firstError.message}`);
  }

  return { plan, rawText, retried };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PendingWriteSummary {
  readonly path: string;
  readonly op: 'create' | 'edit' | 'delete';
}

function summarizeWrites(pendingToolUses: readonly ToolUseContentBlock[]): PendingWriteSummary[] {
  const byPath = new Map<string, PendingWriteSummary>();
  for (const tu of pendingToolUses) {
    const name = tu.name;
    const inp = tu.input as { path?: unknown; file_path?: unknown };
    const rawPath = typeof inp.path === 'string' ? inp.path : typeof inp.file_path === 'string' ? inp.file_path : '';
    if (!rawPath) continue;
    let op: 'create' | 'edit' | 'delete' = 'edit';
    if (name === 'delete_file') op = 'delete';
    else if (name === 'create_file') op = 'create';
    // write_file is 'create' if the file is new and 'edit' otherwise,
    // but we don't check disk here — planner model can disambiguate.
    // Default to 'edit' so fewer cases need planner correction.
    if (!byPath.has(rawPath)) byPath.set(rawPath, { path: rawPath, op });
  }
  return Array.from(byPath.values());
}

function buildPlannerPrompt(writes: readonly PendingWriteSummary[]): string {
  const list = writes.map((w) => `  - ${w.path} (${w.op})`).join('\n');
  return (
    `You are the SideCar edit planner. Your only job this turn is to ` +
    `produce an EditPlan JSON manifest for a multi-file refactor.\n\n` +
    `The previous turn proposed ${writes.length} file changes:\n${list}\n\n` +
    `Revise and return these as an EditPlan, adding a dependency DAG so ` +
    `independent writes can run in parallel and dependent writes wait for ` +
    `their prerequisites. Respond with ONLY a fenced JSON block (\`\`\`json) ` +
    `in exactly this schema — no prose, no other tool calls:\n\n` +
    '```json\n' +
    '{\n' +
    '  "edits": [\n' +
    '    { "path": "string", "op": "create|edit|delete", "rationale": "string", "dependsOn": ["string", ...] }\n' +
    '  ]\n' +
    '}\n' +
    '```\n\n' +
    `Rules:\n` +
    `- Each "dependsOn" entry must also appear as a "path" on another edit in the same plan.\n` +
    `- No cycles. If A depends on B, B must not (transitively) depend on A.\n` +
    `- Merge any duplicate same-path ops into one entry with combined rationale.\n` +
    `- Use "create" for new files, "edit" for existing files, "delete" to remove.\n` +
    `- Keep rationale to one sentence per edit.\n`
  );
}

function buildReviseMessage(err: EditPlanValidationError): string {
  return (
    `The EditPlan you just produced failed validation:\n\n` +
    `  reason: ${err.reason}\n` +
    `  detail: ${err.message}\n\n` +
    `Revise and return a corrected EditPlan JSON block. Follow the same schema and rules; ` +
    `fix only the issue above — do not introduce new edits that weren't in the original proposal.`
  );
}

/**
 * Extract a JSON object from the planner turn text. Tolerates the
 * common model output patterns: ```json fenced blocks, bare ``` fenced
 * blocks, and a plain JSON object at the start of the response.
 * Returns the first balanced `{ ... }` block.
 *
 * Throws `EditPlanValidationError(reason='invalid-shape')` when no
 * plausible JSON block is found.
 */
export function extractPlanJson(text: string): string {
  // Prefer fenced blocks: ```json { ... } ``` or ``` { ... } ```
  const fencePatterns = [/```json\s*([\s\S]*?)```/i, /```\s*([\s\S]*?)```/];
  for (const re of fencePatterns) {
    const match = re.exec(text);
    if (match && match[1].trim().startsWith('{')) {
      return match[1].trim();
    }
  }
  // Fallback: balanced brace scan from the first `{`.
  const start = text.indexOf('{');
  if (start === -1) {
    throw new EditPlanValidationError('Planner response contained no JSON object', 'invalid-shape');
  }
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inStr) {
      escape = true;
      continue;
    }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new EditPlanValidationError('Planner response had an unbalanced JSON object', 'invalid-shape');
}

function parsePlanFromText(text: string): EditPlan {
  const json = extractPlanJson(text);
  return parseEditPlanJson(json);
}

async function runPlannerTurn(
  client: SideCarClient,
  messages: readonly ChatMessage[],
  signal: AbortSignal | undefined,
): Promise<string> {
  // Planner runs toolless — the model must answer with JSON, not by
  // calling read_file/grep/etc. A single tool_use response would
  // bypass the plan and fall through to the un-planned batch.
  let text = '';
  for await (const event of client.streamChat([...messages], signal, [])) {
    if (event.type === 'text') text += event.text;
    // tool_use / thinking / usage events are ignored — we only care
    // about the final text.
  }
  return text;
}
