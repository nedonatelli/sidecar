import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditBuffer, AuditFlushError, type ReadDiskFn, type WriteDiskFn, type DeleteDiskFn } from './auditBuffer.js';

describe('AuditBuffer', () => {
  let buf: AuditBuffer;
  // Canonical disk state used by most tests — the mock readDisk
  // resolves to these values, and assertions verify that write/delete
  // did NOT touch real disk (we only assert against the mocks' calls).
  let disk: Map<string, string>;
  // Type the mocks as the AuditBuffer's public function-type aliases so
  // they're directly assignable to the buffer method parameters; the
  // bare `ReturnType<typeof vi.fn>` type erases the signature and tsc
  // rejects assignment.
  let readDisk: ReadDiskFn & ReturnType<typeof vi.fn>;
  let writeDisk: WriteDiskFn & ReturnType<typeof vi.fn>;
  let deleteDisk: DeleteDiskFn & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    buf = new AuditBuffer();
    disk = new Map([['existing.ts', 'original content']]);
    readDisk = vi.fn(async (path: string) => disk.get(path)) as typeof readDisk;
    writeDisk = vi.fn(async (path: string, content: string) => {
      disk.set(path, content);
    }) as typeof writeDisk;
    deleteDisk = vi.fn(async (path: string) => {
      disk.delete(path);
    }) as typeof deleteDisk;
  });

  describe('write', () => {
    it('records a new-file write as op=create with no originalContent', async () => {
      await buf.write('new.ts', 'hello', readDisk);
      const entries = buf.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe('new.ts');
      expect(entries[0].op).toBe('create');
      expect(entries[0].content).toBe('hello');
      expect(entries[0].originalContent).toBeUndefined();
    });

    it('records an existing-file overwrite as op=modify with captured originalContent', async () => {
      await buf.write('existing.ts', 'new content', readDisk);
      const entry = buf.list()[0];
      expect(entry.op).toBe('modify');
      expect(entry.originalContent).toBe('original content');
      expect(entry.content).toBe('new content');
    });

    it('preserves originalContent across multiple edits of the same file', async () => {
      await buf.write('existing.ts', 'edit 1', readDisk);
      await buf.write('existing.ts', 'edit 2', readDisk);
      await buf.write('existing.ts', 'edit 3', readDisk);
      const entry = buf.list()[0];
      // Three writes; baseline captured once; final content reflects
      // the last write.
      expect(entry.op).toBe('modify');
      expect(entry.content).toBe('edit 3');
      expect(entry.originalContent).toBe('original content');
      // Only ONE disk read was needed (first call captured the baseline).
      expect(readDisk).toHaveBeenCalledTimes(1);
    });

    it('never touches disk during a write', async () => {
      await buf.write('a.ts', 'body', readDisk);
      expect(writeDisk).not.toHaveBeenCalled();
      expect(deleteDisk).not.toHaveBeenCalled();
      // Real "disk" state must be untouched.
      expect(disk.has('a.ts')).toBe(false);
    });
  });

  describe('deleteFile', () => {
    it('records a delete against an existing file', async () => {
      await buf.deleteFile('existing.ts', readDisk);
      const entry = buf.list()[0];
      expect(entry.op).toBe('delete');
      expect(entry.originalContent).toBe('original content');
      expect(entry.content).toBeUndefined();
    });

    it('collapses create-then-delete into a no-op (buffer becomes empty)', async () => {
      await buf.write('new.ts', 'x', readDisk);
      await buf.deleteFile('new.ts', readDisk);
      expect(buf.size).toBe(0);
      expect(buf.isEmpty).toBe(true);
    });

    it('overrides modify → delete so a flush removes the file', async () => {
      await buf.write('existing.ts', 'edited', readDisk);
      await buf.deleteFile('existing.ts', readDisk);
      const entry = buf.list()[0];
      expect(entry.op).toBe('delete');
      // originalContent preserved from the earlier modify, so rollback
      // would restore the pre-edit content if flush fails later.
      expect(entry.originalContent).toBe('original content');
    });
  });

  describe('read (read-through)', () => {
    it('returns buffered content for a modified file', async () => {
      await buf.write('existing.ts', 'buffered', readDisk);
      const r = buf.read('existing.ts');
      expect(r).toEqual({ content: 'buffered', deleted: false, buffered: true });
    });

    it('returns buffered content for a newly created file', async () => {
      await buf.write('new.ts', 'fresh', readDisk);
      const r = buf.read('new.ts');
      expect(r).toEqual({ content: 'fresh', deleted: false, buffered: true });
    });

    it('flags deleted files so callers can emit a "not found" for the agent', async () => {
      await buf.deleteFile('existing.ts', readDisk);
      const r = buf.read('existing.ts');
      expect(r.deleted).toBe(true);
      expect(r.buffered).toBe(true);
      expect(r.content).toBeUndefined();
    });

    it('returns buffered=false for paths not in the buffer', () => {
      const r = buf.read('unbuffered.ts');
      expect(r.buffered).toBe(false);
      expect(r.deleted).toBe(false);
      expect(r.content).toBeUndefined();
    });
  });

  describe('flush — happy path', () => {
    it('writes every create and modify entry to disk and clears the buffer', async () => {
      await buf.write('a.ts', 'content-a', readDisk);
      await buf.write('b.ts', 'content-b', readDisk);

      const result = await buf.flush(writeDisk, deleteDisk);

      expect(result.applied).toEqual(expect.arrayContaining(['a.ts', 'b.ts']));
      expect(writeDisk).toHaveBeenCalledWith('a.ts', 'content-a');
      expect(writeDisk).toHaveBeenCalledWith('b.ts', 'content-b');
      expect(buf.isEmpty).toBe(true);
    });

    it('deletes entries go through deleteDisk, not writeDisk', async () => {
      await buf.deleteFile('existing.ts', readDisk);
      const result = await buf.flush(writeDisk, deleteDisk);

      expect(result.applied).toEqual(['existing.ts']);
      expect(deleteDisk).toHaveBeenCalledWith('existing.ts');
      expect(writeDisk).not.toHaveBeenCalled();
    });

    it('flushes only the requested subset when paths is provided', async () => {
      await buf.write('a.ts', 'A', readDisk);
      await buf.write('b.ts', 'B', readDisk);
      await buf.write('c.ts', 'C', readDisk);

      const result = await buf.flush(writeDisk, deleteDisk, ['a.ts', 'c.ts']);

      expect(result.applied).toEqual(expect.arrayContaining(['a.ts', 'c.ts']));
      expect(result.applied).not.toContain('b.ts');
      expect(writeDisk).toHaveBeenCalledWith('a.ts', 'A');
      expect(writeDisk).toHaveBeenCalledWith('c.ts', 'C');
      expect(writeDisk).not.toHaveBeenCalledWith('b.ts', expect.anything());
      // b.ts stays pending.
      expect(buf.has('b.ts')).toBe(true);
    });
  });

  describe('flush — failure & rollback', () => {
    it('rolls back applied writes when a later write throws', async () => {
      await buf.write('a.ts', 'A-new', readDisk);
      await buf.write('existing.ts', 'existing-new', readDisk);
      await buf.write('b.ts', 'B-new', readDisk);

      // Simulate a disk failure on b.ts specifically. Insert the fail
      // on the THIRD write call (a.ts and existing.ts succeed first).
      let callCount = 0;
      const failingWrite = vi.fn(async (path: string, content: string) => {
        callCount += 1;
        if (callCount === 3) throw new Error('disk full');
        disk.set(path, content);
      });

      await expect(buf.flush(failingWrite, deleteDisk)).rejects.toBeInstanceOf(AuditFlushError);

      // Rollback: existing.ts should be back to 'original content'
      // (restored from originalContent), and a.ts should be deleted
      // since it was a create.
      expect(disk.get('existing.ts')).toBe('original content');
      expect(deleteDisk).toHaveBeenCalledWith('a.ts');
    });

    it('AuditFlushError carries the applied and failed lists', async () => {
      await buf.write('ok.ts', 'x', readDisk);
      const failingWrite = vi.fn(async (path: string) => {
        if (path === 'bad.ts') throw new Error('perm denied');
        disk.set(path, 'x');
      });
      await buf.write('bad.ts', 'x', readDisk);

      try {
        await buf.flush(failingWrite, deleteDisk);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AuditFlushError);
        const afe = err as AuditFlushError;
        expect(afe.applied).toContain('ok.ts');
        expect(afe.failed[0].path).toBe('bad.ts');
        expect(afe.failed[0].error).toContain('perm denied');
      }
    });
  });

  describe('clear', () => {
    it('drops every entry when called with no arguments', async () => {
      await buf.write('a.ts', 'A', readDisk);
      await buf.write('b.ts', 'B', readDisk);
      buf.clear();
      expect(buf.isEmpty).toBe(true);
    });

    it('drops only the named entries when paths is supplied', async () => {
      await buf.write('a.ts', 'A', readDisk);
      await buf.write('b.ts', 'B', readDisk);
      await buf.write('c.ts', 'C', readDisk);
      buf.clear(['a.ts', 'c.ts']);
      expect(buf.has('a.ts')).toBe(false);
      expect(buf.has('b.ts')).toBe(true);
      expect(buf.has('c.ts')).toBe(false);
    });

    it('does not touch disk', async () => {
      await buf.write('a.ts', 'A', readDisk);
      buf.clear();
      expect(writeDisk).not.toHaveBeenCalled();
      expect(deleteDisk).not.toHaveBeenCalled();
    });
  });
});
