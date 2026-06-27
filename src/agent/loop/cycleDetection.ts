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
//   2. **Cycle detection** — two parallel ring buffers, each checked
//      for length-1..MAX_CYCLE_LEN patterns:
//
//      a. *Exact* buffer: full `name:JSON(input)` signature. Fires on
//         length-1 after MIN_IDENTICAL_REPEATS (4) consecutive hits,
//         length-2..4 as soon as two full cycles appear. Higher
//         threshold for length-1 because agents legitimately re-run
//         a tool (verify after edit, retry tests, refine inputs).
//
//      b. *Normalized* buffer: `name:primaryResource` — keeps the tool
//         name and the first path/command/query arg but strips secondary
//         args (edit content, line ranges, flags). Fires at
//         MIN_NORMALIZED_REPEATS (3). This catches loops that bypass
//         exact matching by varying secondary args while hammering the
//         same file or command repeatedly — e.g.
//         `edit_file(a.ts, search1, replace1)` × 3 times with different
//         content each time.
//
// Both helpers return `true` when the loop should break. They also
// emit user-visible text via `callbacks.onText` and log via
// `state.logger` so the stop is observable in the chat + audit log.
// ---------------------------------------------------------------------------

const MAX_TOOL_CALLS_PER_ITERATION = 12;
const CYCLE_WINDOW = 8;
const MAX_CYCLE_LEN = 4;
const MIN_IDENTICAL_REPEATS = 4;
const MIN_NORMALIZED_REPEATS = 3;
const WRITE_TARGET_WINDOW = 8;
// Pure runaway backstop. The content-AWARE passes (consecutive/frequency at
// MIN_NORMALIZED_REPEATS, which only fire on REPEATED content) catch a model
// genuinely stuck re-applying the same change. write-target is content-blind,
// so it must stay lenient — a model legitimately iterating on a fix rewrites
// the same file several times with DIFFERENT content (progress, not thrash).
// 6-of-8 means "almost every recent step mutated this one file" — real
// thrash — while leaving room for fix→verify→fix→verify loops. (Was 4, which
// bailed productive iteration; dogfooding repeatedly tripped it mid-fix.)
const WRITE_TARGET_THRESHOLD = 6;

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
 *   1. Exact signatures (`name:JSON(input)` joined with `|`) — fires
 *      at MIN_IDENTICAL_REPEATS (4) for length-1, immediately for
 *      length-2..MAX_CYCLE_LEN.
 *   2. Normalized signatures (`name:primaryResource`) — fires at
 *      MIN_NORMALIZED_REPEATS (3) for length-1 and length-2..MAX_CYCLE_LEN.
 *      Catches "same file, different edit content" loops missed by pass 1.
 */
export function detectCycleAndBail(
  pendingToolUses: ToolUseContentBlock[],
  state: LoopState,
  callbacks: AgentCallbacks,
): boolean {
  // --- Exact signature pass ---
  const callSignature = pendingToolUses.map((tu) => `${tu.name}:${sortedStringify(tu.input)}`).join('|');
  state.recentToolCalls.push(callSignature);
  if (state.recentToolCalls.length > CYCLE_WINDOW) {
    state.recentToolCalls.shift();
  }

  if (state.recentToolCalls.length >= MIN_IDENTICAL_REPEATS) {
    const lastN = state.recentToolCalls.slice(-MIN_IDENTICAL_REPEATS);
    if (lastN.every((v) => v === lastN[0])) {
      state.logger?.warn(
        `Agent loop cycle detected (${MIN_IDENTICAL_REPEATS} identical calls) — ${callSignature.slice(0, 100)}`,
      );
      callbacks.onText(
        `\n\n⚠️ Agent stopped: ${callSignature.slice(0, 80)} repeated ${MIN_IDENTICAL_REPEATS} times in a row.\n`,
      );
      return true;
    }
  }

  for (let len = 2; len <= MAX_CYCLE_LEN && len * 2 <= state.recentToolCalls.length; len++) {
    const tail = state.recentToolCalls.slice(-len);
    const prev = state.recentToolCalls.slice(-2 * len, -len);
    if (tail.length === prev.length && tail.every((v, i) => v === prev[i])) {
      state.logger?.warn(`Agent loop cycle detected (length ${len}) — ${callSignature.slice(0, 100)}`);
      callbacks.onText(`\n\n⚠️ Agent stopped: detected repeating tool call pattern of length ${len}.\n`);
      return true;
    }
  }

  // --- Normalized signature pass ---
  const normEntry = normalizeEntry(pendingToolUses);
  state.recentNormalizedCalls.push(normEntry);
  if (state.recentNormalizedCalls.length > CYCLE_WINDOW) {
    state.recentNormalizedCalls.shift();
  }

  if (state.recentNormalizedCalls.length >= MIN_NORMALIZED_REPEATS) {
    const lastN = state.recentNormalizedCalls.slice(-MIN_NORMALIZED_REPEATS);
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
          `Agent loop normalized cycle detected (${MIN_NORMALIZED_REPEATS} repeats${isReadOnly ? ', read-only tool' : ', repeated secondary args'}) — ${normEntry.sig.slice(0, 100)}`,
        );
        callbacks.onText(
          `\n\n⚠️ Agent stopped: ${normEntry.sig.slice(0, 80)} repeated ` +
            `${MIN_NORMALIZED_REPEATS} times — try a different approach.\n`,
        );
        return true;
      }
    }

    // Frequency-over-window check: catch the same sig appearing
    // MIN_NORMALIZED_REPEATS times anywhere in the CYCLE_WINDOW, even
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
      if (entries.length < MIN_NORMALIZED_REPEATS) continue;
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
    // Exempt an all-read pattern when any read targets a file being actively
    // edited — it's verifying edits between writes, not scanning in circles.
    const editVerifyExempt = allReadOnly && tail.some((e) => sigTargetsRecentlyMutatedFile(e.sig, state));
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
  const iterationTargets = extractWriteTargets(pendingToolUses);
  state.recentWriteTargets.push(iterationTargets);
  if (state.recentWriteTargets.length > WRITE_TARGET_WINDOW) {
    state.recentWriteTargets.shift();
  }

  if (state.recentWriteTargets.length >= WRITE_TARGET_THRESHOLD) {
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
      if (count >= WRITE_TARGET_THRESHOLD) {
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
 * True if a read-only signature targets a file that was mutated (write/edit)
 * within the recent window. Re-reading a file you're actively editing is an
 * edit→verify loop, NOT a stuck scan — especially under retrieval reference-mode
 * (v0.92), where the system prompt holds path references, not file bodies, so
 * the model MUST read_file to see the current contents after each edit.
 * Dogfooding: a write→read→write→read fix loop on `gui_calculator.py` tripped
 * the read-only cycle bail mid-fix, killing the run with a half-written file.
 * Bounded by WRITE_TARGET_WINDOW — once edits age out, pure re-reads bail again.
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
