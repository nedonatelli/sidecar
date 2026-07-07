import type { ToolUseContentBlock } from '../../ollama/types.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';

// ---------------------------------------------------------------------------
// Unapplied-edit nudge — post-turn policy (mirror of isolateRewrite).
//
// A weak model often writes a corrected function/file as a fenced ```code block
// in its prose, then tries to verify it (re-runs the script, re-reads the file)
// WITHOUT ever calling edit_file / write_file — so the file never changed and it
// loops on the identical failure until cycle detection bails. Observed live on
// `run-fix-iteration-cycle`: the model emitted the fixed `stats.js` in a
// ```javascript block three times and re-ran `node stats.js` each time, never
// applying anything. This is the single most damaging pattern for fix-tasks
// (every SWE-bench instance is "fix this bug").
//
// Where isolateRewrite fires when the model rewrites TOO much (write_file when an
// edit_file would do), this fires when the model applies NOTHING: it described an
// edit in a code fence but called no mutation tool. It redirects the model to
// actually apply the change, BEFORE cycle detection gives up.
//
// Fires at most once per run (`unappliedEditNudged`) so a false positive — an
// explanatory code block the model never meant to apply — costs one message, not
// a loop. Returns `true` when a nudge was injected.
// ---------------------------------------------------------------------------

const MUTATION_TOOLS = new Set([
  'write_file',
  'edit_file',
  'delete_file',
  'create_file',
  'rename_file',
  'move_file',
  'apply_edit',
  'apply_patch',
]);

// Tools that signal the model THINKS it's checking an edit it believes it made —
// re-running the script, re-reading the file, checking diagnostics. Their
// presence alongside an unapplied code block is what distinguishes "described a
// fix then verified the phantom change" from a plain explanatory aside.
const VERIFY_TOOLS = new Set(['run_command', 'run_tests', 'read_file', 'get_diagnostics']);

// Fenced-block languages that denote source the model intends as file content
// (not a tool-call ```json block, not a shell transcript, not a diff view).
const CODE_FENCE_LANGS = new Set([
  'javascript',
  'js',
  'jsx',
  'typescript',
  'ts',
  'tsx',
  'python',
  'py',
  'go',
  'rust',
  'rs',
  'java',
  'c',
  'cpp',
  'c++',
  'csharp',
  'cs',
  'ruby',
  'rb',
  'php',
  'swift',
  'kotlin',
  'scala',
]);

// A fenced block only counts as an intended edit when it carries real code
// structure — a keyword/operator plus at least two non-trivial lines — so a
// one-liner or a prose snippet in a ```text block doesn't trip it.
const CODE_STRUCTURE = /\b(function|const|let|var|def|class|return|import|export|if|for|while)\b|=>|[;{}]/;

/** True when the model's turn text contains a fenced code block that reads as an
 *  intended file edit (a source-language fence with real, multi-line code). */
export function hasEditShapedCodeBlock(text: string): boolean {
  const fence = /```([\w+#]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const lang = m[1].toLowerCase();
    const body = m[2];
    if (!CODE_FENCE_LANGS.has(lang)) continue;
    const codeLines = body.split('\n').filter((l) => l.trim().length > 0);
    if (codeLines.length >= 2 && CODE_STRUCTURE.test(body)) return true;
  }
  return false;
}

/**
 * Detect "described an edit in a code fence but applied nothing, then verified"
 * and nudge the model to actually apply the change with edit_file / write_file.
 * No-op unless: an edit-shaped code block is present, NO mutation tool ran this
 * turn, at least one verify/execute tool ran, and the run hasn't nudged yet.
 */
export function applyUnappliedEditNudge(
  state: LoopState,
  pendingToolUses: ToolUseContentBlock[],
  fullText: string,
  callbacks: AgentCallbacks,
): boolean {
  if (state.unappliedEditNudged) return false;
  if (!fullText || !hasEditShapedCodeBlock(fullText)) return false;

  const appliedAnEdit = pendingToolUses.some((tu) => MUTATION_TOOLS.has(tu.name));
  if (appliedAnEdit) return false; // the model did apply something — nothing to nudge

  const verified = pendingToolUses.some((tu) => VERIFY_TOOLS.has(tu.name));
  if (!verified) return false; // a code block with no follow-up verify is likely just explanation

  state.unappliedEditNudged = true;
  callbacks.onText('\n💡 You wrote code but never applied it — use edit_file/write_file to change the file.\n');
  state.messages.push({
    role: 'user',
    content: [
      {
        type: 'text' as const,
        text:
          'You wrote code in a ``` block but did not call edit_file or write_file, so the file on disk is ' +
          'UNCHANGED — describing a change never modifies a file. That is why re-running produced the same result. ' +
          'Apply your change now with a tool call: use edit_file to replace the specific broken lines (preferred), ' +
          'or write_file to replace the whole file. Then re-run to verify.',
      },
    ],
  });
  return true;
}
