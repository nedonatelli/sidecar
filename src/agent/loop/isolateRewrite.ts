import type { ToolUseContentBlock } from '../../ollama/types.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';

// ---------------------------------------------------------------------------
// Isolate-don't-regenerate nudge — post-turn policy.
//
// When a model gets stuck on a fiddly bug it tends to reach for the wrong
// technique: it regenerates the WHOLE file with write_file, over and over,
// instead of changing the one broken function. That failure mode is doubly
// destructive —
//
//   1. Full rewrites lose working parts. Dogfooding caught qwen3.5 deleting
//      a calculator's "=" button mid-fix simply because it regenerated the
//      whole file and dropped a piece it had already gotten right.
//   2. Full rewrites don't converge. Re-emitting 100+ lines to tweak one
//      regex reintroduces variance everywhere instead of isolating the fix,
//      so the model thrashes until cycle detection bails it.
//
// Cycle detection already *catches* this thrash, but bailing says "give up".
// The scaffold's job is to lift a limited model past where it'd land on its
// own, so this hook fires FIRST and *redirects*: it tells the model to switch
// to edit_file on the specific broken function and leave the rest untouched.
// A model that can't one-shot a parse bug can still converge on it when it's
// editing five lines instead of regenerating the file.
//
// A "rewrite" is a write_file targeting a file that already exists this run —
// either it was read (so it has prior content the model is overwriting) or it
// has already been written once. The first write_file that *creates* a file is
// not a rewrite and never nudges. Bounded by ISOLATE_NUDGE_MAX per file so a
// model that ignores the nudge falls through to cycle detection rather than
// being nudged forever.
//
// Returns `true` when a nudge was injected.
// ---------------------------------------------------------------------------

/** A second (or later) full overwrite of the same file triggers the nudge. */
const REWRITE_NUDGE_THRESHOLD = 2;
/** Max nudges per file before we let cycle detection take over as backstop. */
const ISOLATE_NUDGE_MAX = 2;

function writeFilePath(tu: ToolUseContentBlock): string | undefined {
  if (tu.name !== 'write_file') return undefined;
  const input = tu.input as Record<string, unknown>;
  const v = input.path ?? input.file_path;
  return typeof v === 'string' && v ? v : undefined;
}

/** True if `path` was read this run (exact or basename match against filesReadThisRun). */
function wasReadThisRun(path: string, state: LoopState): boolean {
  if (state.filesReadThisRun.has(path)) return true;
  const base = path.split('/').pop()!.toLowerCase();
  for (const read of state.filesReadThisRun) {
    if (read.split('/').pop()!.toLowerCase() === base) return true;
  }
  return false;
}

/**
 * Detect repeated full-file overwrites and nudge the model toward targeted
 * edit_file changes. Counts every write_file this turn; nudges when a file is
 * being overwritten wholesale (a 2nd+ write, or a write over a file already
 * read this run) and the per-file nudge budget isn't spent.
 */
export function applyIsolateRewriteNudge(
  state: LoopState,
  pendingToolUses: ToolUseContentBlock[],
  callbacks: AgentCallbacks,
): boolean {
  const overwritten: string[] = [];
  for (const tu of pendingToolUses) {
    const path = writeFilePath(tu);
    if (!path) continue;
    const prior = state.fullRewriteCountByFile.get(path) ?? 0;
    const count = prior + 1;
    state.fullRewriteCountByFile.set(path, count);
    // A rewrite = overwriting content that already exists: a 2nd+ write to the
    // same path, or the 1st write over a file we already read this run.
    const isRewrite = count >= REWRITE_NUDGE_THRESHOLD || wasReadThisRun(path, state);
    const nudged = state.isolateNudgesByFile.get(path) ?? 0;
    if (isRewrite && nudged < ISOLATE_NUDGE_MAX) {
      overwritten.push(path);
      state.isolateNudgesByFile.set(path, nudged + 1);
    }
  }

  if (overwritten.length === 0) return false;

  callbacks.onText(`\n💡 Switch to targeted edits: ${overwritten.map((f) => f.split('/').pop()).join(', ')}\n`);
  const fileList = overwritten.join(', ');
  state.messages.push({
    role: 'user',
    content: [
      {
        type: 'text' as const,
        text:
          `You just rewrote the entire file (${fileList}) with write_file. Stop regenerating whole files — ` +
          `full rewrites lose working parts you'd already gotten right (a button, a method, an import) and ` +
          `don't converge on a fix. Use edit_file to change ONLY the specific broken function or lines, and ` +
          `leave the rest of the file exactly as it is. If a test is failing, read its exact assertion failure ` +
          `and edit just the code that assertion points to.`,
      },
    ],
  });
  return true;
}
