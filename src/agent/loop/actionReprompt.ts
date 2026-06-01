import type { ChatMessage } from '../../ollama/types.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';

// ---------------------------------------------------------------------------
// Action-request reprompt — onEmptyResponse policy.
//
// Fires when:
//   1. The model's turn produced zero tool calls (text-only response)
//   2. Tools ARE available — the model could have called one
//   3. The user's last message looks like an action request (contains
//      an action verb + a file path or code reference)
//   4. This reprompt hasn't already fired this run (cap = 1)
//
// Injects a single synthetic user message that names the missing action
// and points to the right tool. Capped at one injection so a model that
// genuinely can't tool-call doesn't loop forever.
//
// Why this exists:
//   Small models (gemma4:e4b 4B) frequently respond to "read X and do Y"
//   with prose — "I would read the file and change the regex..." — instead
//   of actually calling read_file + edit_file. The completion gate only
//   fires after edits; this hook fires before any edits happen, catching
//   the case where the model never started working.
// ---------------------------------------------------------------------------

const MAX_ACTION_REPROMPTS = 1;

/** Action verbs that indicate the user wants something done, not just explained. */
const ACTION_VERB_RE =
  /\b(read|edit|fix|run|add|create|rename|update|change|modify|write|delete|move|refactor|implement|extend|remove|replace|convert|migrate)\b/i;

/** File path patterns that indicate workspace files are involved. */
const FILE_PATH_RE =
  /\b\w+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cpp|c|rb|sh|yaml|yml|json|toml)\b|(?:src|tests?|lib|pkg|cmd)\/\S+/;

/**
 * Return the text content of the last real user message (skipping
 * tool-result messages and synthetic gate injections).
 */
function lastUserMessageText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const raw =
      typeof msg.content === 'string'
        ? msg.content
        : msg.content
            .filter((b) => b.type === 'text')
            .map((b) => (b as { text: string }).text)
            .join(' ');
    // Skip synthetic gate injections — they start with '[Completion gate'
    // or '[You have not read'. Only the user's original intent counts.
    if (raw.startsWith('[')) continue;
    return raw;
  }
  return '';
}

/**
 * Return true when the message looks like an action request —
 * the user wants something done, not just explained.
 */
export function isActionRequest(text: string): boolean {
  return ACTION_VERB_RE.test(text) && FILE_PATH_RE.test(text);
}

/**
 * Inject a reprompt when the model responded with text but no tool calls
 * on what looks like an action request. Returns true when a reprompt was
 * injected (caller should `continue` the loop).
 */
export function maybeInjectActionReprompt(state: LoopState, fullText: string, callbacks: AgentCallbacks): boolean {
  if (state.actionRepromptCount >= MAX_ACTION_REPROMPTS) return false;
  if (!fullText) return false;
  if (state.tools.length === 0) return false;

  const userText = lastUserMessageText(state.messages);
  if (!isActionRequest(userText)) return false;

  state.actionRepromptCount++;
  state.logger?.info(
    `Action-request reprompt fired (#${state.actionRepromptCount}/${MAX_ACTION_REPROMPTS}): ` +
      `model responded with text only on an action request`,
  );
  callbacks.onText('\n\n⚙️ No tool calls detected — re-prompting to use tools...\n');
  state.messages.push({
    role: 'user',
    content: [
      {
        type: 'text' as const,
        text:
          'Your last response was text only — you described what to do but did not call any tools. ' +
          'The request requires you to actually use tools to make changes. ' +
          'Call the appropriate tools now (read_file, edit_file, run_command, etc.) ' +
          'rather than explaining what you would do.',
      },
    ],
  });
  return true;
}
