import type { ToolUseContentBlock } from '../../ollama/types.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';

// ---------------------------------------------------------------------------
// Per-iteration safety checks on tool-use bursts and repeat patterns.
//
// Two independent failure modes the loop needs to catch:
//
//   1. **Burst cap** — a runaway or prompt-injected model can emit 30+
//      tool_use blocks in a single streaming turn. Cycle detection (#2)
//      wouldn't fire because it looks at *patterns across iterations*,
//      not counts within one. MAX_TOOL_CALLS_PER_ITERATION = 12 caps
//      the per-turn burst. Generous for legitimate multi-step workflows
//      (read + edit + diagnostics + tests typically 4-8) but cuts off
//      burst-bomb scenarios.
//
//   2. **Cycle detection** — two parallel ring buffers, each checked
//      for length-1..MAX_CYCLE_LEN patterns:
//
//      a. *Exact* buffer: full `name:JSON(input)` signature. Fires on
//         length-1 after MIN_IDENTICAL_REPEATS (4) consecutive hits,
//         length-2..4 as soon as two full cycles appear. Higher
//         threshold for length-1 because agents legitimately re-run
//         a tool (verify after edit, retry tests, refine inputs).
//
//      b. *Normalized* buffer: `name:primaryResource` — keeps the tool
//         name and the first path/command/query arg but strips secondary
//         args (edit content, line ranges, flags). Fires at
//         MIN_NORMALIZED_REPEATS (3). This catches loops that bypass
//         exact matching by varying secondary args while hammering the
//         same file or command repeatedly — e.g.
//         `edit_file(a.ts, search1, replace1)` × 3 times with different
//         content each time.
//
// Both helpers return `true` when the loop should break. They also
// emit user-visible text via `callbacks.onText` and log via
// `state.logger` so the stop is observable in the chat + audit log.
// ---------------------------------------------------------------------------

const MAX_TOOL_CALLS_PER_ITERATION = 12;
const CYCLE_WINDOW = 8;
const MAX_CYCLE_LEN = 4;
const MIN_IDENTICAL_REPEATS = 4;
const MIN_NORMALIZED_REPEATS = 3;

// Keys checked in priority order to extract a tool's primary resource.
// The first matching non-empty string value becomes the normalized key.
const PRIMARY_RESOURCE_KEYS = ['path', 'file_path', 'directory', 'command', 'query', 'pattern', 'url'] as const;

/**
 * Enforce the per-iteration tool-call burst cap. Returns `true` when
 * the cap was exceeded and the loop should terminate; the caller is
 * expected to `break` immediately after.
 */
export function exceedsBurstCap(
  pendingToolUses: ToolUseContentBlock[],
  state: LoopState,
  callbacks: AgentCallbacks,
): boolean {
  if (pendingToolUses.length <= MAX_TOOL_CALLS_PER_ITERATION) return false;

  state.logger?.warn(
    `Agent loop tool-call burst cap exceeded: ${pendingToolUses.length} tool calls in one iteration ` +
      `(max ${MAX_TOOL_CALLS_PER_ITERATION}). First call: ${pendingToolUses[0].name}`,
  );
  callbacks.onText(
    `\n\n⚠️ Agent stopped: ${pendingToolUses.length} tool calls in a single turn exceeds the ` +
      `${MAX_TOOL_CALLS_PER_ITERATION}-call burst cap. Ask again with a narrower scope.\n`,
  );
  return true;
}

/**
 * Record this iteration's tool-call signature into both ring buffers
 * and check for repeat patterns. Returns `true` when a cycle was
 * detected and the loop should terminate.
 *
 * Two passes run in order:
 *   1. Exact signatures (`name:JSON(input)` joined with `|`) — fires
 *      at MIN_IDENTICAL_REPEATS (4) for length-1, immediately for
 *      length-2..MAX_CYCLE_LEN.
 *   2. Normalized signatures (`name:primaryResource`) — fires at
 *      MIN_NORMALIZED_REPEATS (3) for length-1 and length-2..MAX_CYCLE_LEN.
 *      Catches "same file, different edit content" loops missed by pass 1.
 */
export function detectCycleAndBail(
  pendingToolUses: ToolUseContentBlock[],
  state: LoopState,
  callbacks: AgentCallbacks,
): boolean {
  // --- Exact signature pass ---
  const callSignature = pendingToolUses.map((tu) => `${tu.name}:${sortedStringify(tu.input)}`).join('|');
  state.recentToolCalls.push(callSignature);
  if (state.recentToolCalls.length > CYCLE_WINDOW) {
    state.recentToolCalls.shift();
  }

  if (state.recentToolCalls.length >= MIN_IDENTICAL_REPEATS) {
    const lastN = state.recentToolCalls.slice(-MIN_IDENTICAL_REPEATS);
    if (lastN.every((v) => v === lastN[0])) {
      state.logger?.warn(
        `Agent loop cycle detected (${MIN_IDENTICAL_REPEATS} identical calls) — ${callSignature.slice(0, 100)}`,
      );
      callbacks.onText(`\n\n⚠️ Agent stopped: same tool call repeated ${MIN_IDENTICAL_REPEATS} times in a row.\n`);
      return true;
    }
  }

  for (let len = 2; len <= MAX_CYCLE_LEN && len * 2 <= state.recentToolCalls.length; len++) {
    const tail = state.recentToolCalls.slice(-len);
    const prev = state.recentToolCalls.slice(-2 * len, -len);
    if (tail.length === prev.length && tail.every((v, i) => v === prev[i])) {
      state.logger?.warn(`Agent loop cycle detected (length ${len}) — ${callSignature.slice(0, 100)}`);
      callbacks.onText(`\n\n⚠️ Agent stopped: detected repeating tool call pattern of length ${len}.\n`);
      return true;
    }
  }

  // --- Normalized signature pass ---
  const normSignature = normalizeSignature(pendingToolUses);
  state.recentNormalizedCalls.push(normSignature);
  if (state.recentNormalizedCalls.length > CYCLE_WINDOW) {
    state.recentNormalizedCalls.shift();
  }

  if (state.recentNormalizedCalls.length >= MIN_NORMALIZED_REPEATS) {
    const lastN = state.recentNormalizedCalls.slice(-MIN_NORMALIZED_REPEATS);
    if (lastN.every((v) => v === lastN[0])) {
      state.logger?.warn(
        `Agent loop normalized cycle detected (${MIN_NORMALIZED_REPEATS} repeats) — ${normSignature.slice(0, 100)}`,
      );
      callbacks.onText(
        `\n\n⚠️ Agent stopped: same tool calls on the same resource repeated ` +
          `${MIN_NORMALIZED_REPEATS} times — try a different approach.\n`,
      );
      return true;
    }
  }

  for (let len = 2; len <= MAX_CYCLE_LEN && len * 2 <= state.recentNormalizedCalls.length; len++) {
    const tail = state.recentNormalizedCalls.slice(-len);
    const prev = state.recentNormalizedCalls.slice(-2 * len, -len);
    if (tail.length === prev.length && tail.every((v, i) => v === prev[i])) {
      state.logger?.warn(`Agent loop normalized cycle detected (length ${len}) — ${normSignature.slice(0, 100)}`);
      callbacks.onText(`\n\n⚠️ Agent stopped: detected repeating pattern of length ${len} on the same resources.\n`);
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sortedStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(sortedStringify).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + sortedStringify((value as Record<string, unknown>)[k])).join(',') +
    '}'
  );
}

/**
 * Reduced tool-call signature that keeps the tool name and its primary
 * resource (file path, command string, query, etc.) while discarding
 * secondary arguments such as edit content, line ranges, and flags.
 *
 * This lets the normalized-cycle check catch "same tool on the same
 * file with different secondary args" loops — e.g.:
 *   edit_file(a.ts, "search1", "replace1")
 *   edit_file(a.ts, "search2", "replace2")   ← different exact sig
 *   edit_file(a.ts, "search3", "replace3")   ← fires at MIN_NORMALIZED_REPEATS
 */
function normalizeSignature(pendingToolUses: ToolUseContentBlock[]): string {
  return pendingToolUses
    .map((tu) => {
      const input = tu.input as Record<string, unknown>;
      for (const key of PRIMARY_RESOURCE_KEYS) {
        const v = input[key];
        if (typeof v === 'string' && v) {
          return `${tu.name}:${v.slice(0, 80)}`;
        }
      }
      return tu.name;
    })
    .join('|');
}
