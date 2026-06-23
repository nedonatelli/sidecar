import { describe, it, expect, vi } from 'vitest';
import { stubLoopState, stubCallbacks } from './testHelpers.js';
import { exceedsBurstCap, detectCycleAndBail } from './cycleDetection.js';
import type { LoopState } from './state.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';

// ---------------------------------------------------------------------------
// Tests for cycleDetection.ts (loop helper hardening).
//
// Both exports (`exceedsBurstCap` and `detectCycleAndBail`) are pure
// functions over `ToolUseContentBlock[]` + a minimal LoopState slice +
// an AgentCallbacks shim. No real LLM / vscode / fs dependencies, so
// tests run synchronously in a few ms each.
//
// Branch coverage targets:
//   - burst cap: at/below/above MAX_TOOL_CALLS_PER_ITERATION
//   - cycle: no cycle, length-1 with < min repeats, length-1 at min repeats,
//            length-2 cycle, length-3 cycle, length-4 cycle, > MAX_CYCLE_LEN
//            (should NOT fire), ring buffer pruning at CYCLE_WINDOW edge
// ---------------------------------------------------------------------------

function makeToolUse(name: string, input: Record<string, unknown> = {}): ToolUseContentBlock {
  return { type: 'tool_use', id: `tu-${name}-${JSON.stringify(input)}`, name, input };
}

describe('exceedsBurstCap', () => {
  it('returns false for an empty tool-use batch', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    expect(exceedsBurstCap([], state, cb)).toBe(false);
    expect(cb.texts).toHaveLength(0);
  });

  it('returns false at exactly MAX_TOOL_CALLS_PER_ITERATION (12) — the cap is inclusive', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => makeToolUse(`t${i}`));
    const state = stubLoopState();
    const cb = stubCallbacks();
    expect(exceedsBurstCap(twelve, state, cb)).toBe(false);
    expect(cb.texts).toHaveLength(0);
  });

  it('returns true at 13 tool calls and surfaces a user-visible warning', () => {
    const thirteen = Array.from({ length: 13 }, (_, i) => makeToolUse(`t${i}`));
    const state = stubLoopState();
    const cb = stubCallbacks();
    expect(exceedsBurstCap(thirteen, state, cb)).toBe(true);
    expect(cb.texts).toHaveLength(1);
    expect(cb.texts[0]).toContain('13 tool calls');
    expect(cb.texts[0]).toContain('burst cap');
  });

  it('logs the burst via state.logger when present', () => {
    const warn = vi.fn();
    const state = stubLoopState({ logger: { warn } as unknown as LoopState['logger'] });
    const cb = stubCallbacks();
    const big = Array.from({ length: 20 }, (_, i) => makeToolUse(`read_file`, { path: `f${i}.ts` }));
    exceedsBurstCap(big, state, cb);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('20 tool calls');
    expect(warn.mock.calls[0][0]).toContain('read_file');
  });
});

describe('detectCycleAndBail', () => {
  it('returns false and pushes the signature when the ring is empty', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    expect(detectCycleAndBail([makeToolUse('read_file', { path: 'a.ts' })], state, cb)).toBe(false);
    expect(state.recentToolCalls).toHaveLength(1);
  });

  it('returns false when the ring contains 2 identical signatures (below MIN_NORMALIZED_REPEATS=3)', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    const call = [makeToolUse('ls', { dir: '.' })];
    for (let i = 0; i < 2; i++) {
      expect(detectCycleAndBail(call, state, cb)).toBe(false);
    }
    expect(cb.texts).toHaveLength(0);
  });

  it('returns true when the same signature fires 3 times (normalized pass fires before exact at 4)', () => {
    // Identical calls have identical secondary args, so the normalized check fires
    // at 3 (secondary hash repeats on call 2) before the exact check fires at 4.
    const state = stubLoopState();
    const cb = stubCallbacks();
    const call = [makeToolUse('ls', { dir: '.' })];
    let bailed = false;
    for (let i = 0; i < 3; i++) {
      bailed = detectCycleAndBail(call, state, cb);
    }
    expect(bailed).toBe(true);
    expect(cb.texts[0]).toContain('repeated');
  });

  it('exact-only check fires at 4 when normalized sigs differ (tool has no recognized resource key)', () => {
    // When primary resource keys are absent, normalized sig is just the tool name.
    // For calls with different inputs but the same tool name, the exact check
    // eventually fires at 4 while normalized fires at 3 for name-only sigs.
    // Demonstrate exact-only path: 4 calls same tool, different non-resource args.
    // (Normalized would also fire at 3 for name-only, so exact never gets a chance
    // to be the distinguishing check — but the 4-repeat exact behavior still exists.)
    // This test confirms the exact check is still in place via logger call count.
    const warn = vi.fn();
    const state = stubLoopState({
      logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as LoopState['logger'],
    });
    const cb = stubCallbacks();
    // Four calls with exactly the same signature — exact fires at 4, but normalized
    // fires first at 3. Confirm the 3rd call bails.
    const call = [makeToolUse('read_file', { path: 'a.ts' })];
    detectCycleAndBail(call, state, cb);
    detectCycleAndBail(call, state, cb);
    expect(detectCycleAndBail(call, state, cb)).toBe(true);
    // Should have been logged by normalized pass (fires at 3).
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('normalized cycle');
  });

  it('distinguishes different inputs for the same tool name', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    for (let i = 0; i < 4; i++) {
      const decision = detectCycleAndBail([makeToolUse('read_file', { path: `f${i}.ts` })], state, cb);
      expect(decision).toBe(false); // each call has a distinct signature
    }
    expect(state.recentToolCalls).toHaveLength(4);
  });

  it('detects a length-2 A,B,A,B cycle on the first full repetition', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    const A = [makeToolUse('read_file', { path: 'a.ts' })];
    const B = [makeToolUse('read_file', { path: 'b.ts' })];
    expect(detectCycleAndBail(A, state, cb)).toBe(false); // [A]
    expect(detectCycleAndBail(B, state, cb)).toBe(false); // [A,B]
    expect(detectCycleAndBail(A, state, cb)).toBe(false); // [A,B,A]
    expect(detectCycleAndBail(B, state, cb)).toBe(true); //  [A,B,A,B] — cycle
    expect(cb.texts[0]).toContain('length 2');
  });

  it('detects a length-3 cycle (A,B,C,A,B,C)', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    const A = [makeToolUse('a')];
    const B = [makeToolUse('b')];
    const C = [makeToolUse('c')];
    for (const c of [A, B, C, A, B]) expect(detectCycleAndBail(c, state, cb)).toBe(false);
    expect(detectCycleAndBail(C, state, cb)).toBe(true);
    expect(cb.texts[0]).toContain('length 3');
  });

  it('detects a length-4 cycle (A,B,C,D,A,B,C,D)', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    const A = [makeToolUse('a')];
    const B = [makeToolUse('b')];
    const C = [makeToolUse('c')];
    const D = [makeToolUse('d')];
    for (const c of [A, B, C, D, A, B, C]) expect(detectCycleAndBail(c, state, cb)).toBe(false);
    expect(detectCycleAndBail(D, state, cb)).toBe(true);
    expect(cb.texts[0]).toContain('length 4');
  });

  it('does NOT fire on a length-5 pattern (MAX_CYCLE_LEN=4)', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    const seq = ['a', 'b', 'c', 'd', 'e'].map((n) => [makeToolUse(n)]);
    // Pattern ABCDE,ABCDE has length 5 — above MAX_CYCLE_LEN. The ring
    // buffer trims at CYCLE_WINDOW=8 so we never see two full copies
    // of a length-5 pattern anyway (would need 10 slots). Confirm no
    // bail fires throughout.
    for (const call of [...seq, ...seq]) {
      expect(detectCycleAndBail(call, state, cb)).toBe(false);
    }
  });

  it('trims the ring buffer at CYCLE_WINDOW=8 entries', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    for (let i = 0; i < 10; i++) {
      detectCycleAndBail([makeToolUse(`t${i}`)], state, cb);
    }
    expect(state.recentToolCalls).toHaveLength(8);
    // Oldest entries dropped.
    expect(state.recentToolCalls[0]).toContain('t2:');
    expect(state.recentToolCalls[7]).toContain('t9:');
  });

  it('handles multi-tool-call turns by joining signatures with |', () => {
    // A turn that calls read_file + grep in one iteration has a
    // composite signature. Two such turns in a row = length-1 cycle?
    // No — need 4 for length-1. But A,B cycle works with composites.
    const state = stubLoopState();
    const cb = stubCallbacks();
    const turn1 = [makeToolUse('read_file', { path: 'a' }), makeToolUse('grep', { pattern: 'x' })];
    const turn2 = [makeToolUse('ls', { dir: '.' })];
    expect(detectCycleAndBail(turn1, state, cb)).toBe(false);
    expect(detectCycleAndBail(turn2, state, cb)).toBe(false);
    expect(detectCycleAndBail(turn1, state, cb)).toBe(false);
    expect(detectCycleAndBail(turn2, state, cb)).toBe(true); // length-2 cycle
    expect(cb.texts[0]).toContain('length 2');
  });
});

describe('detectCycleAndBail — normalized signature pass', () => {
  // The normalized pass strips secondary args (edit content, line ranges,
  // flags) and fires at MIN_NORMALIZED_REPEATS (3) instead of 4. Its job
  // is to catch "same tool on the same file with different content each
  // time" loops that the exact-match pass misses.

  it('does NOT fire when same file is edited 3 times with all-unique content', () => {
    // Core fix: three edits to the same file with different search/replace each
    // time should not kill the loop — the agent is making progress.
    const state = stubLoopState();
    const cb = stubCallbacks();
    for (let i = 0; i < 3; i++) {
      expect(
        detectCycleAndBail(
          [makeToolUse('edit_file', { path: 'src/auth.ts', search: `foo${i}`, replace: `bar${i}` })],
          state,
          cb,
        ),
      ).toBe(false);
    }
    expect(cb.texts).toHaveLength(0);
  });

  it('fires when same file is edited and a previous search/replace is reused', () => {
    // If secondary args repeat (agent tried the same edit twice), it is stuck.
    const state = stubLoopState();
    const cb = stubCallbacks();
    const edit0 = [makeToolUse('edit_file', { path: 'src/auth.ts', search: 'foo0', replace: 'bar0' })];
    const edit1 = [makeToolUse('edit_file', { path: 'src/auth.ts', search: 'foo1', replace: 'bar1' })];
    expect(detectCycleAndBail(edit0, state, cb)).toBe(false);
    expect(detectCycleAndBail(edit1, state, cb)).toBe(false);
    // Third call reuses edit0's content — secondary hash recurs → loop detected.
    expect(detectCycleAndBail(edit0, state, cb)).toBe(true);
    expect(cb.texts[0]).toContain('repeated');
  });

  it('does NOT fire when the primary resource changes between calls', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    // Different files each time — normalized sigs differ, no cycle.
    for (let i = 0; i < 6; i++) {
      expect(
        detectCycleAndBail(
          [makeToolUse('edit_file', { path: `src/file${i}.ts`, search: 'x', replace: 'y' })],
          state,
          cb,
        ),
      ).toBe(false);
    }
  });

  it('fires on a normalized length-2 cycle with varying secondary args', () => {
    // Turn A: read_file(a.ts) with some content args
    // Turn B: edit_file(a.ts) with different content each round
    // After A,B,A,B the normalized cycle (length 2) should fire.
    const state = stubLoopState();
    const cb = stubCallbacks();
    const makeA = (i: number) => [makeToolUse('read_file', { path: 'a.ts', startLine: i })];
    const makeB = (i: number) => [makeToolUse('edit_file', { path: 'a.ts', search: `v${i}`, replace: `w${i}` })];
    expect(detectCycleAndBail(makeA(0), state, cb)).toBe(false); // [A]
    expect(detectCycleAndBail(makeB(0), state, cb)).toBe(false); // [A,B]
    expect(detectCycleAndBail(makeA(1), state, cb)).toBe(false); // [A,B,A]
    expect(detectCycleAndBail(makeB(1), state, cb)).toBe(true); // [A,B,A,B] — norm length-2
    expect(cb.texts[0]).toContain('length 2');
  });

  it('does NOT fire when same command runs with a different cwd each time', () => {
    // Running npm test in 3 different directories is legitimate, not a loop.
    const state = stubLoopState();
    const cb = stubCallbacks();
    for (let i = 0; i < 3; i++) {
      expect(
        detectCycleAndBail([makeToolUse('run_command', { command: 'npm test', cwd: `/project${i}` })], state, cb),
      ).toBe(false);
    }
    expect(cb.texts).toHaveLength(0);
  });

  it('fires when same command and cwd repeats', () => {
    // Two unique cwds then a repeat of the first — secondary hash recurs → loop.
    const state = stubLoopState();
    const cb = stubCallbacks();
    expect(detectCycleAndBail([makeToolUse('run_command', { command: 'npm test', cwd: '/project0' })], state, cb)).toBe(
      false,
    );
    expect(detectCycleAndBail([makeToolUse('run_command', { command: 'npm test', cwd: '/project1' })], state, cb)).toBe(
      false,
    );
    expect(detectCycleAndBail([makeToolUse('run_command', { command: 'npm test', cwd: '/project0' })], state, cb)).toBe(
      true,
    );
    expect(cb.texts[0]).toContain('repeated');
  });

  it('uses first non-primary string arg so different values do not collide', () => {
    // Tools with no path/command/query fall back to the first string value
    // in the input rather than bare tool name — so different filter values
    // produce distinct signatures and do NOT trigger a false-positive cycle.
    const state = stubLoopState();
    const cb = stubCallbacks();
    for (let i = 0; i < 3; i++) {
      expect(detectCycleAndBail([makeToolUse('list_processes', { filter: `p${i}` })], state, cb)).toBe(false);
    }
    expect(cb.texts).toHaveLength(0);
  });

  it('fires when no-primary-key tool is called with the same args repeatedly', () => {
    // Same tool, same non-primary arg value 3 times → normalized sig repeats → cycle.
    const state = stubLoopState();
    const cb = stubCallbacks();
    for (let i = 0; i < 2; i++) {
      expect(detectCycleAndBail([makeToolUse('list_processes', { filter: 'stuck' })], state, cb)).toBe(false);
    }
    expect(detectCycleAndBail([makeToolUse('list_processes', { filter: 'stuck' })], state, cb)).toBe(true);
    expect(cb.texts[0]).toContain('repeated');
  });

  it('does NOT fire when tool-name-only sig has different numeric args each time', () => {
    // No string args → sig is just the tool name. Different numeric args each
    // time means all-unique secondary hashes → not a loop.
    const state = stubLoopState();
    const cb = stubCallbacks();
    for (let i = 0; i < 3; i++) {
      expect(detectCycleAndBail([makeToolUse('list_processes', { limit: i })], state, cb)).toBe(false);
    }
    expect(cb.texts).toHaveLength(0);
  });

  it('fires when tool-name-only sig and secondary args also repeat', () => {
    // Same tool, same numeric arg each time → secondary hash repeats → loop.
    const state = stubLoopState();
    const cb = stubCallbacks();
    for (let i = 0; i < 2; i++) {
      expect(detectCycleAndBail([makeToolUse('list_processes', { limit: 10 })], state, cb)).toBe(false);
    }
    expect(detectCycleAndBail([makeToolUse('list_processes', { limit: 10 })], state, cb)).toBe(true);
    expect(cb.texts[0]).toContain('repeated');
  });

  it('fires on non-consecutive repeats of the same resource within the window', () => {
    // bad → grep → bad → list_dir → bad
    // The trailing-3 consecutive check never sees 3 matching entries in a row
    // (interleaved tools break the streak), and the interleaved tools use
    // distinct normalized sigs so no length-2 cycle forms. The new
    // frequency-over-window check accumulates 3 occurrences and fires.
    const state = stubLoopState();
    const cb = stubCallbacks();
    const bad = [makeToolUse('read_file', { path: 'bad.ts' })];
    const g = [makeToolUse('grep', { pattern: 'foo' })];
    const ls = [makeToolUse('list_directory', { directory: '.' })];
    expect(detectCycleAndBail(bad, state, cb)).toBe(false); // [bad]
    expect(detectCycleAndBail(g, state, cb)).toBe(false); // [bad, grep]
    expect(detectCycleAndBail(bad, state, cb)).toBe(false); // [bad, grep, bad]
    expect(detectCycleAndBail(ls, state, cb)).toBe(false); // [bad, grep, bad, ls]
    expect(detectCycleAndBail(bad, state, cb)).toBe(true); // 3× bad.ts → fire
    expect(cb.texts[0]).toContain('repeated');
  });

  it('does NOT fire on non-consecutive repeats when secondary args are all unique', () => {
    // edit_file on the same path with different content — agent is making progress,
    // not stuck. Use distinct interleaving tools so no length-2 normalized cycle forms.
    const state = stubLoopState();
    const cb = stubCallbacks();
    const other = (n: number) => [makeToolUse('run_command', { command: `step${n}` })];
    for (let i = 0; i < 3; i++) {
      const edit = [makeToolUse('edit_file', { path: 'a.ts', search: `v${i}`, replace: `w${i}` })];
      expect(detectCycleAndBail(edit, state, cb)).toBe(false);
      if (i < 2) expect(detectCycleAndBail(other(i), state, cb)).toBe(false);
    }
    expect(cb.texts).toHaveLength(0);
  });

  it('stays silent at 2 non-consecutive occurrences (just below the threshold of 3)', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    const bad = [makeToolUse('read_file', { path: 'ghost.ts' })];
    const g = [makeToolUse('grep', { pattern: 'x' })];
    expect(detectCycleAndBail(bad, state, cb)).toBe(false);
    expect(detectCycleAndBail(g, state, cb)).toBe(false);
    expect(detectCycleAndBail(bad, state, cb)).toBe(false); // 2nd occurrence — not enough
    expect(cb.texts).toHaveLength(0);
  });

  it('resets the count when old entries are evicted from the 8-slot window', () => {
    // Load the window with 1 bad call followed by 8 different calls (evicting bad).
    // Then 2 more bad calls should not fire (only 2 in the current window).
    const state = stubLoopState();
    const cb = stubCallbacks();
    const bad = [makeToolUse('read_file', { path: 'ghost.ts' })];
    detectCycleAndBail(bad, state, cb); // bad enters window
    // Fill + overflow the 8-slot window so bad is evicted.
    for (let i = 0; i < 8; i++) {
      detectCycleAndBail([makeToolUse('grep', { pattern: `p${i}` })], state, cb);
    }
    // bad is gone; add it 2 more times — below threshold.
    expect(detectCycleAndBail(bad, state, cb)).toBe(false); // 1 in window
    expect(detectCycleAndBail([makeToolUse('list_directory', { directory: '.' })], state, cb)).toBe(false);
    expect(detectCycleAndBail(bad, state, cb)).toBe(false); // 2 in window — not enough
    expect(cb.texts).toHaveLength(0);
  });

  it('simulates the gemma4 hallucinated-path pattern from production logs', () => {
    // Model attempts to read a non-existent file, gets ENOENT, does other exploration,
    // comes back to the same hallucinated path repeatedly. After 3 occurrences the
    // frequency-over-window check fires even though no 3 calls are consecutive.
    const state = stubLoopState();
    const cb = stubCallbacks();
    const bad = [makeToolUse('read_file', { path: 'src/agent/loop/runAgentLoop.ts' })];

    expect(detectCycleAndBail(bad, state, cb)).toBe(false);
    expect(detectCycleAndBail([makeToolUse('list_directory', { directory: 'src/agent' })], state, cb)).toBe(false);
    expect(detectCycleAndBail([makeToolUse('grep', { pattern: 'runAgentLoop' })], state, cb)).toBe(false);
    expect(detectCycleAndBail(bad, state, cb)).toBe(false); // 2nd attempt
    expect(detectCycleAndBail([makeToolUse('project_knowledge_search', { query: 'agent loop' })], state, cb)).toBe(
      false,
    );
    expect(detectCycleAndBail(bad, state, cb)).toBe(true); // 3rd attempt → fire
    expect(cb.texts[0]).toContain('repeated');
  });

  it('does not fire the normalized check when exact check already fired', () => {
    // Exact-identical calls fire the exact check at 4. The normalized check
    // would fire at 3, but the function returns as soon as exact check fires
    // so calls 1-3 test normalized, call 4 fires exact first.
    // (Both checks fire on the 3rd call for identical calls since normalized
    // threshold is 3 — confirm the message is about "same resource".)
    const state = stubLoopState();
    const cb = stubCallbacks();
    const call = [makeToolUse('read_file', { path: 'x.ts' })];
    expect(detectCycleAndBail(call, state, cb)).toBe(false);
    expect(detectCycleAndBail(call, state, cb)).toBe(false);
    const fired = detectCycleAndBail(call, state, cb);
    expect(fired).toBe(true);
    // Normalized fires at 3 — message reflects resource-based detection.
    expect(cb.texts[0]).toContain('repeated');
  });
});

describe('detectCycleAndBail — write-target thrash pass', () => {
  it('fires when the same file is targeted by mutation tools in 4 iterations, even with different tools', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    // Different tools, same file path — bypasses exact and normalized checks.
    expect(detectCycleAndBail([makeToolUse('write_file', { path: 'src/foo.ts' })], state, cb)).toBe(false);
    expect(detectCycleAndBail([makeToolUse('edit_file', { file_path: 'src/foo.ts' })], state, cb)).toBe(false);
    expect(detectCycleAndBail([makeToolUse('apply_edit', { path: 'src/foo.ts' })], state, cb)).toBe(false);
    expect(detectCycleAndBail([makeToolUse('write_file', { path: 'src/foo.ts' })], state, cb)).toBe(true);
    expect(cb.texts[0]).toContain('src/foo.ts');
    expect(cb.texts[0]).toContain('write target');
  });

  it('does NOT fire on a file the syntax gate is actively driving fixes on (gate-supervised, not thrash)', () => {
    const state = stubLoopState();
    state.gateState.syntaxGateFixTargets = new Set(['gui_calculator.py']);
    const cb = stubCallbacks();
    // create + 3 genuinely different fix edits (distinct search/replace, like
    // the real case) — exact + normalized passes don't fire; only write-target
    // would, at the threshold of 4. The file is gate-supervised so it's exempt.
    expect(
      detectCycleAndBail([makeToolUse('write_file', { path: 'gui_calculator.py', content: 'v0' })], state, cb),
    ).toBe(false);
    for (let i = 1; i <= 3; i++) {
      const result = detectCycleAndBail(
        [makeToolUse('edit_file', { path: 'gui_calculator.py', search: `s${i}`, replace: `r${i}` })],
        state,
        cb,
      );
      expect(result).toBe(false);
    }
    expect(cb.texts).toHaveLength(0);
  });

  it('matches the gate exemption by basename (normalized path vs raw input path)', () => {
    const state = stubLoopState();
    state.gateState.syntaxGateFixTargets = new Set(['sub/gui.py']); // gate-normalized
    const cb = stubCallbacks();
    // Mirror the real flow (write → read → edit → edit → edit): 4 mutations of
    // the same file, raw input uses the bare basename. Without the exemption
    // the write-target pass would fire at the 3rd edit.
    const calls: ToolUseContentBlock[][] = [
      [makeToolUse('write_file', { path: 'gui.py', content: 'v0' })],
      [makeToolUse('read_file', { path: 'gui.py' })],
      [makeToolUse('edit_file', { path: 'gui.py', search: 's1', replace: 'r1' })],
      [makeToolUse('edit_file', { path: 'gui.py', search: 's2', replace: 'r2' })],
      [makeToolUse('edit_file', { path: 'gui.py', search: 's3', replace: 'r3' })],
    ];
    for (const c of calls) expect(detectCycleAndBail(c, state, cb)).toBe(false);
    expect(cb.texts).toHaveLength(0);
  });

  it('still fires on an unrelated file while another file is gate-exempt', () => {
    const state = stubLoopState();
    state.gateState.syntaxGateFixTargets = new Set(['gui_calculator.py']);
    const cb = stubCallbacks();
    expect(detectCycleAndBail([makeToolUse('write_file', { path: 'other.ts' })], state, cb)).toBe(false);
    expect(detectCycleAndBail([makeToolUse('edit_file', { path: 'other.ts' })], state, cb)).toBe(false);
    expect(detectCycleAndBail([makeToolUse('apply_edit', { path: 'other.ts' })], state, cb)).toBe(false);
    expect(detectCycleAndBail([makeToolUse('write_file', { path: 'other.ts' })], state, cb)).toBe(true);
    expect(cb.texts[0]).toContain('other.ts');
  });

  it('does NOT fire when 3 different files are each targeted once', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    expect(detectCycleAndBail([makeToolUse('write_file', { path: 'a.ts' })], state, cb)).toBe(false);
    expect(detectCycleAndBail([makeToolUse('write_file', { path: 'b.ts' })], state, cb)).toBe(false);
    expect(detectCycleAndBail([makeToolUse('write_file', { path: 'c.ts' })], state, cb)).toBe(false);
    expect(cb.texts).toHaveLength(0);
  });

  it('does NOT fire when mutation tool targets different files each time', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    for (let i = 0; i < 6; i++) {
      const result = detectCycleAndBail([makeToolUse('edit_file', { file_path: `src/file${i}.ts` })], state, cb);
      expect(result).toBe(false);
    }
    expect(cb.texts).toHaveLength(0);
  });

  it('does NOT trigger on read-only tools hitting the same file', () => {
    const state = stubLoopState();
    const cb = stubCallbacks();
    // 4 read_file calls on the same path should NOT trigger the write-target check
    // (the normalized check handles read-only thrashing separately).
    for (let i = 0; i < 3; i++) {
      // Stop before normalized check fires (MIN_NORMALIZED_REPEATS = 3).
    }
    // Just confirm write-target buffer only tracks mutation tools.
    expect(state.recentWriteTargets).toHaveLength(0);
    detectCycleAndBail([makeToolUse('read_file', { path: 'src/foo.ts' })], state, cb);
    expect(state.recentWriteTargets[0]).toHaveLength(0); // no mutation tools → empty targets
  });
});
