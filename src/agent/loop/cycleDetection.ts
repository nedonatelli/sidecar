import type { ToolUseContentBlock } from '../../ollama/types.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState, NormalizedEntry } from './state.js';

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
//   2. **Cycle detection** — three ring buffers:
//
//      a. *Mutation* buffer: one exact `name:JSON(input)` entry per MUTATION
//         call. Fires when the identical mutation call appears
//         MIN_IDENTICAL_MUTATION_CALLS (4) times in the window, consecutive
//         OR NOT — interleaved reads don't reset it, because they don't
//         change what the identical edit will do. This is the primary bound
//         on the read→retry recovery loop when the retry never varies.
//
//      b. *Exact* buffer: full per-iteration `name:JSON(input)` signature.
//         Fires on length-1 after MIN_IDENTICAL_CONSECUTIVE (4, fixed —
//         deliberately NOT scaled by cycleDetectionMinRepeats, see the
//         constant's doc) consecutive hits; length-2..4 as soon as two full
//         cycles appear, EXCEPT patterns containing a read of a file under
//         active mutation (the prescribed recovery shape — exempt, bounded
//         by pass a).
//
//      c. *Normalized* buffer: `name:primaryResource` — keeps the tool
//         name and the first path/command/query arg but strips secondary
//         args (edit content, line ranges, flags). Fires at
//         `sidecar.scaffolding.cycleDetectionMinRepeats` (default 10, was a
//         fixed 3 before it became configurable). This catches loops that
//         bypass exact matching by varying secondary args while hammering
//         the same file or command repeatedly — e.g.
//         `edit_file(a.ts, search1, replace1)` × N times with different
//         content each time.
//
//      The normalized buffer's lookback window scales with the configured
//      threshold (see REPEAT_WINDOW_MARGIN) so raising it can never make the
//      check mathematically unable to fire — a config value alone can't
//      silently disable the safety net.
//
// Both helpers return `true` when the loop should break. They also
// emit user-visible text via `callbacks.onText` and log via
// `state.logger` so the stop is observable in the chat + audit log.
// ---------------------------------------------------------------------------

import { MAX_TOOL_CALLS_PER_ITERATION } from '../../config/constants.js';
const MAX_CYCLE_LEN = 4;
// Default for the normalized-signature pass, user-configurable via
// `sidecar.scaffolding.cycleDetectionMinRepeats` (LoopState.config —
// weaker models sometimes need a few attempts to self-correct from an
// edit_file hint before genuinely succeeding; see editFailureSignatures in
// fs.ts). Governs VARYING-content repetition only: the consecutive-identical
// and identical-mutation thresholds are fixed (see MIN_IDENTICAL_CONSECUTIVE)
// because byte-identical resubmission can never self-correct. The normalized
// buffer's lookback window scales with this threshold (REPEAT_WINDOW_MARGIN,
// windowFor) so raising it can never make the check mathematically unable to
// fire.
const DEFAULT_MIN_NORMALIZED_REPEATS = 10;
// Slack added on top of a repeat threshold to size that pass's lookback
// window, so a few interleaved non-matching calls (e.g. a read_file the
// model made in response to a hint) don't fall out of the window before the
// repeat count is reached.
const REPEAT_WINDOW_MARGIN = 5;
// Pure runaway backstop. The content-AWARE passes (consecutive/frequency at
// the configured normalized-repeat threshold, which only fire on REPEATED
// content) catch a model genuinely stuck re-applying the same change.
// write-target is content-blind, so it must stay lenient — a model
// legitimately iterating on a fix rewrites the same file several times with
// DIFFERENT content (progress, not thrash). 6-of-8 means "almost every
// recent step mutated this one file" — real thrash — while leaving room for
// fix→verify→fix→verify loops. (Was 4, which bailed productive iteration;
// dogfooding repeatedly tripped it mid-fix.) Scales UP with the configured
// normalized-repeat threshold (never down — 6 stays the floor) so a raised
// `cycleDetectionMinRepeats` isn't silently capped by this separate,
// content-blind pass on the same-file case.
const DEFAULT_WRITE_TARGET_THRESHOLD = 6;

// Keys checked in priority order to extract a tool's primary resource.
// The first matching non-empty string value becomes the normalized key.
const PRIMARY_RESOURCE_KEYS = ['path', 'file_path', 'directory', 'command', 'query', 'pattern', 'url'] as const;

// Tools that mutate workspace files. A repeated file target across these
// tools across multiple iterations is the "same semantic action, different
// tool or wording" loop the third-pass thrash detector catches.
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

// Read-only tools: repeated calls on the same resource with any secondary-arg
// variation (e.g. different line ranges) still indicate a stuck loop. The
// secondary-hash check is skipped for these tools — sig match alone is enough.
const READ_ONLY_TOOLS = new Set(['read_file', 'grep', 'list_directory', 'search_files', 'get_diagnostics']);

/** The normalized pass's repeat threshold: user-configurable, falls back to
 *  the default when config is absent (unit tests / non-loop calls). */
function normalizedRepeatsFor(state: LoopState): number {
  return state.config?.cycleDetectionMinRepeats ?? DEFAULT_MIN_NORMALIZED_REPEATS;
}

/**
 * Consecutive byte-identical iteration signatures before bailing. FIXED at 4
 * (the original value), deliberately DECOUPLED from cycleDetectionMinRepeats.
 *
 * It used to be `minNormalizedRepeats + 1`, so when the normalized default
 * was raised 3 → 10 — to give weaker models room to retry with DIFFERENT
 * content after an edit_file hint — this threshold silently rode along,
 * 4 → 11. That rationale does not transfer: a byte-identical resubmission
 * gets the same deterministic response every time and can never self-correct,
 * so extra tolerance only buys wasted iterations (v0.122 gemma4 resubmitted
 * one failing edit 5 times and no identical-repeat check ever fired). Two
 * legitimate re-runs (verify twice, re-run tests) stay comfortably under 4.
 */
const MIN_IDENTICAL_CONSECUTIVE = 4;

/**
 * Identical MUTATION calls (same tool, byte-identical input) within the recent
 * window before bailing — consecutive or not. The consecutive check above is
 * defeated by the interleaved read_file the edit_file error messages
 * themselves prescribe ("read the file, then retry"): gemma4 sent the same
 * failing edit at positions 10, 14, 15, 17, 18 of a run and the longest
 * consecutive streak was 2. Reads between attempts don't make the resubmission
 * productive — the edit's response is deterministic — so identical mutation
 * calls are counted across interleaves. 4 gives edit_file's own escalation
 * ladder (looser fuzzy suggestion on the 3rd consecutive failure, fs.ts) one
 * full attempt to convert the model before the run is declared stuck.
 */
const MIN_IDENTICAL_MUTATION_CALLS = 4;

/** Lookback window for a ring buffer checked against `threshold` repeats.
 *  Always at least `threshold + REPEAT_WINDOW_MARGIN` so raising the
 *  configured threshold can never make a check mathematically unable to
 *  fire (you can't observe N occurrences in a window smaller than N). */
function windowFor(threshold: number): number {
  return threshold + REPEAT_WINDOW_MARGIN;
}

/** The write-target pass's threshold scales UP with the configured
 *  normalized-repeat threshold (never down) — otherwise raising
 *  `cycleDetectionMinRepeats` to give a model more attempts would be
 *  silently capped by this separate, content-blind, same-file pass. */
function writeTargetThresholdFor(minNormalizedRepeats: number): number {
  return Math.max(DEFAULT_WRITE_TARGET_THRESHOLD, minNormalizedRepeats);
}

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
  const burstCap = state.scaffoldingProfile?.burstCap ?? MAX_TOOL_CALLS_PER_ITERATION;
  if (pendingToolUses.length <= burstCap) return false;

  state.logger?.warn(
    `Agent loop tool-call burst cap exceeded: ${pendingToolUses.length} tool calls in one iteration ` +
      `(max ${burstCap}). First call: ${pendingToolUses[0].name}`,
  );
  callbacks.onText(
    `\n\n⚠️ Agent stopped: ${pendingToolUses.length} tool calls in a single turn exceeds the ` +
      `${burstCap}-call burst cap. Ask again with a narrower scope.\n`,
  );
  return true;
}

/**
 * Record this iteration's tool-call signature into both ring buffers
 * and check for repeat patterns. Returns `true` when a cycle was
 * detected and the loop should terminate.
 *
 * Two passes run in order:
 *   1. Exact signatures (`name:JSON(input)` joined with `|`) — fires at
 *      `cycleDetectionMinRepeats + 1` for length-1, immediately for
 *      length-2..MAX_CYCLE_LEN.
 *   2. Normalized signatures (`name:primaryResource`) — fires at
 *      `state.config.cycleDetectionMinRepeats` (default 10) for length-1 and
 *      length-2..MAX_CYCLE_LEN. Catches "same file, different edit content"
 *      loops missed by pass 1.
 */
export function detectCycleAndBail(
  pendingToolUses: ToolUseContentBlock[],
  state: LoopState,
  callbacks: AgentCallbacks,
): boolean {
  const minNormalizedRepeats = normalizedRepeatsFor(state);

  // Record this iteration into every buffer FIRST, in lockstep — the exact
  // pattern pass consults the aligned normalized entries for its
  // recovery-shape exemption, so both must already contain this iteration.
  const callSignature = pendingToolUses.map((tu) => `${tu.name}:${sortedStringify(tu.input)}`).join('|');
  state.recentToolCalls.push(callSignature);
  // Window must fit both the consecutive-identical check and a full doubled
  // length-4 pattern (2 × MAX_CYCLE_LEN entries).
  const identicalWindow = Math.max(windowFor(MIN_IDENTICAL_CONSECUTIVE), MAX_CYCLE_LEN * 2);
  if (state.recentToolCalls.length > identicalWindow) {
    state.recentToolCalls.shift();
  }

  const normalizedWindow = windowFor(minNormalizedRepeats);
  const normEntry = normalizeEntry(pendingToolUses);
  state.recentNormalizedCalls.push(normEntry);
  if (state.recentNormalizedCalls.length > normalizedWindow) {
    state.recentNormalizedCalls.shift();
  }

  const mutationSigs = pendingToolUses
    .filter((tu) => MUTATION_TOOLS.has(tu.name))
    .map((tu) => `${tu.name}:${sortedStringify(tu.input)}`);
  const mutationWindow = windowFor(MIN_IDENTICAL_MUTATION_CALLS);
  for (const sig of mutationSigs) {
    state.recentMutationCalls.push(sig);
    if (state.recentMutationCalls.length > mutationWindow) {
      state.recentMutationCalls.shift();
    }
  }

  // --- Identical-mutation resubmission pass (consecutive or not) ---
  // The same mutation call, byte-identical, MIN_IDENTICAL_MUTATION_CALLS times
  // within the window — interleaved reads don't reset it, because they don't
  // change what the identical edit will do.
  for (const sig of new Set(mutationSigs)) {
    const count = state.recentMutationCalls.filter((v) => v === sig).length;
    if (count >= MIN_IDENTICAL_MUTATION_CALLS) {
      state.logger?.warn(
        `Agent loop identical-mutation resubmission detected (${count} identical calls, interleaves ignored) — ${sig.slice(0, 100)}`,
      );
      callbacks.onText(`\n\n⚠️ Agent stopped: the exact same ${sig.slice(0, 80)} call was submitted ${count} times.\n`);
      return true;
    }
  }

  // --- Exact signature pass ---
  if (state.recentToolCalls.length >= MIN_IDENTICAL_CONSECUTIVE) {
    const lastN = state.recentToolCalls.slice(-MIN_IDENTICAL_CONSECUTIVE);
    if (lastN.every((v) => v === lastN[0])) {
      state.logger?.warn(
        `Agent loop cycle detected (${MIN_IDENTICAL_CONSECUTIVE} identical calls) — ${callSignature.slice(0, 100)}`,
      );
      callbacks.onText(
        `\n\n⚠️ Agent stopped: ${callSignature.slice(0, 80)} repeated ${MIN_IDENTICAL_CONSECUTIVE} times in a row.\n`,
      );
      return true;
    }
  }

  for (let len = 2; len <= MAX_CYCLE_LEN && len * 2 <= state.recentToolCalls.length; len++) {
    const tail = state.recentToolCalls.slice(-len);
    const prev = state.recentToolCalls.slice(-2 * len, -len);
    if (tail.length === prev.length && tail.every((v, i) => v === prev[i])) {
      // Recovery-shape exemption: a pattern that includes READING a file the
      // model is actively trying to mutate is the read→retry loop the edit
      // errors themselves prescribe ("call read_file, then use the exact
      // text"), possibly with progressively different understanding each
      // round — that's work, not thrash. Bailing here at 2 cycles also
      // preempted edit_file's 3rd-failure escalation tier, the mechanism
      // built to convert exactly this situation. A truly stuck recovery loop
      // still bails via the identical-mutation pass above (its edit must
      // repeat byte-identically for the pattern to match at all).
      const normTail = state.recentNormalizedCalls.slice(-len);
      if (normTail.some((e) => entryHasReadOfActiveMutationTarget(e, state))) continue;
      state.logger?.warn(`Agent loop cycle detected (length ${len}) — ${callSignature.slice(0, 100)}`);
      callbacks.onText(`\n\n⚠️ Agent stopped: detected repeating tool call pattern of length ${len}.\n`);
      return true;
    }
  }

  // --- Normalized signature pass ---

  if (state.recentNormalizedCalls.length >= minNormalizedRepeats) {
    const lastN = state.recentNormalizedCalls.slice(-minNormalizedRepeats);
    if (lastN.every((e) => e.sig === lastN[0].sig)) {
      // For read-only tools (read_file, grep, etc.) skip the secondary-hash
      // check. Reading the same file with slightly different line ranges is
      // always a stuck loop — the agent is scanning without making progress.
      // The secondary-hash check is only needed for write tools where the
      // agent might legitimately edit the same file with different content.
      const toolName = normEntry.sig.split(':')[0] ?? '';
      const isReadOnly = READ_ONLY_TOOLS.has(toolName);
      // Re-reading a file you're actively editing is an edit→verify loop, never a
      // stuck scan — exempt it entirely (even identical read args, since the file
      // content changed underneath between reads).
      const editVerifyExempt = isReadOnly && sigTargetsRecentlyMutatedFile(lastN[0].sig, state);

      const hasRepeatedSecondary = lastN.every((e) => e.secondaryHash === lastN[0].secondaryHash);
      if (!editVerifyExempt && (isReadOnly || hasRepeatedSecondary) && !sigTargetsOnlyGateFiles(lastN[0].sig, state)) {
        state.logger?.warn(
          `Agent loop normalized cycle detected (${minNormalizedRepeats} repeats${isReadOnly ? ', read-only tool' : ', repeated secondary args'}) — ${normEntry.sig.slice(0, 100)}`,
        );
        callbacks.onText(
          `\n\n⚠️ Agent stopped: ${normEntry.sig.slice(0, 80)} repeated ` +
            `${minNormalizedRepeats} times — try a different approach.\n`,
        );
        return true;
      }
    }

    // Frequency-over-window check: catch the same sig appearing
    // minNormalizedRepeats times anywhere in the normalized window, even
    // non-consecutively. The consecutive check above misses patterns like
    // read_file(bad) → list_dir → read_file(bad) → list_dir → read_file(bad)
    // where other calls break the trailing-N streak. The same
    // hasRepeatedSecondary guard applies so agents editing the same file
    // with genuinely different content are not falsely stopped.
    const sigGroups = new Map<string, NormalizedEntry[]>();
    for (const e of state.recentNormalizedCalls) {
      const arr = sigGroups.get(e.sig) ?? [];
      arr.push(e);
      sigGroups.set(e.sig, arr);
    }
    for (const [sig, entries] of sigGroups) {
      if (entries.length < minNormalizedRepeats) continue;
      const sigToolName = sig.split(':')[0] ?? '';
      const sigIsReadOnly = READ_ONLY_TOOLS.has(sigToolName);
      const editVerifyExempt = sigIsReadOnly && sigTargetsRecentlyMutatedFile(sig, state);
      const seen = new Set<string>();
      const hasRepeatedSecondary = entries.some((e) => {
        if (seen.has(e.secondaryHash)) return true;
        seen.add(e.secondaryHash);
        return false;
      });
      if (!editVerifyExempt && (sigIsReadOnly || hasRepeatedSecondary) && !sigTargetsOnlyGateFiles(sig, state)) {
        state.logger?.warn(
          `Agent loop normalized cycle detected (${entries.length} non-consecutive repeats in window) — ${sig.slice(0, 100)}`,
        );
        callbacks.onText(
          `\n\n⚠️ Agent stopped: ${sig.slice(0, 80)} repeated ` +
            `${entries.length} times — try a different approach.\n`,
        );
        return true;
      }
    }
  }

  for (let len = 2; len <= MAX_CYCLE_LEN && len * 2 <= state.recentNormalizedCalls.length; len++) {
    const tail = state.recentNormalizedCalls.slice(-len);
    const prev = state.recentNormalizedCalls.slice(-2 * len, -len);
    if (tail.length !== prev.length) continue;
    const sigsMatch = tail.every((v, i) => v.sig === prev[i].sig);
    if (!sigsMatch) continue;
    // Content-aware: an A→B→A→B pattern is only a STUCK loop when the cycle
    // repeats with the SAME content (or is all read-only scanning). A model
    // legitimately iterating — edit→verify→edit→verify with DIFFERENT edits each
    // round — produces the same sig pattern but different content, and is making
    // progress, not looping. Mirror the consecutive/frequency passes, which
    // already gate on secondaryHash. (Dogfooding: an edit→diagnostics fix loop
    // with distinct edits tripped this content-blind check.)
    const contentRepeats = tail.every((v, i) => v.secondaryHash === prev[i].secondaryHash);
    const allReadOnly = tail.every((e) => READ_ONLY_TOOLS.has(e.sig.split(':')[0] ?? ''));
    const gateExempt = tail.every((e) => sigTargetsOnlyGateFiles(e.sig, state));
    // Exempt any pattern containing a READ of a file under active mutation —
    // whether an all-read verify loop between writes, or the read→retry
    // recovery shape the edit errors themselves prescribe. A truly stuck
    // recovery loop still bails via the identical-mutation pass (its edit
    // repeats byte-identically whenever the pattern's content repeats).
    const editVerifyExempt = tail.some((e) => entryHasReadOfActiveMutationTarget(e, state));
    if ((contentRepeats || allReadOnly) && !gateExempt && !editVerifyExempt) {
      state.logger?.warn(`Agent loop normalized cycle detected (length ${len}) — ${normEntry.sig.slice(0, 100)}`);
      const patternSigs = tail.map((e) => e.sig.slice(0, 40)).join(' → ');
      callbacks.onText(
        `\n\n⚠️ Agent stopped: detected repeating pattern of length ${len} — [${patternSigs}]. Try a different approach.\n`,
      );
      return true;
    }
  }

  // --- Third pass: write-target frequency ---
  // Catches "same file, different approach" loops where the agent alternates
  // tools (write_file → edit_file → run_command sed …) on the same target,
  // bypassing both exact and normalized signature checks.
  const writeTargetThreshold = writeTargetThresholdFor(minNormalizedRepeats);
  const writeTargetWindow = windowFor(writeTargetThreshold);
  const iterationTargets = extractWriteTargets(pendingToolUses);
  state.recentWriteTargets.push(iterationTargets);
  if (state.recentWriteTargets.length > writeTargetWindow) {
    state.recentWriteTargets.shift();
  }

  if (state.recentWriteTargets.length >= writeTargetThreshold) {
    const fileCounts = new Map<string, number>();
    for (const targets of state.recentWriteTargets) {
      for (const f of targets) {
        fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
      }
    }
    for (const [file, count] of fileCounts) {
      // A file under active harness-driven fixing (syntax gate or auto-fix) is
      // exempt: repeated edits to fix a flagged error are progress, not thrash,
      // and the driving mechanism's own budget bounds that loop. The exact-match
      // pass still catches a truly-stuck identical-edit loop.
      if (isUnderActiveFix(file, state)) continue;
      if (count >= writeTargetThreshold) {
        state.logger?.warn(
          `Agent loop write-target thrash detected: ${file} targeted in ${count}/${state.recentWriteTargets.length} iterations`,
        );
        callbacks.onText(
          `\n\n⚠️ Agent stopped: \`${file.slice(0, 80)}\` has been the write target in ${count} of the last ` +
            `${state.recentWriteTargets.length} iterations — try a different approach.\n`,
        );
        return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return the file paths targeted by mutation tools in this iteration.
 * Deduped per iteration so a single `edit_file` + `write_file` on the same
 * path counts as one hit, not two.
 */
function extractWriteTargets(pendingToolUses: ToolUseContentBlock[]): string[] {
  const seen = new Set<string>();
  for (const tu of pendingToolUses) {
    if (!MUTATION_TOOLS.has(tu.name)) continue;
    const input = tu.input as Record<string, unknown>;
    for (const key of PRIMARY_RESOURCE_KEYS) {
      const v = input[key];
      if (typeof v === 'string' && v) {
        seen.add(v);
        break;
      }
    }
  }
  return Array.from(seen);
}

/**
 * True if `target` (a raw write-target path from a tool input) refers to a
 * file the syntax gate is currently driving fixes on. Matches by basename so
 * the gate's normalized workspace-relative path ("src/gui.py") matches a raw
 * relative input ("gui.py") and vice-versa.
 */
function basenameMatch(target: string, candidate: string): boolean {
  if (candidate.toLowerCase() === target.toLowerCase()) return true;
  return candidate.split('/').pop()!.toLowerCase() === target.split('/').pop()!.toLowerCase();
}

function isSyntaxGateFixTarget(target: string, state: LoopState): boolean {
  const fixTargets = state.gateState.syntaxGateFixTargets;
  if (!fixTargets || fixTargets.size === 0) return false;
  for (const gated of fixTargets) if (basenameMatch(target, gated)) return true;
  return false;
}

/**
 * True if `target` is a file the auto-fix hook is actively driving fixes on —
 * it has reprompted at least once (retries > 0) and hasn't exhausted its
 * per-file budget yet (retries < autoFixMaxRetries). Auto-fix bounds its own
 * loop, so cycle detection must not bail it earlier: dogfooding showed auto-fix
 * (budget 5) reprompting `gui.py` while the normalized cycle check bailed at 3
 * repeats. Once auto-fix gives up (retries >= cap), the exemption ends and
 * further repetition is thrash again.
 */
function isActiveAutoFixTarget(target: string, state: LoopState): boolean {
  const map = state.autoFixRetriesByFile;
  if (!map || map.size === 0) return false;
  const cap = state.config?.autoFixMaxRetries ?? 3;
  for (const [file, retries] of map) {
    if (retries > 0 && retries < cap && basenameMatch(target, file)) return true;
  }
  return false;
}

/** A file is exempt from the thrash/cycle passes while a harness mechanism (the
 * syntax gate or auto-fix) is actively driving bounded fixes on it. */
function isUnderActiveFix(target: string, state: LoopState): boolean {
  return isSyntaxGateFixTarget(target, state) || isActiveAutoFixTarget(target, state);
}

/**
 * True if every tool call in a normalized signature references only files under
 * active harness-driven fixing (syntax gate or auto-fix). Such a signature is
 * supervised fixing (e.g. `edit_file:gui.py` → `get_diagnostics:gui.py` repeated
 * while fixing a flagged error), NOT thrash — the normalized cycle passes exempt
 * it. The driving mechanism's own budget (and the exact-match pass, which still
 * fires on truly identical repeated calls) bound the loop.
 */
function sigTargetsOnlyGateFiles(sig: string, state: LoopState): boolean {
  const parts = sig.split('|');
  if (parts.length === 0) return false;
  return parts.every((p) => {
    const idx = p.indexOf(':');
    const resource = idx === -1 ? '' : p.slice(idx + 1);
    return resource !== '' && isUnderActiveFix(resource, state);
  });
}

/**
 * True when a normalized entry contains a READ-ONLY call targeting a file that
 * recent iterations have been trying to mutate. This is the recovery shape:
 * the edit_file error messages instruct "call read_file to get the exact
 * text, then retry", so a read of the file under active mutation inside a
 * repeating pattern means the model is following the prescribed path (perhaps
 * reading a larger slice each round), not spinning. Patterns containing it are
 * exempt from the 2-cycle pattern bails; the identical-mutation pass bounds
 * the truly-stuck variant. `recentWriteTargets` records ATTEMPTED mutation
 * calls (executed or guard-blocked), which is what "actively trying" means.
 */
function entryHasReadOfActiveMutationTarget(entry: NormalizedEntry, state: LoopState): boolean {
  for (const part of entry.sig.split('|')) {
    const i = part.indexOf(':');
    if (i === -1) continue;
    const tool = part.slice(0, i);
    const resource = part.slice(i + 1);
    if (!READ_ONLY_TOOLS.has(tool) || !resource) continue;
    for (const targets of state.recentWriteTargets) {
      for (const t of targets) {
        if (basenameMatch(resource, t)) return true;
      }
    }
  }
  return false;
}

/**
 * True if a read-only signature targets a file that was mutated (write/edit)
 * within the recent window. Re-reading a file you're actively editing is an
 * edit→verify loop, NOT a stuck scan — especially under retrieval reference-mode
 * (v0.92), where the system prompt holds path references, not file bodies, so
 * the model MUST read_file to see the current contents after each edit.
 * Dogfooding: a write→read→write→read fix loop on `gui_calculator.py` tripped
 * the read-only cycle bail mid-fix, killing the run with a half-written file.
 * Bounded by the write-target pass's lookback window — once edits age out,
 * pure re-reads bail again.
 */
function sigTargetsRecentlyMutatedFile(sig: string, state: LoopState): boolean {
  const resources = sig
    .split('|')
    .map((p) => {
      const i = p.indexOf(':');
      return i === -1 ? '' : p.slice(i + 1);
    })
    .filter(Boolean);
  if (resources.length === 0) return false;
  for (const targets of state.recentWriteTargets) {
    for (const t of targets) {
      for (const r of resources) {
        if (basenameMatch(r, t)) return true;
      }
    }
  }
  return false;
}

function sortedStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(sortedStringify).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + sortedStringify((value as Record<string, unknown>)[k])).join(',') +
    '}'
  );
}

/**
 * Build a NormalizedEntry for this iteration's tool calls.
 *
 * `sig`          — `tool:primaryResource` joined across all tool uses.
 * `secondaryHash`— sorted-stringify of every arg *except* the primary
 *                  resource key, joined across all tool uses. Two calls
 *                  with the same primary resource but different content,
 *                  flags, or line ranges will have different secondaryHash
 *                  values, so the streak check can distinguish "trying
 *                  different things" from "truly stuck".
 */
function normalizeEntry(pendingToolUses: ToolUseContentBlock[]): NormalizedEntry {
  const sigParts: string[] = [];
  const secondaryParts: string[] = [];

  for (const tu of pendingToolUses) {
    const input = tu.input as Record<string, unknown>;

    let primaryKey: string | undefined;
    let primaryValue: string | undefined;

    for (const key of PRIMARY_RESOURCE_KEYS) {
      const v = input[key];
      if (typeof v === 'string' && v) {
        primaryKey = key;
        primaryValue = v;
        break;
      }
    }

    if (!primaryKey) {
      // Fall back to first non-empty string value so tools without a
      // canonical resource key don't all collapse to bare tool name.
      for (const [k, v] of Object.entries(input)) {
        if (typeof v === 'string' && v) {
          primaryKey = k;
          primaryValue = v;
          break;
        }
      }
    }

    if (primaryKey && primaryValue) {
      sigParts.push(`${tu.name}:${primaryValue.slice(0, 80)}`);
      const secondary: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) {
        if (k !== primaryKey) secondary[k] = v;
      }
      secondaryParts.push(sortedStringify(secondary));
    } else {
      sigParts.push(tu.name);
      secondaryParts.push(sortedStringify(input));
    }
  }

  return { sig: sigParts.join('|'), secondaryHash: secondaryParts.join('|') };
}
