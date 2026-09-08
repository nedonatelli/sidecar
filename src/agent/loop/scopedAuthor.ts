import type { ChatMessage, ToolResultContentBlock, ToolUseContentBlock } from '../../ollama/types.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';

// ---------------------------------------------------------------------------
// Scoped author — post-turn policy for the no-op edit.
//
// A `search` equal to its `replace` is the largest edit_file failure bucket:
// 130 of 349 failures, and 43-47% of runs open with one. It looks like the model
// pointing at code rather than editing it — the anchors are real file text, and
// the thinking that precedes them is still analysis ("The user wants me to fix a
// bug in separable.py...") rather than a decision about the new code.
//
// What makes this worth another attempt after the identical-edit nudge failed
// (153 matched pairs, p=0.65): the model CAN write these replacements. Asked
// directly — the issue, the exact block, "write what it should become" — gemma4
// produced a correct, different replacement on 6 of 6 recorded no-op regions,
// with thinking on and off. The capability is there; the wide agentic turn is
// not getting it out.
//
// The nudge did not test that. It injected a request into the SAME conversation,
// carrying the whole history and all 49 tool schemas, and asked the model to try
// again. This asks a different question in a different frame: one call, one job,
// the block and the task and nothing else.
//
// It SUGGESTS, never writes. The result is model-authored code that the main
// loop has not seen; handing it back as a candidate keeps the existing review
// path (and the syntax gate) in front of every byte that reaches disk. If the
// narrow framing works, auto-applying it is a separate decision with its own
// evidence.
//
// Off unless SIDECAR_SCOPED_AUTHOR=1.
// ---------------------------------------------------------------------------

/** One suggestion per file. Past that, the existing escalation path takes over. */
const SCOPED_AUTHOR_MAX_PER_FILE = 1;
/** The scoped call is a fallback, not the main event — keep it cheap. */
const AUTHOR_MAX_TOKENS = 700;
/** How much of the region to show. Whole functions are the point; whole files are not. */
const REGION_LIMIT = 2_000;
/** How much of the task statement to carry across. */
const TASK_LIMIT = 1_200;

/**
 * A no-op edit, detected from the CALL rather than the error text.
 *
 * Keying on the message was wrong twice over. edit_file has at least two
 * wordings for this -- "search and replace text are identical; no change would
 * be made" and "'search' and 'replace' are identical, so there is no change to
 * make" -- and a smoke run hit both, so a string match caught half the cases.
 * The inputs are unambiguous and cannot drift when someone rewords an error, and
 * they are also how the 130-of-349 figure was measured in the first place.
 */
export function isNoOpEdit(tu: ToolUseContentBlock, result: ToolResultContentBlock | undefined): boolean {
  if (tu.name !== 'edit_file') return false;
  if (!result?.is_error) return false;
  const input = tu.input as Record<string, unknown>;
  const search = typeof input.search === 'string' ? input.search : '';
  const replace = typeof input.replace === 'string' ? input.replace : '';
  return search.length > 0 && search === replace;
}

/**
 * The scoped prompt. Deliberately narrow: this is the framing that worked when
 * the same regions were put to the model by hand, and the whole hypothesis is
 * that narrowness is what makes the difference.
 */
export function buildAuthorPrompt(task: string, filePath: string, region: string): ChatMessage[] {
  const t = task.length > TASK_LIMIT ? `${task.slice(0, TASK_LIMIT)}…` : task;
  const r = region.length > REGION_LIMIT ? `${region.slice(0, REGION_LIMIT)}…` : region;
  return [
    {
      role: 'user',
      content:
        `You are fixing this issue in ${filePath}:\n\n${t}\n\n` +
        `Here is the exact code that needs to change:\n\`\`\`\n${r}\n\`\`\`\n\n` +
        `Write ONLY the replacement code for that block — the version it should become after the fix. ` +
        `No explanation, no markdown fence, just the code. It must differ from the block above.`,
    },
  ];
}

/**
 * Pull code out of the reply, or nothing.
 *
 * Rejects three things, each of which would waste the main model's next turn:
 * an empty answer, prose instead of code, and a reply identical to the region —
 * the very failure this exists to fix.
 */
export function extractReplacement(raw: string, region: string): string | null {
  if (!raw) return null;
  let body = raw.trim();
  const fenced = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(body);
  if (fenced) body = fenced[1];
  body = body.trim();
  if (!body) return null;
  // Prose tell: a first line that reads like a sentence about the code rather
  // than code. Cheap and one-directional — a false reject costs nothing.
  const first = body.split('\n', 1)[0].trim();
  if (/^(sure|certainly|here('s| is)|the (code|replacement|fix)|to fix|i )/i.test(first)) return null;
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  if (norm(body) === norm(region)) return null;
  return body;
}

function editInput(tu: ToolUseContentBlock): { path: string; search: string } | null {
  const input = tu.input as Record<string, unknown>;
  const path = typeof input.path === 'string' ? input.path : typeof input.file_path === 'string' ? input.file_path : '';
  const search = typeof input.search === 'string' ? input.search : '';
  return path && search ? { path, search } : null;
}

/** The run's task statement — the first user message, which is the issue. */
function taskStatement(state: LoopState): string {
  for (const m of state.messages) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content.find((b) => b.type === 'text');
      if (text && 'text' in text) return String(text.text);
    }
  }
  return '';
}

/**
 * On a no-op edit, ask the model in a narrow frame what the block should become
 * and hand the answer back as a candidate. Returns true when a suggestion was
 * injected.
 */
export async function applyScopedAuthor(
  state: LoopState,
  pendingToolUses: ToolUseContentBlock[],
  toolResults: ToolResultContentBlock[],
  client: SideCarClient,
  callbacks: AgentCallbacks,
): Promise<boolean> {
  if (process.env.SIDECAR_SCOPED_AUTHOR !== '1') return false;

  const byId = new Map(toolResults.map((r) => [r.tool_use_id, r]));
  for (const tu of pendingToolUses) {
    if (!isNoOpEdit(tu, byId.get(tu.id))) continue;

    const parsed = editInput(tu);
    if (!parsed) continue;
    const used = state.scopedAuthorByFile.get(parsed.path) ?? 0;
    if (used >= SCOPED_AUTHOR_MAX_PER_FILE) continue;
    state.scopedAuthorByFile.set(parsed.path, used + 1);

    const task = taskStatement(state);
    if (!task) continue;

    let reply = '';
    try {
      client.routeForDispatch({ role: 'summarize' });
      reply = await client.complete(buildAuthorPrompt(task, parsed.path, parsed.search), AUTHOR_MAX_TOKENS);
    } catch (err) {
      // A failed side-call must not cost the run its turn -- but it must not be
      // invisible either. A silent catch here is what made the first smoke run
      // ambiguous: no draft appeared and there was no way to tell whether the
      // hook had declined, thrown, or never run.
      state.logger?.info(`Scoped author call failed for ${parsed.path}: ${(err as Error).message.slice(0, 120)}`);
      return false;
    }

    const replacement = extractReplacement(reply, parsed.search);
    if (!replacement) {
      state.logger?.info(`Scoped author draft rejected for ${parsed.path} (${reply.length} chars returned)`);
      return false;
    }

    callbacks.onText(`\n💡 Drafted a replacement for ${parsed.path.split('/').pop()}\n`);
    state.logger?.info(`Scoped author produced ${replacement.length} chars for ${parsed.path}`);
    state.messages.push({
      role: 'user',
      content: [
        {
          type: 'text' as const,
          text:
            `Your last edit_file call on ${parsed.path} sent the same text in 'search' and 'replace', so it asked ` +
            `for no change. Here is a draft of what that block should become:\n\n\`\`\`\n${replacement}\n\`\`\`\n\n` +
            `If it is right, call edit_file again with the SAME 'search' text and this as 'replace'. If it is wrong, ` +
            `write your own replacement — but 'replace' must differ from 'search'.`,
        },
      ],
    });
    return true;
  }
  return false;
}
