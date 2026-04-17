import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { workspace } from 'vscode';
import { AuditBuffer, type PersistedBufferSnapshot } from './auditBuffer.js';
import { createWorkspaceAuditBufferPersistence } from './auditBufferPersistence.js';

/**
 * Tests for the workspace-fs-backed persistence shim + the
 * `AuditBuffer.setPersistence` / `restore` hooks it plugs into. The
 * roundtrip exercises real JSON serialization against an in-memory
 * Map stand-in for the workspace filesystem — we don't want to stub
 * `JSON.parse` itself since version-mismatch + corrupted-file
 * handling depend on real parser behavior.
 */

describe('createWorkspaceAuditBufferPersistence', () => {
  // Simulated disk: path.fsPath → Uint8Array. Every mock reads from
  // and writes to this map so a `save` followed by a `load` returns
  // the same bytes, matching real-disk roundtrip semantics.
  let disk: Map<string, Uint8Array>;
  let readFileSpy: ReturnType<typeof vi.spyOn>;
  let writeFileSpy: ReturnType<typeof vi.spyOn>;
  let deleteSpy: ReturnType<typeof vi.spyOn>;
  let createDirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    disk = new Map();
    readFileSpy = vi.spyOn(workspace.fs, 'readFile').mockImplementation(async (uri: unknown) => {
      const p = (uri as { fsPath: string }).fsPath;
      const bytes = disk.get(p);
      if (!bytes) throw new Error('FileNotFound');
      return bytes;
    }) as typeof readFileSpy;
    writeFileSpy = vi.spyOn(workspace.fs, 'writeFile').mockImplementation(async (uri: unknown, content: unknown) => {
      const p = (uri as { fsPath: string }).fsPath;
      disk.set(p, content as Uint8Array);
    }) as typeof writeFileSpy;
    deleteSpy = vi.spyOn(workspace.fs, 'delete').mockImplementation(async (uri: unknown) => {
      disk.delete((uri as { fsPath: string }).fsPath);
    }) as typeof deleteSpy;
    createDirSpy = vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined);
  });

  afterEach(() => {
    readFileSpy.mockRestore();
    writeFileSpy.mockRestore();
    deleteSpy.mockRestore();
    createDirSpy.mockRestore();
  });

  it('roundtrips entries + commits through save/load', async () => {
    const persistence = createWorkspaceAuditBufferPersistence();
    const snapshot: PersistedBufferSnapshot = {
      entries: [
        { path: 'a.ts', op: 'create', content: 'new file', timestamp: 1000 },
        { path: 'b.ts', op: 'modify', content: 'edited', originalContent: 'orig', timestamp: 2000 },
        { path: 'c.ts', op: 'delete', originalContent: 'was here', timestamp: 3000 },
      ],
      commits: [{ message: 'feat: add a and b', extraTrailers: 'X-AI-Model: foo', timestamp: 4000 }],
    };

    await persistence.save(snapshot);
    const loaded = await persistence.load();

    expect(loaded).toEqual(snapshot);
  });

  it('returns null when no state file exists', async () => {
    const persistence = createWorkspaceAuditBufferPersistence();
    const loaded = await persistence.load();
    expect(loaded).toBeNull();
  });

  it('deletes the state file on clear()', async () => {
    const persistence = createWorkspaceAuditBufferPersistence();
    await persistence.save({
      entries: [{ path: 'a.ts', op: 'create', content: 'x', timestamp: 1 }],
      commits: [],
    });
    expect(disk.size).toBe(1);

    await persistence.clear();

    expect(disk.size).toBe(0);
    const loaded = await persistence.load();
    expect(loaded).toBeNull();
  });

  it('rejects schema-mismatched persisted state', async () => {
    const persistence = createWorkspaceAuditBufferPersistence();
    // Hand-craft a v99 payload — different schema, must be discarded.
    const fakeState = Buffer.from(
      JSON.stringify({
        version: 99,
        savedAt: Date.now(),
        entries: [{ path: 'a.ts', op: 'create', content: 'x', timestamp: 1 }],
      }),
    );
    // The persistence writes to `.sidecar/audit-buffer/state.json`
    // under the mock workspace root — match that location.
    disk.set('/mock-workspace/.sidecar/audit-buffer/state.json', new Uint8Array(fakeState));

    const loaded = await persistence.load();
    expect(loaded).toBeNull();
  });

  it('migrates v1 files on load by defaulting commits to []', async () => {
    const persistence = createWorkspaceAuditBufferPersistence();
    // v1 shape — pre-a.4 persistence. Must upgrade cleanly.
    const v1State = Buffer.from(
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        entries: [{ path: 'legacy.ts', op: 'create', content: 'x', timestamp: 1 }],
      }),
    );
    disk.set('/mock-workspace/.sidecar/audit-buffer/state.json', new Uint8Array(v1State));

    const loaded = await persistence.load();
    expect(loaded).toEqual({
      entries: [{ path: 'legacy.ts', op: 'create', content: 'x', timestamp: 1 }],
      commits: [],
    });
  });

  it('rejects a corrupted JSON file', async () => {
    const persistence = createWorkspaceAuditBufferPersistence();
    disk.set('/mock-workspace/.sidecar/audit-buffer/state.json', Buffer.from('{ not json'));
    const loaded = await persistence.load();
    expect(loaded).toBeNull();
  });

  it('filters out entries and commits that fail shape validation on load', async () => {
    const persistence = createWorkspaceAuditBufferPersistence();
    const mixed = {
      version: 2,
      savedAt: Date.now(),
      entries: [
        { path: 'ok.ts', op: 'create', content: 'x', timestamp: 1 },
        { path: 42, op: 'create' }, // path not a string — dropped
        { op: 'create', path: 'no-timestamp.ts', content: 'x' }, // missing timestamp — dropped
        { path: 'bogus-op.ts', op: 'unknown', timestamp: 1 }, // bad op — dropped
      ],
      commits: [
        { message: 'valid: good', timestamp: 99 },
        { message: 42, timestamp: 1 }, // message not a string — dropped
        { message: 'no-timestamp' }, // missing timestamp — dropped
      ],
    };
    disk.set('/mock-workspace/.sidecar/audit-buffer/state.json', Buffer.from(JSON.stringify(mixed)));

    const loaded = await persistence.load();
    expect(loaded).toEqual({
      entries: [{ path: 'ok.ts', op: 'create', content: 'x', timestamp: 1 }],
      commits: [{ message: 'valid: good', timestamp: 99 }],
    });
  });
});

describe('AuditBuffer + persistence integration', () => {
  let savedStates: PersistedBufferSnapshot[];
  let persistence: ReturnType<typeof makeRecordingPersistence>;

  beforeEach(() => {
    savedStates = [];
    persistence = makeRecordingPersistence(savedStates);
  });

  /** Persistence that records every save so we can assert ordering. */
  function makeRecordingPersistence(sink: PersistedBufferSnapshot[]) {
    return {
      save: vi.fn(async (snapshot: PersistedBufferSnapshot) => {
        // Defensive copy — snapshot.entries is a live reference at
        // call time and we want to freeze the state as of this save.
        sink.push(JSON.parse(JSON.stringify(snapshot)) as PersistedBufferSnapshot);
      }),
      load: vi.fn(async () => null),
      clear: vi.fn(async () => {
        sink.push({ entries: [], commits: [] }); // marker for a cleared state
      }),
    };
  }

  it('persists after every write', async () => {
    const buf = new AuditBuffer();
    buf.setPersistence(persistence);
    const readDisk = async () => undefined;

    await buf.write('a.ts', 'A', readDisk);
    await buf.write('b.ts', 'B', readDisk);

    expect(persistence.save).toHaveBeenCalledTimes(2);
    expect(savedStates[0].entries.map((e) => e.path)).toEqual(['a.ts']);
    expect(savedStates[1].entries.map((e) => e.path)).toEqual(expect.arrayContaining(['a.ts', 'b.ts']));
  });

  it('persists after deleteFile', async () => {
    const buf = new AuditBuffer();
    buf.setPersistence(persistence);
    const readDisk = async () => 'existing content';

    await buf.deleteFile('a.ts', readDisk);

    expect(persistence.save).toHaveBeenCalledTimes(1);
    expect(savedStates[0].entries[0].op).toBe('delete');
  });

  it('calls persistence.clear() when the buffer becomes empty after a flush', async () => {
    const buf = new AuditBuffer();
    buf.setPersistence(persistence);
    await buf.write('a.ts', 'A', async () => undefined);
    persistence.save.mockClear();

    const writeDisk = vi.fn(async () => {});
    const deleteDisk = vi.fn(async () => {});
    await buf.flush(writeDisk, deleteDisk);

    // Flush emptied the buffer → persist() path goes through clear(),
    // not save(), so the on-disk state file gets deleted.
    expect(persistence.clear).toHaveBeenCalledTimes(1);
    expect(persistence.save).not.toHaveBeenCalled();
  });

  it('persists after clear()', async () => {
    const buf = new AuditBuffer();
    buf.setPersistence(persistence);
    await buf.write('a.ts', 'A', async () => undefined);
    persistence.save.mockClear();
    persistence.clear.mockClear();

    buf.clear();
    // clear() persists asynchronously — let microtasks settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(persistence.clear).toHaveBeenCalledTimes(1);
  });

  it('swallows persistence.save errors so a mutation still succeeds', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const buf = new AuditBuffer();
      buf.setPersistence({
        save: vi.fn(async () => {
          throw new Error('disk full');
        }),
        load: vi.fn(async () => null),
        clear: vi.fn(async () => {}),
      });

      // Should not throw, should land in the buffer anyway.
      await expect(buf.write('a.ts', 'A', async () => undefined)).resolves.toBeUndefined();
      expect(buf.has('a.ts')).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        '[AuditBuffer] persist failed (in-memory state retained):',
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('restore() replaces in-memory state without triggering persistence', async () => {
    const buf = new AuditBuffer();
    buf.setPersistence(persistence);

    buf.restore([
      { path: 'recovered.ts', op: 'create', content: 'x', timestamp: 1 },
      { path: 'also.ts', op: 'modify', content: 'y', originalContent: 'z', timestamp: 2 },
    ]);

    expect(buf.size).toBe(2);
    expect(buf.has('recovered.ts')).toBe(true);
    // restore() is intentionally quiet — it's reading from the
    // persisted state, not mutating it, so no save() fires.
    expect(persistence.save).not.toHaveBeenCalled();
  });
});
