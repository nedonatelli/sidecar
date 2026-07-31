import type { ChatMessage } from '../../ollama/types.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';
import { hasEditShapedCodeBlock } from './unappliedEdit.js';

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

import { MAX_ACTION_REPROMPTS } from '../../config/constants.js';

/**
 * Verbs that MUTATE the workspace. Strictly separate from the read-only verbs
 * below, because one caller may synthesize a write from them and must never do
 * so for a request that only asked to look at something.
 */
const MUTATION_VERB_RE =
  /\b(edit|fix|add|create|rename|update|change|modify|write|delete|move|refactor|implement|extend|remove|replace|convert|migrate)\b/i;

/** Verbs that ask to inspect or execute, producing no workspace change by themselves. */
const READ_VERB_RE = /\b(read|run|check|find|get|look|search|show|list|fetch|retrieve)\b/i;

/** Action verbs that indicate the user wants something done, not just explained. */
const ACTION_VERB_RE = new RegExp(`${MUTATION_VERB_RE.source}|${READ_VERB_RE.source}`, 'i');

/**
 * Text announcing a deliberate decision not to act: "no changes needed",
 * "already satisfies", "leaving the file untouched". Distinct from
 * DEFERRED_ACTION_RE, which catches a model that meant to act and did not.
 */
const DECLINED_ACTION_RE =
  /\b(?:no (?:changes?|edits?|modifications?) (?:are )?(?:needed|required|necessary)|nothing to (?:change|do|fix|update)|already (?:does|satisfies|matches|meets|correct|implements)|no edit is required|leaving (?:the |it |this )?(?:file |code )?(?:untouched|as is|unchanged)|not (?:modifying|editing|changing) (?:it|this|the file))\b/i;

/** File path patterns that indicate workspace files are involved. */
const FILE_PATH_RE =
  /\b\w+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cpp|c|rb|sh|yaml|yml|json|toml)\b|(?:src|tests?|lib|pkg|cmd)\/\S+/;

/**
 * Matches model text that announces intent to act but contains no tool call —
 * e.g. "I will now attempt to...", "Let me try again", "I'll now read the file".
 * Also matches permission-asking phrases where the model identified the right
 * action but stopped to ask for confirmation instead of executing it —
 * e.g. "Would you like me to implement this?", "Shall I add the example?".
 * Fires the reprompt even when the user's message isn't an action request.
 */
// An intent-opener ("I will", "Let me", …) followed within the same clause by
// an action/exploration verb. The intervening `[^.!?\n]{0,40}?` is the fix for
// planning stalls like "I will start by reading the core files" or "I'll first
// map out the system", where a word ("start by", "first") sits between the
// opener and the verb — the old glued-together pattern missed those entirely.
const DEFERRED_ACTION_RE =
  /\b(?:I will|I'll|I am going to|I'm going to|I plan to|I intend to|I need to|Let me|Let's|Next,?\s+I(?:'ll| will)?|First,?\s+I(?:'ll| will)?)\b[^.!?\n]{0,40}?\b(?:read|examine|investigate|analy[sz]e|inspect|review|map|explore|look|check|start|begin|proceed|continue|search|fetch|open|trace|study|dig|gather|edit|implement|write|create|refactor|build|run|add|update|fix|modify|delete|move|attempt|try)\b|\b(?:Would you like me to|Shall I|Do you want me to|Should I go ahead|Want me to)\b/i;

/**
 * Return the text of the last REAL user message — the user's actual intent.
 *
 * Tool results are `role: 'user'` messages carrying `tool_result` blocks and no
 * text. An earlier version filtered to text blocks, got `''`, saw that `''` does
 * not start with '[', and returned it as the user's message. So on every turn
 * that followed a tool call, this reported the user had said nothing — and
 * `isActionRequest('')` is false, which silently disabled the reprompt for the
 * entire class of runs it exists to catch: read the file, then describe the edit
 * in prose instead of making it. (Observed live: qwen2.5-coder read greeter.ts,
 * printed the finished JSDoc in a fenced block, and the loop accepted it as
 * done.) It only ever fired on a model's very first turn, before any tool ran.
 *
 * A message with no text is not a user message. Skip it, and keep walking back
 * to the real one.
 */
export function lastUserMessageText(messages: ChatMessage[]): string {
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
    // Tool results and other text-free blocks carry no intent.
    if (raw.trim() === '') continue;
    // Skip synthetic loop injections — gate reprompts, and this hook's own
    // messages, all start with '['. Only the user's original intent counts;
    // without this the reprompt's own injection masked the user's request and
    // disarmed every firing after the first.
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
 * True when the user asked for the workspace to be CHANGED, not merely read.
 *
 * Strictly narrower than {@link isActionRequest}, and deliberately so. The
 * re-prompt nudge should fire on "read src/foo.ts" — the model ought to call
 * read_file rather than answer from thin air. But synthesizing a write_file from
 * a code fence must not: a model answering a read request prints fences to
 * ILLUSTRATE, and coercing those to disk fabricates files, or overwrites the very
 * file the user asked about with a paraphrase of itself.
 *
 * Measured: "Read src/helpers.ts and tell me what it does." licensed coercion,
 * and 3 of 5 claude-sonnet-5 trials wrote a file the model had just correctly
 * reported as absent.
 */
export function isMutationRequest(text: string): boolean {
  return MUTATION_VERB_RE.test(text) && FILE_PATH_RE.test(text);
}

/**
 * Return true when the model's own text announces intent to act but
 * contains no tool call — e.g. "I will now attempt to read the file".
 * Used to catch models (e.g. gemma4:e4b) that describe their next
 * action in prose instead of executing it.
 */
export function looksLikeDeferredAction(text: string): boolean {
  return DEFERRED_ACTION_RE.test(text);
}

/**
 * True when the model's text announces a deliberate decision NOT to act — the
 * inverse of {@link looksLikeDeferredAction}.
 *
 * Fence-write coercion overrode exactly this. Asked to update a function that
 * already met the requirement, the model answered "no changes needed ... per
 * rule 7, I'm leaving the file untouched" and printed the current contents to
 * show why. Coercion read the fence as intent to write and wrote it — punishing
 * an agent for obeying an operating rule SideCar itself issues. Measured at 1 in
 * 4 trials on claude-sonnet-5 (`no-op-recognition`).
 *
 * Deciding not to edit is a legitimate outcome, and nothing may synthesize a
 * write over the top of it.
 */
export function looksLikeDeclinedAction(text: string): boolean {
  return DECLINED_ACTION_RE.test(text);
}

/**
 * True when the model's text contains a fabricated tool-interaction wrapper —
 * `<tool_output …>` / `<tool_response>` written by the model itself. Real tool
 * results only ever appear in tool_result blocks the loop sends back; an
 * assistant emitting the wrapper is roleplaying the result of a call it never
 * made, and now BELIEVES the action happened. Observed live (qwen2.5-coder:7b,
 * lh-calculator-session): it printed `<tool_response><tool_output
 * tool="edit_file">{…args…}` as text, concluded the edit landed, and terminated
 * with the file unchanged. This is the strongest "thinks it acted, didn't"
 * signal there is.
 */
export function hasFakeToolOutput(text: string): boolean {
  return /<tool_(?:output|response)\b/i.test(text);
}

/** First workspace-file reference in `text`, or null — names the write target
 *  in the code-as-text reprompt so the model gets a concrete call to make. */
function extractTargetPath(text: string): string | null {
  const m = FILE_PATH_RE.exec(text);
  return m ? m[0] : null;
}

/**
 * Inject a reprompt when the model responded with text but no tool calls
 * on what looks like an action request. Returns true when a reprompt was
 * injected (caller should `continue` the loop).
 *
 * Two firing shapes:
 *   - generic: the model narrated instead of acting — "use tools".
 *   - code-as-text: the model printed the finished code in a fenced block (or
 *     fabricated a <tool_output> wrapper) and believes the work is done. The
 *     generic wording measured 0-for-3 converting qwen2.5-coder:7b on the
 *     calculator session; the targeted wording names the exact call to make and
 *     tells it the printed code was never saved.
 *
 * Both injected texts start with '[' so lastUserMessageText skips them —
 * without that, the reprompt's own injection became "the user's last message",
 * matched neither trigger, and disarmed the second firing exactly when the
 * model doubled down on fake output (observed live on qwen2.5-coder:7b).
 */
export function maybeInjectActionReprompt(state: LoopState, fullText: string, callbacks: AgentCallbacks): boolean {
  const maxActionReprompts = state.scaffoldingProfile?.maxActionReprompts ?? MAX_ACTION_REPROMPTS;
  if (state.actionRepromptCount >= maxActionReprompts) return false;
  if (!fullText) return false;
  if (state.tools.length === 0) return false;

  // codeAsText / fakeOutput pick the WORDING, not the trigger — a code fence on
  // a plain question is a legitimate final answer, so firing still requires an
  // action-request user message or announced-but-unexecuted intent. Targeted
  // wording is opt-in (unproven) — see codeAsTextRecoveryEnabled in settings.ts.
  const wordingEnabled = state.config.codeAsTextRecoveryEnabled === true;
  const codeAsText = wordingEnabled && hasEditShapedCodeBlock(fullText);
  const fakeOutput = wordingEnabled && hasFakeToolOutput(fullText);
  const userText = lastUserMessageText(state.messages);
  const triggered = isActionRequest(userText) || looksLikeDeferredAction(fullText);
  if (!triggered) return false;

  state.actionRepromptCount++;
  const shape = codeAsText || fakeOutput ? 'code-as-text' : 'generic';
  state.logger?.info(
    `Action-request reprompt fired (#${state.actionRepromptCount}/${maxActionReprompts}, ${shape}): ` +
      `model responded with text only on an action request`,
  );
  callbacks.onText('\n\n⚙️ No tool calls detected — re-prompting to use tools...\n');

  let text: string;
  if (codeAsText || fakeOutput) {
    const target = extractTargetPath(userText);
    const pathArg = target ? `path="${target}"` : 'path=<the file the task names>';
    const fakeNote = fakeOutput
      ? ' The <tool_output>/<tool_response> block you wrote yourself is fiction — real tool results only arrive ' +
        'after you emit an actual tool call.'
      : '';
    text =
      `[Code not applied] The code you printed was NOT saved — chat text never modifies a file.${fakeNote} ` +
      `Apply it now with a real tool call: write_file(${pathArg}, content=<the COMPLETE file — everything ` +
      `already in it PLUS your new code>). If you are unsure of the current contents, call ` +
      `read_file(${pathArg}) first, then write_file with everything. Emit the tool call directly — do not ` +
      `print the code as chat text again.`;
  } else {
    text =
      '[No tools called] Your last response was text only — you described what to do but did not call any tools. ' +
      'The request requires you to actually use tools to make changes. ' +
      'Call the appropriate tools now (read_file, edit_file, run_command, etc.) ' +
      'rather than explaining what you would do.';
  }
  state.messages.push({ role: 'user', content: [{ type: 'text' as const, text }] });
  return true;
}
