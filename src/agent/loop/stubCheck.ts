import type { AgentCallbacks } from '../loop.js';
import { buildStubReprompt } from '../stubValidator.js';
import type { LoopState } from './state.js';

// ---------------------------------------------------------------------------
// Stub validator reprompt — post-turn policy.
//
// After the agent writes code via write_file or edit_file, this
// helper scans the written content for placeholder markers (TODO,
// "implement me", raise NotImplementedError, etc. — see
// stubValidator.STUB_PATTERNS for the full list) and injects a
// synthetic user message asking the model to finish the work.
//
// Bounded to `MAX_STUB_RETRIES` attempts per run so a model that
// repeatedly generates stubs doesn't loop forever. The counter
// lives on `LoopState.stubFixRetries` and accumulates across
// iterations within a single runAgentLoop invocation.
//
// Returns `true` when a reprompt was injected (caller may want to
// log the transition, though in practice the loop just continues).
// The detection itself is pure text matching over
// `pendingToolUses[].input`, already unit-tested in
// stubValidator.test.ts, so this helper only owns the
// state-mutation + reprompt-injection ceremony.
// ---------------------------------------------------------------------------

const MAX_STUB_RETRIES = 1;

/**
 * Scan the turn's `write_file` / `edit_file` calls for stub patterns
 * and inject a reprompt when found. Returns `true` when a reprompt
 * was injected, `false` when the content was clean or the retry
 * budget was exhausted.
 */
export function applyStubCheck(
  state: LoopState,
  pendingToolUses: Parameters<typeof buildStubReprompt>[0],
  callbacks: AgentCallbacks,
): boolean {
  if (state.stubFixRetries >= MAX_STUB_RETRIES) return false;

  const reprompt = buildStubReprompt(pendingToolUses);
  if (!reprompt) return false;

  state.stubFixRetries++;
  state.logger?.info(
    `Stub validator: found placeholders, reprompting (attempt ${state.stubFixRetries}/${MAX_STUB_RETRIES})`,
  );
  callbacks.onText('\n⚠️ Incomplete code detected — requesting full implementation...\n');
  state.messages.push({
    role: 'user',
    content: [{ type: 'text' as const, text: reprompt }],
  });
  return true;
}
