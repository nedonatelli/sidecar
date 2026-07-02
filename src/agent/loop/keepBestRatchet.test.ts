import { describe, it, expect } from 'vitest';
import {
  decideRatchet,
  captureFileSnapshot,
  restoreFileSnapshot,
  patchBytes,
  DEFAULT_OVER_ENGINEER_BYTES,
  type RatchetSignal,
  type SnapshotIo,
  type RestoreIo,
} from './keepBestRatchet.js';

function sig(over: Partial<RatchetSignal> = {}): RatchetSignal {
  return {
    projectTestsPassed: false,
    passingTestFiles: new Set<string>(),
    patchBytes: 0,
    ...over,
  };
}

describe('decideRatchet — regression (do-no-harm line)', () => {
  it('reverts when project tests were passing and now are not', () => {
    const before = sig({ projectTestsPassed: true });
    const after = sig({ projectTestsPassed: false });
    const d = decideRatchet(before, after);
    expect(d.verdict).toBe('revert-regression');
    expect(d.reason).toMatch(/project tests/i);
  });

  it('reverts when a per-file passing test dropped out', () => {
    const before = sig({ passingTestFiles: new Set(['a.test.ts', 'b.test.ts']) });
    const after = sig({ passingTestFiles: new Set(['a.test.ts']) });
    const d = decideRatchet(before, after);
    expect(d.verdict).toBe('revert-regression');
    expect(d.reason).toContain('b.test.ts');
  });

  it('regression dominates even when a NEW test also went green', () => {
    // Fixed one test, broke another → not Pareto-safe → revert.
    const before = sig({ passingTestFiles: new Set(['keep.test.ts', 'broken.test.ts']) });
    const after = sig({ passingTestFiles: new Set(['keep.test.ts', 'new.test.ts']) });
    expect(decideRatchet(before, after).verdict).toBe('revert-regression');
  });

  it('regression dominates even when the patch shrank', () => {
    const before = sig({ projectTestsPassed: true, patchBytes: 10_000 });
    const after = sig({ projectTestsPassed: false, patchBytes: 10 });
    expect(decideRatchet(before, after).verdict).toBe('revert-regression');
  });
});

describe('decideRatchet — over-engineering (patch minimality)', () => {
  it('reverts a large patch that improved no test signal', () => {
    const before = sig({ patchBytes: 500 });
    const after = sig({ patchBytes: 500 + DEFAULT_OVER_ENGINEER_BYTES + 1 });
    const d = decideRatchet(before, after);
    expect(d.verdict).toBe('revert-overengineering');
    expect(d.reason).toMatch(/without improving/i);
  });

  it('KEEPS a large patch when it turned project tests green', () => {
    const before = sig({ projectTestsPassed: false, patchBytes: 500 });
    const after = sig({ projectTestsPassed: true, patchBytes: 500 + 50_000 });
    expect(decideRatchet(before, after).verdict).toBe('keep');
  });

  it('KEEPS a large patch when it made a new test file pass', () => {
    const before = sig({ passingTestFiles: new Set<string>(), patchBytes: 0 });
    const after = sig({ passingTestFiles: new Set(['new.test.ts']), patchBytes: 40_000 });
    expect(decideRatchet(before, after).verdict).toBe('keep');
  });

  it('KEEPS growth at or below the threshold', () => {
    const before = sig({ patchBytes: 0 });
    const after = sig({ patchBytes: DEFAULT_OVER_ENGINEER_BYTES }); // exactly at threshold, not over
    expect(decideRatchet(before, after).verdict).toBe('keep');
  });

  it('honors a custom over-engineering threshold', () => {
    const before = sig({ patchBytes: 0 });
    const after = sig({ patchBytes: 101 });
    expect(decideRatchet(before, after, { overEngineerBytes: 100 }).verdict).toBe('revert-overengineering');
    expect(decideRatchet(before, after, { overEngineerBytes: 200 }).verdict).toBe('keep');
  });

  it('models the 32KB test-churn case: gate ballooned patch, no new green → revert', () => {
    const before = sig({ patchBytes: 450 }); // bare model patch
    const after = sig({ patchBytes: 32_000 }); // gate-driven test churn
    expect(decideRatchet(before, after).verdict).toBe('revert-overengineering');
  });
});

describe('decideRatchet — keep (held or improved)', () => {
  it('keeps a small no-signal-change edit', () => {
    expect(decideRatchet(sig({ patchBytes: 100 }), sig({ patchBytes: 300 })).verdict).toBe('keep');
  });

  it('keeps when the patch shrank and nothing regressed', () => {
    const before = sig({ passingTestFiles: new Set(['a.test.ts']), patchBytes: 5000 });
    const after = sig({ passingTestFiles: new Set(['a.test.ts']), patchBytes: 400 });
    expect(decideRatchet(before, after).verdict).toBe('keep');
  });
});

// --- snapshot / restore -----------------------------------------------------

/** In-memory fs double implementing both snapshot-read and restore-write. */
class FakeFs implements SnapshotIo, RestoreIo {
  files: Map<string, string>;
  writes: string[] = [];
  removes: string[] = [];
  constructor(initial: Record<string, string> = {}) {
    this.files = new Map(Object.entries(initial));
  }
  async read(path: string): Promise<string | null> {
    return this.files.has(path) ? (this.files.get(path) as string) : null;
  }
  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    this.writes.push(path);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.removes.push(path);
  }
}

describe('captureFileSnapshot + restoreFileSnapshot', () => {
  it('captures existing content and null for missing files', async () => {
    const fs = new FakeFs({ 'a.ts': 'AAA' });
    const snap = await captureFileSnapshot(['a.ts', 'missing.ts'], fs);
    expect(snap.contents.get('a.ts')).toBe('AAA');
    expect(snap.contents.get('missing.ts')).toBeNull();
  });

  it('restores modified content and reports what changed', async () => {
    const fs = new FakeFs({ 'a.ts': 'ORIGINAL' });
    const snap = await captureFileSnapshot(['a.ts'], fs);
    await fs.write('a.ts', 'MUTATED-BY-SCAFFOLD');
    const reverted = await restoreFileSnapshot(snap, fs, fs);
    expect(reverted).toEqual(['a.ts']);
    expect(await fs.read('a.ts')).toBe('ORIGINAL');
  });

  it('deletes files that did not exist at snapshot time', async () => {
    const fs = new FakeFs({});
    const snap = await captureFileSnapshot(['new.ts'], fs); // captured as null
    await fs.write('new.ts', 'scaffold created this');
    const reverted = await restoreFileSnapshot(snap, fs, fs);
    expect(reverted).toEqual(['new.ts']);
    expect(fs.removes).toContain('new.ts');
    expect(await fs.read('new.ts')).toBeNull();
  });

  it('skips paths whose content already matches the snapshot (no redundant write)', async () => {
    const fs = new FakeFs({ 'a.ts': 'SAME', 'b.ts': 'B0' });
    const snap = await captureFileSnapshot(['a.ts', 'b.ts'], fs);
    await fs.write('b.ts', 'B1'); // only b changed
    fs.writes = [];
    const reverted = await restoreFileSnapshot(snap, fs, fs);
    expect(reverted).toEqual(['b.ts']);
    expect(fs.writes).toEqual(['b.ts']); // a.ts untouched
  });

  it('a captured snapshot is immune to later live-set mutation (deep copy of content)', async () => {
    const fs = new FakeFs({ 'a.ts': 'V1' });
    const snap = await captureFileSnapshot(['a.ts'], fs);
    await fs.write('a.ts', 'V2');
    await fs.write('a.ts', 'V3');
    await restoreFileSnapshot(snap, fs, fs);
    expect(await fs.read('a.ts')).toBe('V1');
  });
});

describe('patchBytes', () => {
  it('sums UTF-8 byte length across existing files, 0 for missing', async () => {
    const fs = new FakeFs({ 'a.ts': 'abc', 'b.ts': 'de' });
    expect(await patchBytes(['a.ts', 'b.ts', 'gone.ts'], fs)).toBe(5);
  });

  it('counts multibyte content by bytes, not chars', async () => {
    const fs = new FakeFs({ 'u.ts': '€' }); // 3 bytes UTF-8, 1 char
    expect(await patchBytes(['u.ts'], fs)).toBe(3);
  });
});
