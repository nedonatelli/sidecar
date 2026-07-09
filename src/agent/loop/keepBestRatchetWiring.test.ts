import { describe, it, expect, vi } from 'vitest';
import type { ToolUseContentBlock } from '../../ollama/types.js';
import type { LoopState } from './state.js';
import type { AgentCallbacks } from '../loop.js';
import type { SnapshotIo, RestoreIo } from './keepBestRatchet.js';
import {
  writeTargetsFromToolUses,
  selectRevertContents,
  captureRatchetOriginals,
  captureScaffoldBoundary,
  evaluateRatchetAtTermination,
  initRatchetRunState,
  type RatchetRunState,
} from './keepBestRatchetWiring.js';

function toolUse(name: string, input: Record<string, unknown>): ToolUseContentBlock {
  return { type: 'tool_use', id: `id-${name}`, name, input } as ToolUseContentBlock;
}

class FakeFs implements SnapshotIo, RestoreIo {
  files: Map<string, string>;
  writes: string[] = [];
  removes: string[] = [];
  constructor(initial: Record<string, string> = {}) {
    this.files = new Map(Object.entries(initial));
  }
  async read(p: string): Promise<string | null> {
    return this.files.has(p) ? (this.files.get(p) as string) : null;
  }
  async write(p: string, content: string): Promise<void> {
    this.files.set(p, content);
    this.writes.push(p);
  }
  async remove(p: string): Promise<void> {
    this.files.delete(p);
    this.removes.push(p);
  }
}

/** Minimal LoopState with just the fields the ratchet wiring touches. */
function fakeState(ratchet: RatchetRunState, gate: Partial<LoopState['gateState']> = {}): LoopState {
  return {
    ratchet,
    logger: undefined,
    gateState: {
      editedFiles: new Set<string>(),
      passingTestFiles: new Set<string>(),
      projectTestsPassed: false,
      ...gate,
    },
  } as unknown as LoopState;
}

function noopCallbacks(onText = vi.fn()): AgentCallbacks {
  return { onText, onToolCall: vi.fn(), onToolResult: vi.fn(), onDone: vi.fn() } as unknown as AgentCallbacks;
}

describe('writeTargetsFromToolUses', () => {
  it('extracts paths from write/edit/delete tools only', () => {
    const uses = [
      toolUse('write_file', { path: 'a.ts', content: 'x' }),
      toolUse('edit_file', { path: 'b.ts', search: 's', replace: 'r' }),
      toolUse('delete_file', { path: 'c.ts' }),
      toolUse('read_file', { path: 'ignore.ts' }),
      toolUse('run_command', { command: 'ls' }),
    ];
    expect(writeTargetsFromToolUses(uses)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('skips tool uses with a missing or non-string path', () => {
    const uses = [toolUse('write_file', {}), toolUse('write_file', { path: 42 }), toolUse('write_file', { path: '' })];
    expect(writeTargetsFromToolUses(uses)).toEqual([]);
  });
});

describe('selectRevertContents', () => {
  it('reverts pre-scaffold files to boundary content', () => {
    const targets = selectRevertContents(
      new Set(['keep.ts']),
      new Set(['keep.ts']),
      new Map([['keep.ts', 'GOOD']]),
      new Map(),
    );
    expect(targets.get('keep.ts')).toBe('GOOD');
  });

  it('deletes tail files created this run (original null)', () => {
    const targets = selectRevertContents(
      new Set(['new_test.py']),
      new Set(),
      new Map(),
      new Map([['new_test.py', null]]),
    );
    expect(targets.has('new_test.py')).toBe(true);
    expect(targets.get('new_test.py')).toBeNull();
  });

  it('restores tail files that pre-existed to their original content', () => {
    const targets = selectRevertContents(
      new Set(['helper.ts']),
      new Set(),
      new Map(),
      new Map([['helper.ts', 'ORIGINAL']]),
    );
    expect(targets.get('helper.ts')).toBe('ORIGINAL');
  });

  it('SKIPS a tail file it never baselined — never risks deleting an unknown file', () => {
    const targets = selectRevertContents(new Set(['mystery.ts']), new Set(), new Map(), new Map());
    expect(targets.has('mystery.ts')).toBe(false);
  });

  it('keeps good pre-scaffold work while undoing tail churn in one pass', () => {
    const targets = selectRevertContents(
      new Set(['app.ts', 'churn.test.ts']),
      new Set(['app.ts']),
      new Map([['app.ts', 'REAL FIX']]),
      new Map([['churn.test.ts', null]]),
    );
    expect(targets.get('app.ts')).toBe('REAL FIX');
    expect(targets.get('churn.test.ts')).toBeNull();
  });
});

describe('captureRatchetOriginals', () => {
  it('captures pre-edit content once per path; null for files that do not exist', async () => {
    const fs = new FakeFs({ 'exists.ts': 'V0' });
    const r = initRatchetRunState(true, 4096);
    const state = fakeState(r);
    await captureRatchetOriginals(state, [toolUse('write_file', { path: 'exists.ts', content: 'V1' })], fs);
    await captureRatchetOriginals(state, [toolUse('write_file', { path: 'new.ts', content: 'created' })], fs);
    expect(r.originals.get('exists.ts')).toBe('V0');
    expect(r.originals.get('new.ts')).toBeNull();
  });

  it('does not re-capture a path already baselined (first write wins)', async () => {
    const fs = new FakeFs({ 'f.ts': 'ORIGINAL' });
    const r = initRatchetRunState(true, 4096);
    const state = fakeState(r);
    await captureRatchetOriginals(state, [toolUse('write_file', { path: 'f.ts', content: 'A' })], fs);
    await fs.write('f.ts', 'B');
    await captureRatchetOriginals(state, [toolUse('write_file', { path: 'f.ts', content: 'C' })], fs);
    expect(r.originals.get('f.ts')).toBe('ORIGINAL');
  });

  it('no-ops when the ratchet is disabled', async () => {
    const fs = new FakeFs({ 'f.ts': 'V0' });
    const r = initRatchetRunState(false, 4096);
    const state = fakeState(r);
    await captureRatchetOriginals(state, [toolUse('write_file', { path: 'f.ts', content: 'V1' })], fs);
    expect(r.originals.size).toBe(0);
  });
});

describe('captureScaffoldBoundary', () => {
  it('arms once, snapshotting the current signal + edited-file content', async () => {
    const fs = new FakeFs({ 'a.ts': 'AAAA' });
    const r = initRatchetRunState(true, 4096);
    const state = fakeState(r, { editedFiles: new Set(['a.ts']), projectTestsPassed: true });
    await captureScaffoldBoundary(state, fs);
    expect(r.boundaryCaptured).toBe(true);
    expect(r.preScaffoldFiles.has('a.ts')).toBe(true);
    expect(r.boundarySignal?.projectTestsPassed).toBe(true);
    expect(r.boundarySignal?.patchBytes).toBe(4);
    expect(r.boundaryContent.get('a.ts')).toBe('AAAA');
  });

  it('does not arm when nothing has been edited yet (pure review reprompt)', async () => {
    const fs = new FakeFs();
    const r = initRatchetRunState(true, 4096);
    const state = fakeState(r, { editedFiles: new Set() });
    await captureScaffoldBoundary(state, fs);
    expect(r.boundaryCaptured).toBe(false);
  });

  it('does not re-arm once captured', async () => {
    const fs = new FakeFs({ 'a.ts': 'AAAA', 'b.ts': 'BB' });
    const r = initRatchetRunState(true, 4096);
    const state = fakeState(r, { editedFiles: new Set(['a.ts']) });
    await captureScaffoldBoundary(state, fs);
    state.gateState.editedFiles.add('b.ts');
    await captureScaffoldBoundary(state, fs);
    expect(r.preScaffoldFiles.has('b.ts')).toBe(false); // still the first snapshot
  });
});

describe('evaluateRatchetAtTermination', () => {
  it('reverts over-engineered tail churn: deletes the 32KB test file the gate provoked', async () => {
    const big = 'x'.repeat(32_000);
    const fs = new FakeFs({ 'app.ts': 'REAL FIX (450b)'.padEnd(450, ' '), 'churn.test.ts': big });
    const r = initRatchetRunState(true, 4096);
    // Boundary armed after the small app.ts fix, before the gate drove the churn.
    r.boundaryCaptured = true;
    r.preScaffoldFiles = new Set(['app.ts']);
    r.boundaryContent = new Map([['app.ts', 'REAL FIX (450b)'.padEnd(450, ' ')]]);
    r.boundarySignal = { projectTestsPassed: false, passingTestFiles: new Set(), patchBytes: 450 };
    r.originals = new Map([['churn.test.ts', null]]); // created during the tail
    const state = fakeState(r, { editedFiles: new Set(['app.ts', 'churn.test.ts']), projectTestsPassed: false });
    const onText = vi.fn();
    await evaluateRatchetAtTermination(state, fs, noopCallbacks(onText));
    expect(await fs.read('churn.test.ts')).toBeNull(); // reverted (deleted)
    expect(await fs.read('app.ts')).toBe('REAL FIX (450b)'.padEnd(450, ' ')); // good work kept
    expect(onText).toHaveBeenCalledWith(expect.stringContaining('unproven scaffold-driven growth'));
  });

  it('reverts a regression: restores the pre-scaffold file when a green test went red', async () => {
    const fs = new FakeFs({ 'mod.ts': 'BROKEN BY SCAFFOLD' });
    const r = initRatchetRunState(true, 4096);
    r.boundaryCaptured = true;
    r.preScaffoldFiles = new Set(['mod.ts']);
    r.boundaryContent = new Map([['mod.ts', 'PASSING VERSION']]);
    r.boundarySignal = { projectTestsPassed: true, passingTestFiles: new Set(['mod.test.ts']), patchBytes: 20 };
    const state = fakeState(r, { editedFiles: new Set(['mod.ts']), projectTestsPassed: false });
    const onText = vi.fn();
    await evaluateRatchetAtTermination(state, fs, noopCallbacks(onText));
    expect(await fs.read('mod.ts')).toBe('PASSING VERSION');
    expect(onText).toHaveBeenCalledWith(expect.stringContaining('test regression'));
  });

  it('keeps changes that earned a new green even when the patch grew a lot', async () => {
    const fs = new FakeFs({ 'app.ts': 'x'.repeat(40_000) });
    const r = initRatchetRunState(true, 4096);
    r.boundaryCaptured = true;
    r.preScaffoldFiles = new Set(['app.ts']);
    r.boundaryContent = new Map([['app.ts', 'small']]);
    r.boundarySignal = { projectTestsPassed: false, passingTestFiles: new Set(), patchBytes: 5 };
    const state = fakeState(r, {
      editedFiles: new Set(['app.ts']),
      projectTestsPassed: true, // scaffold work turned tests green
    });
    const onText = vi.fn();
    await evaluateRatchetAtTermination(state, fs, noopCallbacks(onText));
    expect(await fs.read('app.ts')).toBe('x'.repeat(40_000)); // kept
    expect(onText).not.toHaveBeenCalled();
  });

  it('no-ops when the ratchet never armed', async () => {
    const fs = new FakeFs({ 'a.ts': 'A' });
    const r = initRatchetRunState(true, 4096); // never armed
    const state = fakeState(r, { editedFiles: new Set(['a.ts']) });
    const onText = vi.fn();
    await evaluateRatchetAtTermination(state, fs, noopCallbacks(onText));
    expect(await fs.read('a.ts')).toBe('A');
    expect(onText).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // Do-no-harm scenarios — the two SWE-campaign failures where the
  // completion gate's verification push drove a weak 7B to make the patch
  // WORSE, and the run ended via cycle-detection bail ('stuck'), not
  // naturally. evaluateRatchetAtTermination is termination-agnostic by
  // design (only user-abort skips it, in loop.ts) — these tests pin that a
  // bail-terminated run still gets the revert, at the 2.0.1 default
  // threshold (0 bytes: ANY unproven scaffold-tail growth reverts).
  // ---------------------------------------------------------------------

  it('django-14608 shape: small wrong tail edit to an UNRELATED file reverts on a stuck bail; the real fix stays', async () => {
    const realFix = 'MINIMAL CORRECT FIX'.padEnd(568, ' ');
    const fieldsOriginal = 'ORIGINAL AutoField'.padEnd(300, ' ');
    const wrongEdit = fieldsOriginal + 'forces blank=True globally'.padEnd(236, ' ');
    const fs = new FakeFs({ 'db/models.py': realFix, 'db/fields.py': wrongEdit });
    const r = initRatchetRunState(true, 0);
    // Armed when the gate's verification reprompt fired, right after the
    // correct 568b fix — before the model started flailing.
    r.boundaryCaptured = true;
    r.preScaffoldFiles = new Set(['db/models.py']);
    r.boundaryContent = new Map([['db/models.py', realFix]]);
    r.boundarySignal = { projectTestsPassed: false, passingTestFiles: new Set(), patchBytes: 568 };
    r.originals = new Map([
      ['db/models.py', 'PRISTINE models.py'],
      ['db/fields.py', fieldsOriginal], // pre-existed; the tail edited it
    ]);
    const state = fakeState(r, {
      editedFiles: new Set(['db/models.py', 'db/fields.py']),
      projectTestsPassed: false, // no test ever passed in either arm (no reachable runner)
    });
    (state as { termination?: string }).termination = 'stuck'; // cycle-detection bail, NOT natural

    const onText = vi.fn();
    await evaluateRatchetAtTermination(state, fs, noopCallbacks(onText));

    // The 536b wrong edit — far under the old 4096 threshold — reverts.
    expect(await fs.read('db/fields.py')).toBe(fieldsOriginal);
    // The pre-scaffold correct fix is untouched.
    expect(await fs.read('db/models.py')).toBe(realFix);
    expect(onText).toHaveBeenCalledWith(expect.stringContaining('unproven scaffold-driven growth'));
  });

  it('sympy-11897 shape: broken pattern duplicated into a SECOND file reverts; the pre-scaffold edit is preserved as-is', async () => {
    const garbled = 'GARBLED BUT PRE-SCAFFOLD latex() edit'.padEnd(512, ' ');
    const duplicated = 'SAME BROKEN PATTERN copied into pretty() -> mutual recursion'.padEnd(615, ' ');
    const fs = new FakeFs({ 'printing/latex.py': garbled, 'printing/pretty.py': duplicated });
    const r = initRatchetRunState(true, 0);
    r.boundaryCaptured = true;
    r.preScaffoldFiles = new Set(['printing/latex.py']);
    r.boundaryContent = new Map([['printing/latex.py', garbled]]);
    r.boundarySignal = { projectTestsPassed: false, passingTestFiles: new Set(), patchBytes: 512 };
    r.originals = new Map([
      ['printing/latex.py', 'PRISTINE latex.py'],
      ['printing/pretty.py', 'PRISTINE pretty.py'],
    ]);
    const state = fakeState(r, {
      editedFiles: new Set(['printing/latex.py', 'printing/pretty.py']),
      projectTestsPassed: false,
    });
    (state as { termination?: string }).termination = 'stuck';

    await evaluateRatchetAtTermination(state, fs, noopCallbacks());

    // The tail duplication (the mutual-recursion half) reverts…
    expect(await fs.read('printing/pretty.py')).toBe('PRISTINE pretty.py');
    // …but the pre-scaffold edit stays EVEN THOUGH it is itself imperfect:
    // do-no-harm means the scaffold-on arm converges to the scaffold-off
    // outcome, not that the ratchet fixes the model's own work.
    expect(await fs.read('printing/latex.py')).toBe(garbled);
  });
});
