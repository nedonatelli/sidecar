import * as crypto from 'crypto';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';
import { MAX_UNVERIFIED_REWRITES } from '../tools/fs.js';

/** Times the loop will defer a write-thrash bail per file to force a verify first. */
const MAX_FORCE_VERIFY_BEFORE_BAIL = 2;

/** Enforce-edit blocks per file before the lock is released (the model was told
 * to use edit_file, ignored it, and would otherwise be trapped into a bail). */
const MAX_ENFORCE_EDIT_BLOCKS = 3;

// ---------------------------------------------------------------------------
// Circular-rewrite handling for cycle detection.
//
// A model stuck on a fiddly bug oscillates: it regenerates the WHOLE file with
// write_file, content A, then B, then A again — going in a circle instead of
// converging. Dogfooding caught qwen3.5 doing exactly this (write 6.5KB → write
// 4.2KB → rewrite a prior version) until normalized cycle detection killed the
// run with an incomplete, broken GUI.
//
// The write_file executor already soft-blocks a byte-identical re-write (no-op
// on disk; see fs.ts writeFile + ToolExecutorContext.writeHistoryByFile). But
// cycle detection runs BEFORE dispatch and counts the tool signature, so a
// blocked circular write would still trip the bail and end the whole run. This
// helper removes under-budget blocked circular writes from the list cycle
// detection sees, so the run CONTINUES (the model gets the soft-block message
// and a chance to switch to edit_file or verify) rather than dying outright.
//
// Bounded per file by MAX_CIRCULAR_BLOCKS_PER_FILE: once a file's budget is
// spent, its circular writes are left in the list so the normalized cycle
// detector bails the genuinely-stuck loop. The executor still no-ops the write
// in that case, so the last good version on disk is preserved either way.
// ---------------------------------------------------------------------------

const MAX_CIRCULAR_BLOCKS_PER_FILE = 2;

function hashContent(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Return `pendingToolUses` with under-budget blocked circular writes removed,
 * so cycle detection doesn't count them. A write is circular when its content
 * hash is already in `state.writeHistoryByFile` for that path (a version this
 * run already wrote). Non-write tools and first-time content pass through
 * untouched. Increments `state.circularRewriteBlocksByFile` and emits a
 * breadcrumb for each one excluded.
 */
export function excludeBlockedCircularRewrites(
  pendingToolUses: ToolUseContentBlock[],
  state: LoopState,
  callbacks: AgentCallbacks,
): ToolUseContentBlock[] {
  if (state.writeHistoryByFile.size === 0) return pendingToolUses;

  const kept: ToolUseContentBlock[] = [];
  for (const tu of pendingToolUses) {
    if (tu.name !== 'write_file') {
      kept.push(tu);
      continue;
    }
    const input = tu.input as Record<string, unknown>;
    const filePath = (input.path ?? input.file_path) as string | undefined;
    const content = input.content;
    if (!filePath || typeof content !== 'string') {
      kept.push(tu);
      continue;
    }
    const isCircular = state.writeHistoryByFile.get(filePath)?.has(hashContent(content)) ?? false;
    if (!isCircular) {
      kept.push(tu);
      continue;
    }
    const blocks = state.circularRewriteBlocksByFile.get(filePath) ?? 0;
    if (blocks >= MAX_CIRCULAR_BLOCKS_PER_FILE) {
      // Budget spent — leave it in so cycle detection bails the stuck loop.
      kept.push(tu);
      continue;
    }
    state.circularRewriteBlocksByFile.set(filePath, blocks + 1);
    state.logger?.warn(
      `Circular rewrite blocked: ${filePath} is byte-identical to a prior write this run — ` +
        `excluded from cycle detection so the run continues (${blocks + 1}/${MAX_CIRCULAR_BLOCKS_PER_FILE})`,
    );
    callbacks.onText(
      `\n♻️ Identical rewrite of ${filePath.split('/').pop()} blocked — make a targeted edit or verify instead.\n`,
    );
    // excluded from `kept` → cycle detection never sees it
  }
  return kept;
}

/**
 * Record files the agent SUCCESSFULLY edited via edit_file this turn into
 * `state.filesEditedViaEditTool`. Once a file is there, write_file soft-blocks a
 * full rewrite of it (forcing continued targeted edits) — dogfooding caught the
 * model fixing a syntax bug with edit_file, then regenerating the whole file
 * with write_file and re-introducing it. Detected by POSITIVE success markers,
 * not by the absence of "Error:": editFile prepends an "[You have not read X…]"
 * notice to a search-not-found failure, which pushes "Error:" off the front, so
 * a negative check would wrongly record a FAILED edit and deadlock the recovery
 * write_file against the enforce-edit lock.
 */
function isSuccessfulEdit(res: ToolResultContentBlock | undefined): boolean {
  if (!res || res.is_error) return false;
  const text = typeof res.content === 'string' ? res.content : '';
  return text.includes('File edited:') || text.includes('Applied inferred edit');
}

export function recordSuccessfulEdits(
  pendingToolUses: ToolUseContentBlock[],
  toolResults: ToolResultContentBlock[],
  state: LoopState,
): void {
  for (let i = 0; i < pendingToolUses.length; i++) {
    const tu = pendingToolUses[i];
    if (tu.name !== 'edit_file') continue;
    if (!isSuccessfulEdit(toolResults[i])) continue;
    const input = tu.input as Record<string, unknown>;
    const p = (input.path ?? input.file_path) as string | undefined;
    if (p) state.filesEditedViaEditTool.add(p);
  }
}

/** True if any entry of `set` shares `filePath`'s basename. */
/**
 * Path-suffix match: exact, or one path is a `/`-boundary suffix of the other
 * (handles the model using a relative path one place and an absolute/longer path
 * another). Crucially NOT a bare-basename match — `src/util.py` and
 * `test/util.py` do NOT match, so two same-named files in different dirs don't
 * share locks/budgets or release each other.
 */
function pathsMatch(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.endsWith('/' + y) || y.endsWith('/' + x);
}

function setHasByBasename(set: Set<string>, filePath: string): boolean {
  for (const k of set) {
    if (pathsMatch(k, filePath)) return true;
  }
  return false;
}

/**
 * True if the loop should DEFER a cycle bail this turn because a pending
 * write_file will be soft-blocked by the executor — either verify-before-rewrite
 * (rewritten MAX_UNVERIFIED_REWRITES times with no verification) or enforce-edit
 * (the file is being edited, so a full rewrite is rejected). Cycle detection runs
 * before dispatch, so without this a model that loops on a blocked rewrite dies
 * before the block + escalation ever reach it — it never gets the feedback that
 * could break the loop. Deferring lets dispatch run so the block fires; bounded
 * per file by MAX_FORCE_VERIFY_BEFORE_BAIL so a model that ignores it still bails.
 */
export function shouldDeferBailForBlockedWrite(
  pendingToolUses: ToolUseContentBlock[],
  state: LoopState,
  callbacks: AgentCallbacks,
): boolean {
  for (const tu of pendingToolUses) {
    if (tu.name !== 'write_file') continue;
    const input = tu.input as Record<string, unknown>;
    const filePath = (input.path ?? input.file_path) as string | undefined;
    if (!filePath) continue;
    const verifyBlocked = (state.writesSinceVerifyByFile.get(filePath) ?? 0) >= MAX_UNVERIFIED_REWRITES;
    const enforceBlocked = setHasByBasename(state.filesEditedViaEditTool, filePath);
    if (!verifyBlocked && !enforceBlocked) continue; // executor won't block this write
    const deferred = state.forceVerifyBeforeBailByFile.get(filePath) ?? 0;
    if (deferred >= MAX_FORCE_VERIFY_BEFORE_BAIL) continue; // budget spent → let it bail
    state.forceVerifyBeforeBailByFile.set(filePath, deferred + 1);
    const why = enforceBlocked ? 'rewriting an edited file (use edit_file)' : 'rewriting without verifying';
    state.logger?.warn(`Deferring cycle bail: ${filePath} — ${why} (${deferred + 1}/${MAX_FORCE_VERIFY_BEFORE_BAIL})`);
    callbacks.onText(`\n🔬 ${filePath.split('/').pop()}: ${why} — the run continues so you can correct course.\n`);
    return true;
  }
  return false;
}

/** Markers that a verification result represents a FAILURE worth surfacing. */
const FAILURE_MARKER_RE =
  /Traceback \(most recent call last\)|\bFAILED\b|\b\d+ failed\b|AssertionError|\bError:|\[Error\]|Exception:|\wError\b|cannot use|SyntaxError|NameError|TypeError/;

/** Strip ANSI escape codes and the <tool_output> wrapper, then truncate. */
function cleanOutput(text: string, max = 1200): string {
  const stripped = text.replace(/\x1b\[[0-9;]*m|\x1b\]633;[^\x07]*\x07/g, '').replace(/<\/?tool_output[^>]*>/g, '');
  const trimmed = stripped.trim();
  return trimmed.length > max ? trimmed.slice(0, max) + '\n… (truncated)' : trimmed;
}

/**
 * Capture the most recent FAILING verification output (test failure, traceback,
 * diagnostics error) so it can be surfaced inline when the model later loops on a
 * blocked rewrite — it shows the model WHAT to fix instead of letting it
 * regenerate the file blindly. Scans run_tests / run_command / get_diagnostics
 * results this turn; overwrites with the latest failing one.
 */
export function captureLastFailureOutput(
  pendingToolUses: ToolUseContentBlock[],
  toolResults: ToolResultContentBlock[],
  state: LoopState,
): void {
  for (let i = 0; i < pendingToolUses.length; i++) {
    const tu = pendingToolUses[i];
    if (tu.name !== 'run_tests' && tu.name !== 'run_command' && tu.name !== 'get_diagnostics') continue;
    const res = toolResults[i];
    if (!res) continue;
    const text = typeof res.content === 'string' ? res.content : '';
    if (!text || !FAILURE_MARKER_RE.test(text)) continue;
    state.lastFailureOutput = cleanOutput(text);
  }
}

/**
 * When a write_file this turn was blocked by enforce-edit ("was NOT applied"),
 * inject ONE escalation reprompt per file: a strong push to STOP calling
 * write_file and make a targeted edit, with the most recent failing test /
 * runtime output surfaced inline so the model can see what to fix. Returns true
 * if a reprompt was injected. Bounded to once per file via escalatedRewriteByFile.
 */
export function maybeEscalateBlockedRewrite(
  pendingToolUses: ToolUseContentBlock[],
  toolResults: ToolResultContentBlock[],
  state: LoopState,
  callbacks: AgentCallbacks,
): boolean {
  for (let i = 0; i < pendingToolUses.length; i++) {
    const tu = pendingToolUses[i];
    if (tu.name !== 'write_file') continue;
    const res = toolResults[i];
    const text = typeof res?.content === 'string' ? res.content : '';
    if (!text.includes('was NOT applied')) continue; // not an enforce-edit block
    const input = tu.input as Record<string, unknown>;
    const filePath = (input.path ?? input.file_path) as string | undefined;
    if (!filePath || state.escalatedRewriteByFile.has(filePath)) continue;
    state.escalatedRewriteByFile.add(filePath);
    const failure = state.lastFailureOutput
      ? `\n\nYour most recent test/diagnostic output (fix what this points to):\n\`\`\`\n${state.lastFailureOutput}\n\`\`\`\n`
      : '';
    callbacks.onText(`\n🛑 Stop rewriting ${filePath.split('/').pop()} — make a targeted edit instead.\n`);
    state.messages.push({
      role: 'user',
      content: [
        {
          type: 'text' as const,
          text:
            `STOP calling write_file on \`${filePath}\` — every full rewrite is being rejected because it would ` +
            `clobber the targeted fixes you already made. Regenerating the whole file keeps re-introducing the same ` +
            `bug.${failure}\nFind the EXACT lines at fault and change only those with edit_file: put the current ` +
            `lines (copy them verbatim from the file) in \`search\` and the corrected lines in \`replace\`. Make one ` +
            `small edit, then run the test again. Do not call write_file on this file again.`,
        },
      ],
    });
    return true;
  }
  return false;
}

/**
 * The mirror of maybeEscalateBlockedRewrite. That one fires when write_file is
 * repeatedly BLOCKED and pushes the model toward edit_file; this one fires when
 * edit_file repeatedly FAILS and pushes the model toward write_file.
 *
 * The failure it targets (measured on gemma4's calculator build): a weak model
 * asked to ADD code to an existing file echoes the file's existing functions into
 * edit_file's insert fields instead of producing the new code — every call varies
 * (both insert fields → missing search → repeated anchor) so the verbatim tracker
 * never fires, and it thrashes to the iteration cap having written nothing. The
 * same model authors the whole file correctly via write_file (probe: 3/3). So
 * after N failed edit_file calls on a path, redirect it to rewrite the file whole.
 *
 * Counts ANY edit_file error per path (signature-agnostic — that's the point) and
 * resets a path's count on a successful edit. Bounded to once per file via
 * escalatedEditToWriteByFile. Returns true if a steer was injected.
 */
export function maybeSteerEditToWrite(
  pendingToolUses: ToolUseContentBlock[],
  toolResults: ToolResultContentBlock[],
  state: LoopState,
  callbacks: AgentCallbacks,
): boolean {
  if (state.config.editToWriteSteerEnabled !== true) return false; // opt-in: unproven benefit, ships default-off
  const threshold = Math.max(state.config.editToWriteSteerThreshold ?? 3, 2);

  for (let i = 0; i < pendingToolUses.length; i++) {
    const tu = pendingToolUses[i];
    if (tu.name !== 'edit_file') continue;
    const input = tu.input as Record<string, unknown>;
    const filePath = (input.path ?? input.file_path) as string | undefined;
    if (!filePath) continue;

    // A success anywhere this turn resets the file's failure streak and clears
    // any prior steer, so a later genuine failure is judged fresh.
    if (isSuccessfulEdit(toolResults[i])) {
      state.editFailureCountByFile.delete(filePath);
      state.escalatedEditToWriteByFile.delete(filePath);
      continue;
    }
    if (!toolResults[i]?.is_error) continue; // not an edit failure

    const count = (state.editFailureCountByFile.get(filePath) ?? 0) + 1;
    state.editFailureCountByFile.set(filePath, count);
    if (count < threshold || state.escalatedEditToWriteByFile.has(filePath)) continue;

    state.escalatedEditToWriteByFile.add(filePath);
    const base = filePath.split('/').pop();
    callbacks.onText(`\n🛑 edit_file keeps failing on ${base} — rewrite the whole file with write_file instead.\n`);
    state.messages.push({
      role: 'user',
      content: [
        {
          type: 'text' as const,
          text:
            `STOP calling edit_file on \`${filePath}\` — it has failed ${count} times in a row and repeating it will ` +
            `not work. Switch approach: call write_file(path="${filePath}", content=<the COMPLETE file>) with the ` +
            `entire file contents — the code that is already there PLUS the new code you were trying to add, as one ` +
            `whole file. If you are unsure of the current contents, call read_file(path="${filePath}") first, then ` +
            `write_file with everything. Put ALL the code in \`content\`; do not use edit_file for this file again.`,
        },
      ],
    });
    return true;
  }
  return false;
}

/** Remove every entry of a Set/Map whose key shares `filePath`'s basename. */
function purgeByBasename(
  coll: { keys(): IterableIterator<string>; delete(k: string): boolean },
  filePath: string,
): void {
  for (const k of [...coll.keys()]) {
    if (pathsMatch(k, filePath)) coll.delete(k);
  }
}

/**
 * Clear all per-file rewrite-thrash tracking for any file successfully deleted
 * this turn. A deleted file is a clean slate: the model that `delete_file`d it
 * is starting over, so the enforce-edit lock, write-history, verify counter, and
 * circular/force-verify budgets must reset — otherwise the recreate-`write_file`
 * is still blocked and the model is trapped (dogfooding: it deleted a mangled
 * test helper to rewrite it and the recreate write stayed enforce-edit-blocked).
 */
export function clearTrackingForDeletedFiles(
  pendingToolUses: ToolUseContentBlock[],
  toolResults: ToolResultContentBlock[],
  state: LoopState,
): void {
  for (let i = 0; i < pendingToolUses.length; i++) {
    const tu = pendingToolUses[i];
    if (tu.name !== 'delete_file') continue;
    const res = toolResults[i];
    if (!res || res.is_error) continue;
    const text = typeof res.content === 'string' ? res.content : '';
    if (!text.includes('File deleted:')) continue; // positive marker — see isSuccessfulEdit
    const input = tu.input as Record<string, unknown>;
    const p = (input.path ?? input.file_path) as string | undefined;
    if (!p) continue;
    purgeByBasename(state.filesEditedViaEditTool, p);
    purgeByBasename(state.writeHistoryByFile, p);
    purgeByBasename(state.writesSinceVerifyByFile, p);
    purgeByBasename(state.circularRewriteBlocksByFile, p);
    purgeByBasename(state.forceVerifyBeforeBailByFile, p);
    // Also reset the enforce-edit block counter + the one-shot escalation flag,
    // else a delete-to-restart leaves them poisoned: the recreated file's lock
    // would release after one block instead of three, and the escalation reprompt
    // would never re-fire.
    purgeByBasename(state.enforceEditBlocksByFile, p);
    purgeByBasename(state.escalatedRewriteByFile, p);
    purgeByBasename(state.editFailureCountByFile, p);
    purgeByBasename(state.escalatedEditToWriteByFile, p);
  }
}

/**
 * Release the enforce-edit lock on a file after MAX_ENFORCE_EDIT_BLOCKS blocked
 * rewrites. enforce-edit stops a write_file from clobbering targeted edits, but a
 * model whose strategy is "rewrite the whole file" — and that ignores the
 * escalation to use edit_file — gets TRAPPED: every write is blocked until cycle
 * detection bails, leaving a partial result (dogfooding: qwen3.5 made one edit,
 * then 4 blocked rewrites, then bailed with no test). Once the model has been
 * blocked + escalated this many times, releasing the lock (so the rewrite goes
 * through) beats trapping it into a bail. The circular-rewrite / verify-before-
 * rewrite guards still bound the released writes. Counts stay high, so a
 * re-armed lock (a later edit) releases again — we've learned the model won't
 * edit this file.
 */
export function maybeReleaseEnforceLock(
  pendingToolUses: ToolUseContentBlock[],
  toolResults: ToolResultContentBlock[],
  state: LoopState,
  callbacks: AgentCallbacks,
): void {
  for (let i = 0; i < pendingToolUses.length; i++) {
    const tu = pendingToolUses[i];
    if (tu.name !== 'write_file') continue;
    const text = typeof toolResults[i]?.content === 'string' ? (toolResults[i].content as string) : '';
    if (!text.includes('was NOT applied')) continue; // only enforce-edit blocks
    const input = tu.input as Record<string, unknown>;
    const filePath = (input.path ?? input.file_path) as string | undefined;
    if (!filePath) continue;
    const count = (state.enforceEditBlocksByFile.get(filePath) ?? 0) + 1;
    state.enforceEditBlocksByFile.set(filePath, count);
    if (count >= MAX_ENFORCE_EDIT_BLOCKS && setHasByBasename(state.filesEditedViaEditTool, filePath)) {
      purgeByBasename(state.filesEditedViaEditTool, filePath); // release the lock
      state.logger?.warn(
        `Releasing enforce-edit lock on ${filePath} after ${count} blocked rewrites — the model won't switch ` +
          `to edit_file; allowing a rewrite to avoid trapping it into a bail`,
      );
      callbacks.onText(
        `\n🔓 Allowing a full rewrite of ${filePath.split('/').pop()} — but KEEP the parts that already work; ` +
          `change only what's broken.\n`,
      );
    }
  }
}

/** Filename → module name (basename without extension), lowercased. */
function moduleNameOf(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  return (dot === -1 ? base : base.slice(0, dot)).toLowerCase();
}

/**
 * Reset the verify-before-rewrite counters for files this turn's tool calls
 * actually verified. `get_diagnostics` checks every edited file, so it clears
 * all counters. A `run_command` / `run_tests` whose command references a tracked
 * file's path or module name verified that file specifically. A whole-suite run
 * with no reference resets nothing — matching the behavioral gate's
 * target-coverage rule (running unrelated tests isn't verifying this file).
 *
 * Called once per turn after tool execution. The write_file executor does the
 * incrementing + soft-blocking; this is the only thing that resets, so a model
 * that verifies between rewrites is never blocked.
 */
export function resetVerifyCountersForVerifications(pendingToolUses: ToolUseContentBlock[], state: LoopState): void {
  if (state.writesSinceVerifyByFile.size === 0) return;

  for (const tu of pendingToolUses) {
    if (tu.name === 'get_diagnostics') {
      state.writesSinceVerifyByFile.clear();
      return;
    }
  }

  for (const tu of pendingToolUses) {
    if (tu.name !== 'run_command' && tu.name !== 'run_tests') continue;
    const input = tu.input as Record<string, unknown>;
    const ref = `${String(input.command ?? '')} ${String(input.file ?? '')}`.toLowerCase();
    if (!ref.trim()) continue;
    for (const file of [...state.writesSinceVerifyByFile.keys()]) {
      if (ref.includes(file.toLowerCase()) || ref.includes(moduleNameOf(file))) {
        state.writesSinceVerifyByFile.set(file, 0);
      }
    }
  }
}
