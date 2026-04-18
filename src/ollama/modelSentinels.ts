// ---------------------------------------------------------------------------
// @-prefixed inline model sentinels (v0.64 phase 4d.1).
//
// Users can prepend one of `@opus`, `@sonnet`, `@haiku`, or `@local` to a
// chat message to bypass Role-Based Model Routing for just that turn.
// The sentinel is stripped from the prompt before it hits the agent loop,
// and `SideCarClient.setTurnOverride(model)` pins every dispatch of the
// turn to the resolved model regardless of what `sidecar.modelRouting.rules`
// would otherwise pick. The chat handler clears the override when the
// turn completes so the next user message resumes normal routing.
//
// The mapping below is deliberately opinionated — it targets the models
// most users will have configured. An `@opus` on a rig that only has
// Ollama will fail when the backend can't resolve the Anthropic model id;
// that's a per-session accident, not worth a per-user config surface.
// ---------------------------------------------------------------------------

import { OLLAMA_DEFAULT_MODEL } from '../config/settings.js';

interface SentinelMapping {
  /** Whole-word match at the start of the user's message text. */
  token: string;
  /** Model id to pin the turn to. */
  model: string;
}

const SENTINEL_MAPPINGS: readonly SentinelMapping[] = [
  { token: '@opus', model: 'claude-opus-4-6' },
  { token: '@sonnet', model: 'claude-sonnet-4-6' },
  { token: '@haiku', model: 'claude-haiku-4-5' },
  // `@local` resolves to the user's shipped default Ollama model. That's
  // intentionally a loose binding — the principle is "use the free local
  // model," not "use this exact GGUF." Users with a different locally-
  // installed model can simply type `/model <name>` for a lasting change.
  { token: '@local', model: OLLAMA_DEFAULT_MODEL },
];

export interface ParsedSentinel {
  /** The message with the sentinel stripped; trimmed leading whitespace. */
  cleaned: string;
  /** Model to pin the turn to, or `null` when no sentinel was present. */
  override: string | null;
}

/**
 * Parse a leading `@<name>` sentinel, if any, from a user message.
 * Only matches at the very start of the trimmed text so a sentinel
 * buried in prose like "check @opus tag" doesn't fire accidentally.
 */
export function parseModelSentinel(text: string): ParsedSentinel {
  const trimmed = text.trimStart();
  for (const mapping of SENTINEL_MAPPINGS) {
    // Require word-boundary after the sentinel so `@opusify` doesn't
    // match `@opus`. Plain whitespace or end-of-string both count.
    if (trimmed.toLowerCase().startsWith(mapping.token)) {
      const after = trimmed.slice(mapping.token.length);
      if (after.length === 0 || /^\s/.test(after)) {
        return { cleaned: after.trimStart(), override: mapping.model };
      }
    }
  }
  return { cleaned: text, override: null };
}
