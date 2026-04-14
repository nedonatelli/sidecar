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
//   2. **Cycle detection** — hash each iteration's tool-call signature
//      into a ring buffer and look for (a) length-1 repeats that fire
//      after MIN_IDENTICAL_REPEATS (4) consecutive hits, and (b)
//      length-2..MAX_CYCLE_LEN (4) pattern cycles that fire as soon
//      as two full cycles are visible. Length-1 has the higher
//      threshold because agents legitimately re-run a tool to verify
//      after an edit, retry tests, or refine inputs — firing too
//      early would kill useful work. Length-2+ has no such excuse:
//      A,B,A,B is a very clear stuck-loop signal.
//
// Both helpers return `true` when the loop should break. They also
// emit user-visible text via `callbacks.onText` and log via
// `state.logger` so the stop is observable in the chat + audit log.
// ---------------------------------------------------------------------------

const MAX_TOOL_CALLS_PER_ITERATION = 12;
const CYCLE_WINDOW = 8;
const MAX_CYCLE_LEN = 4;
const MIN_IDENTICAL_REPEATS = 4;

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
 * Record this iteration's tool-call signature into the state ring
 * buffer and check for repeat patterns. Returns `true` when a cycle
 * was detected and the loop should terminate.
 *
 * Tool-call signatures are `name:JSON.stringify(input)` joined with
 * `|` so a multi-call turn hashes as a single string. Two iterations
 * are considered "identical" only when the full signature matches —
 * a `read_file(a.ts)` followed by a `read_file(b.ts)` is NOT a cycle.
 */
export function detectCycleAndBail(
  pendingToolUses: ToolUseContentBlock[],
  state: LoopState,
  callbacks: AgentCallbacks,
): boolean {
  const callSignature = pendingToolUses.map((tu) => `${tu.name}:${JSON.stringify(tu.input)}`).join('|');
  state.recentToolCalls.push(callSignature);
  if (state.recentToolCalls.length > CYCLE_WINDOW) {
    state.recentToolCalls.shift();
  }

  // Length-1 cycle: same signature repeated MIN_IDENTICAL_REPEATS times.
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

  // Length-2..MAX_CYCLE_LEN cycle: a pattern that occurred twice in a row.
  for (let len = 2; len <= MAX_CYCLE_LEN && len * 2 <= state.recentToolCalls.length; len++) {
    const tail = state.recentToolCalls.slice(-len);
    const prev = state.recentToolCalls.slice(-2 * len, -len);
    if (tail.length === prev.length && tail.every((v, i) => v === prev[i])) {
      state.logger?.warn(`Agent loop cycle detected (length ${len}) — ${callSignature.slice(0, 100)}`);
      callbacks.onText(`\n\n⚠️ Agent stopped: detected repeating tool call pattern of length ${len}.\n`);
      return true;
    }
  }

  return false;
}
