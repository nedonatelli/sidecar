import { workspace, Uri } from 'vscode';
import type { ChatMessage } from '../../ollama/types.js';
import { extractCitedPaths, pathVariants, hasUnverifiedHedge } from '../citationCheck.js';
import { normalizePath } from './pathUtil.js';

// ---------------------------------------------------------------------------
// No-read-on-file-request gate
//
// Fires once when the model responds without calling any file-reading tool
// that references the specific file(s) mentioned in the user's request.
// Catches the "filename pattern matching" failure mode where a model infers
// file contents from the filename alone instead of reading the actual file.
//
// Gap fixed (v0.112.4): previously used hasAnyReadToolCall() which returned
// true if the model called *any* read tool at any point — so a run_command
// for an unrelated file (e.g. `wc -l src/**/*.ts`) would suppress the gate
// even when package.json was never touched. Now checks per-file: each
// mentioned file must have had a read tool call whose input references it.
// ---------------------------------------------------------------------------

/** File extensions whose presence in a user message signals a file lookup is needed. */
const FILE_MENTION_RE = /\b[\w./\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|json|md|toml|yaml|yml|sh|cs|java|cpp|c|h)\b/gi;

/** Tools that constitute "the model read something for a specific file".
 *  run_command is included because `grep -n`, `jq`, `cat`, `head`, `tail`
 *  are all valid read paths — we check if the file name appears in the command. */
const READ_TOOL_NAMES = new Set(['read_file', 'grep', 'search_files', 'list_directory', 'run_command']);

// ---------------------------------------------------------------------------
// Workspace-metric query gate
//
// Fires once when the user asks a metric question about the workspace
// (file counts, line counts, dependency versions, etc.) but the model
// answered without running any shell command. These answers require live
// tool output — training-data guesses are reliably wrong about the current
// project state.
// ---------------------------------------------------------------------------

/**
 * Metric query words that signal the user wants a live workspace fact,
 * not a training-data inference.
 */
const WORKSPACE_METRIC_RE =
  /\b(how many|number of|count(ing)?|largest|biggest|longest|line count|lines in|wc\b|version (of|in)|size of)\b/i;

/**
 * Directory or config-file references that anchor a metric query to the
 * current workspace rather than a general question.
 */
const WORKSPACE_DIR_RE =
  /\b(src|tests?|lib|pkg|cmd)\b[/\\]|\bpackage\.json\b|\btsconfig\b|\bCargo\.toml\b|\bgo\.mod\b/i;

export function firstUserText(messages: ChatMessage[]): string {
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (typeof b === 'object' && b !== null && 'type' in b && b.type === 'text' && 'text' in b) {
          return b.text as string;
        }
      }
    }
  }
  return '';
}

/**
 * The most recent user message text — the request that triggered the current
 * run. Captured at loop init (before any synthetic gate injection is appended)
 * so it reflects the user's actual current-turn ask, not the first message of a
 * long conversation. See GateState.currentUserRequest.
 */
export function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (typeof b === 'object' && b !== null && 'type' in b && b.type === 'text' && 'text' in b) {
          return b.text as string;
        }
      }
    }
  }
  return '';
}

/**
 * Returns true if any assistant message contains a read-capable tool call
 * whose serialised input references `fileName` (case-insensitive).
 * This is a per-file check — a run_command for an unrelated path does NOT
 * satisfy this predicate.
 */
function hasReadToolCallForFile(messages: ChatMessage[], fileName: string): boolean {
  const lower = fileName.toLowerCase();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (typeof b !== 'object' || b === null || !('type' in b) || b.type !== 'tool_use') continue;
      if (!READ_TOOL_NAMES.has((b as { name: string }).name)) continue;
      const inputStr = JSON.stringify((b as { input?: unknown }).input ?? {}).toLowerCase();
      if (inputStr.includes(lower)) return true;
    }
  }
  return false;
}

/**
 * True if `fileName` (as mentioned in the user's request) was written/edited
 * by the agent this session. Matches an editedFiles entry by basename or path
 * suffix — editedFiles stores the path the write tool used ("calculator.py" or
 * "src/calculator.py"); the mention may be bare ("calculator.py").
 */
function fileWasEdited(fileName: string, editedFiles?: ReadonlySet<string>): boolean {
  if (!editedFiles || editedFiles.size === 0) return false;
  const base = fileName.split('/').pop()!.toLowerCase();
  for (const edited of editedFiles) {
    const e = edited.toLowerCase();
    if (e === base || e.endsWith('/' + base) || e === fileName.toLowerCase()) return true;
  }
  return false;
}

/** Returns true if any assistant message contains a run_command tool call. */
function hasRunCommandCall(messages: ChatMessage[]): boolean {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (typeof b === 'object' && b !== null && 'type' in b && b.type === 'tool_use' && 'name' in b) {
        if ((b as { name: string }).name === 'run_command') return true;
      }
    }
  }
  return false;
}

/**
 * Returns a reprompt string if the user's message mentions a specific file
 * path but no read tool call referencing that file was made. Checks each
 * mentioned file independently — a tool call for file A does not satisfy
 * the requirement for file B. Returns null when no reprompt is needed.
 */
export function buildNoReadReprompt(
  messages: ChatMessage[],
  editedFiles?: ReadonlySet<string>,
  requestText?: string,
): string | null {
  const userText = requestText ?? firstUserText(messages);
  if (!userText) return null;
  const fileMatches = userText.match(FILE_MENTION_RE);
  if (!fileMatches) return null;
  for (const file of fileMatches) {
    // The agent authored this file this session — writing implies knowing its
    // contents, so a read is redundant. Skips the "build calculator.py" case
    // where the user names the file with write intent and the agent creates +
    // tests it but never reads it. (Dogfooding fired a pointless read+describe
    // cycle on a freshly-written, already-tested file.)
    if (fileWasEdited(file, editedFiles)) continue;
    if (!hasReadToolCallForFile(messages, file)) {
      return (
        `You mentioned \`${file}\` but did not call read_file, grep, or any other file-reading tool before responding. ` +
        `Call \`read_file(path="${file}")\` now and answer from its actual contents — do not infer from the filename or training data.`
      );
    }
  }
  return null;
}

/**
 * Returns a reprompt string if the user asked a workspace metric question
 * (file count, line count, version, etc.) but the model answered without
 * running any shell command. Returns null when no reprompt is needed.
 */
export function buildNoShellReprompt(messages: ChatMessage[], requestText?: string): string | null {
  if (hasRunCommandCall(messages)) return null;
  const userText = requestText ?? firstUserText(messages);
  if (!userText) return null;
  if (!WORKSPACE_METRIC_RE.test(userText) || !WORKSPACE_DIR_RE.test(userText)) return null;
  return (
    'Your response answered a workspace metric question (file count, line count, version, etc.) ' +
    'without running a shell command. Your training data does not reflect the current state of this project. ' +
    'Run the appropriate command (find, wc -l, jq, rg --count, etc.) and answer from the actual output.'
  );
}

// ---------------------------------------------------------------------------
// No-grounding-on-analysis-query gate
//
// Fires once when the user asks for an open-ended review/evaluation of the
// codebase or its design ("review the architecture", "assess this codebase")
// but the model answered without calling ANY grounding tool — no read_file,
// grep, search_files, list_directory, project_knowledge_search, or
// run_command. These questions name no specific file, so the no-read gate
// never trips; the model is free to answer from injected SIDECAR.md sections
// + the file tree + RAG context alone. The result is generic, training-data
// architecture advice that hallucinates absent files and recommends patterns
// the project already implements. This gate forces at least one look at the
// actual code before a verdict.
// ---------------------------------------------------------------------------

/** Analysis verbs that signal the user wants an evaluation of real code. */
const ANALYSIS_VERB_RE = /\b(review|evaluat(e|ing|ion)|assess|audit|critiqu(e|ing)|analy[sz]e|appraise|inspect)\b/i;

/** Targets that anchor an analysis query to this workspace's code/design. */
const ANALYSIS_TARGET_RE =
  /\b(architecture|design|codebase|code\s?base|structure|implementation|module|component|this (project|repo|repository|code|extension)|the (project|repo|repository|codebase|code))\b/i;

/** True when the message asks for an evaluation/review of real code in this workspace. */
export function isAnalysisRequest(text: string): boolean {
  return ANALYSIS_VERB_RE.test(text) && ANALYSIS_TARGET_RE.test(text);
}

/** Tools that constitute "the model actually looked at the code". */
const GROUNDING_TOOL_NAMES = new Set([
  'read_file',
  'grep',
  'search_files',
  'list_directory',
  'run_command',
  'project_knowledge_search',
]);

/** Returns true if any assistant message made a grounding tool call. */
function hasAnyGroundingToolCall(messages: ChatMessage[]): boolean {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (typeof b !== 'object' || b === null || !('type' in b) || b.type !== 'tool_use') continue;
      if (GROUNDING_TOOL_NAMES.has((b as { name: string }).name)) return true;
    }
  }
  return false;
}

/**
 * Returns a reprompt string if the user asked for an open-ended review or
 * evaluation of the codebase/design but the model answered without calling
 * any grounding tool. Returns null when no reprompt is needed.
 */
export function buildNoGroundingReprompt(messages: ChatMessage[], requestText?: string): string | null {
  if (hasAnyGroundingToolCall(messages)) return null;
  const userText = requestText ?? firstUserText(messages);
  if (!userText) return null;
  if (!isAnalysisRequest(userText)) return null;
  return (
    'You produced a review of this codebase without reading any of it — no read_file, grep, ' +
    'project_knowledge_search, or other grounding tool was called. Your training data does not ' +
    'include this project, so every claim about what the code does, lacks, or should add is a guess. ' +
    'Inspect the relevant modules first (grep for the patterns you intend to comment on, read the files ' +
    'that own them), then ground each point in what you actually found — cite the file/symbol. ' +
    'Before recommending any pattern, search for it: do not advise adding something the project already has.'
  );
}

// ---------------------------------------------------------------------------
// Unverified-claim gate (scaffolding roadmap V1)
//
// Even a grounded, structured review can ship fabricated citations: a path
// that doesn't exist (`src/context/context.ts` when the real file is
// `src/agent/context.ts`), or findings the model itself hedges as unverified
// ("I cannot verify…", "implied usage…"). This gate runs on an analysis/review
// answer, extracts the file paths it cites, checks they resolve on disk, and
// reprompts once when any are fabricated or any hedge phrase admits an
// unverified claim. Scoped to analysis intent so it never flags a legitimate
// "create src/new.ts" proposal in a normal coding task.
// ---------------------------------------------------------------------------

/** Return the text of the most recent assistant message (the answer being gated). */
function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((b) => typeof b === 'object' && b !== null && 'type' in b && b.type === 'text' && 'text' in b)
        .map((b) => (b as { text: string }).text)
        .join('\n');
    }
  }
  return '';
}

/** Default existence check against the active workspace. Injectable for tests. */
async function defaultFileExists(relPath: string): Promise<boolean> {
  const root = workspace.workspaceFolders?.[0]?.uri;
  if (!root) return false;
  try {
    await workspace.fs.stat(Uri.joinPath(root, relPath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a reprompt when an analysis/review answer cites file paths that don't
 * resolve on disk, or contains hedge phrases admitting an unverified claim.
 * Returns null when the answer is clean (or the request wasn't an analysis).
 * `fileExists` is injectable so tests don't touch a real workspace.
 */
export async function buildUnverifiedClaimReprompt(
  messages: ChatMessage[],
  fileExists: (relPath: string) => Promise<boolean> = defaultFileExists,
  requestText?: string,
): Promise<string | null> {
  const userText = requestText ?? firstUserText(messages);
  if (!userText) return null;
  if (!isAnalysisRequest(userText)) return null;

  const answer = lastAssistantText(messages);
  if (!answer) return null;

  const fabricated: string[] = [];
  const seen = new Set<string>();
  for (const cited of extractCitedPaths(answer)) {
    const rel = normalizePath(cited);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    let resolved = false;
    for (const v of pathVariants(rel)) {
      if (await fileExists(v)) {
        resolved = true;
        break;
      }
    }
    if (!resolved) fabricated.push(rel);
  }

  const hedged = hasUnverifiedHedge(answer);
  if (fabricated.length === 0 && !hedged) return null;

  const parts: string[] = [];
  if (fabricated.length > 0) {
    parts.push(
      `Your review cites ${fabricated.length === 1 ? 'a path that does not exist' : 'paths that do not exist'} in ` +
        `this workspace: ${fabricated.map((f) => `\`${f}\``).join(', ')}. A citation must be a file you actually ` +
        `opened. Locate the correct path (grep / list_directory), read it, and fix or remove the reference — do not ` +
        `cite a file you have not read.`,
    );
  }
  if (hedged) {
    parts.push(
      'Your answer contains an unverified claim (it says something is "implied", "assumed", or that you "cannot ' +
        'verify" / answered "without reading"). Open the relevant file and confirm the claim, or delete the finding. ' +
        'Do not present an inference as a finding.',
    );
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// No-write-on-named-file gate
//
// Fires once when the user's message explicitly names a file AND uses
// write-intent language (add, extend, update, modify, edit, implement,
// create, fix, change) near that file, but the agent calls done without
// having written to it. Catches the "finish after the first part" failure
// mode where a model implements the feature but skips writing the test file
// (or vice versa) even though the user named both.
//
// Conservative by design: only fires when write-intent language is present
// in the message so read-only requests ("read src/foo.ts and explain…") do
// not trigger a spurious reprompt.
// ---------------------------------------------------------------------------

/**
 * Write-intent verbs that signal the user wants the named file to be
 * modified (not just read for context).
 */
const WRITE_INTENT_RE =
  /\b(add|extend|update|modify|edit|implement|create|fix|change|write|insert|append|refactor|rename|delete|remove)\b/i;

/**
 * Returns a reprompt string listing files that were mentioned in the user's
 * message with write intent but were never written by the agent. Returns
 * null when no reprompt is needed.
 */
export async function buildNoFileWriteReprompt(
  messages: ChatMessage[],
  editedFiles: Set<string>,
  requestText?: string,
  fileExists: (relPath: string) => Promise<boolean> = defaultFileExists,
): Promise<string | null> {
  const userText = requestText ?? firstUserText(messages);
  if (!userText) return null;
  if (!WRITE_INTENT_RE.test(userText)) return null;

  const mentioned = userText.match(FILE_MENTION_RE);
  if (!mentioned) return null;

  // Normalise mentioned paths: strip leading backticks/quotes, drop pure
  // directory tokens (no extension), collapse to basename for matching so
  // "src/deps/semver.test.ts" matches an editedFiles entry of "semver.test.ts"
  // regardless of how the sandbox rooted it.
  const unwritten: string[] = [];
  for (const raw of mentioned) {
    const clean = raw.replace(/[`'"]/g, '');
    // Skip if the agent wrote any path that ends with the same basename.
    const base = clean.split('/').pop() ?? clean;
    const wasWritten =
      editedFiles.has(clean) ||
      editedFiles.has(base) ||
      [...editedFiles].some((f) => f.endsWith('/' + base) || f === base);
    if (wasWritten) continue;
    // Skip files that already exist on disk: the gate's job is to catch a named
    // file the user asked to CREATE that never got created. An existing file is
    // almost always a read-only dependency referenced by the task ("wire to the
    // functions already in calculator.py"), not a missing write target.
    // Dogfooding: a GUI prompt referencing an existing calculator.py wrongly
    // tripped this nudge.
    if (await fileExists(clean)) continue;
    unwritten.push(clean);
  }

  if (unwritten.length === 0) return null;

  const fileList = unwritten.map((f) => `\`${f}\``).join(', ');
  return (
    `Your task mentioned ${fileList} but you finished without writing to ${unwritten.length === 1 ? 'it' : 'any of them'}. ` +
    `If the task required changes to ${unwritten.length === 1 ? 'that file' : 'those files'}, make them now. ` +
    `If you already completed everything the task asked for, ignore this and call done again.`
  );
}

