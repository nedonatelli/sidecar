import { workspace, Uri } from 'vscode';
import type { AuditBufferPersistence, BufferedChange } from './auditBuffer.js';

/**
 * Filesystem-backed persistence for `AuditBuffer` (v0.61 a.3). Saves
 * the full buffer snapshot to `.sidecar/audit-buffer/state.json` on
 * every mutation; loads it once at activation so pending agent work
 * survives extension reloads, window reloads, and VS Code restarts.
 *
 * The serialization is a single-file overwrite rather than an
 * append-only journal because buffers are small (tens of entries
 * typically, each a modest file-content string) and the whole-file
 * rewrite is atomic enough via `workspace.fs.writeFile`. An
 * append-only journal would let us replay every mutation across a
 * crash, but the extra complexity doesn't buy much — if VS Code
 * crashes mid-write, the worst case is we lose the most recent
 * mutation, which the agent will promptly re-issue when the user
 * re-runs the task.
 */

/**
 * Wire-format version. Bumped when the on-disk shape changes so
 * future code can migrate or ignore older states rather than
 * silently mis-parsing them.
 */
const SCHEMA_VERSION = 1;

interface PersistedState {
  version: number;
  savedAt: number;
  entries: BufferedChange[];
}

/**
 * Hard cap on persisted file size. If the agent somehow accumulated a
 * gigabyte of buffered content (runaway edit loop on a huge repo), we
 * bail on persistence rather than write 1 GB of JSON on every
 * subsequent mutation. The in-memory buffer still works; next
 * activation just won't find a state file to recover from.
 */
const MAX_PERSIST_BYTES = 64 * 1024 * 1024;

/**
 * Produce the persistence shim `AuditBuffer.setPersistence()` wants.
 * Resolves file URIs lazily against the first workspace folder so a
 * multi-root workspace still persists deterministically — we pin to
 * `workspaceFolders[0]` to match every other `.sidecar/` consumer
 * (SidecarDir, workspaceIndex, symbolIndexer) rather than inventing
 * a different choice here.
 */
export function createWorkspaceAuditBufferPersistence(): AuditBufferPersistence {
  return {
    async save(entries) {
      const stateUri = resolveStateUri();
      if (!stateUri) return; // no workspace — silent no-op (matches SidecarDir's fail-closed)

      const payload: PersistedState = { version: SCHEMA_VERSION, savedAt: Date.now(), entries };
      const serialized = Buffer.from(JSON.stringify(payload), 'utf-8');
      if (serialized.byteLength > MAX_PERSIST_BYTES) {
        console.warn(
          `[AuditBuffer persistence] refusing to persist ${serialized.byteLength} bytes (> ${MAX_PERSIST_BYTES} cap).`,
        );
        return;
      }

      // Ensure parent exists; `workspace.fs.createDirectory` is
      // idempotent so re-calling on every save is fine.
      const dirUri = Uri.joinPath(stateUri, '..');
      await workspace.fs.createDirectory(dirUri);
      await workspace.fs.writeFile(stateUri, serialized);
    },

    async load() {
      const stateUri = resolveStateUri();
      if (!stateUri) return null;

      let bytes: Uint8Array;
      try {
        bytes = await workspace.fs.readFile(stateUri);
      } catch {
        return null; // no persisted state yet
      }

      try {
        const parsed = JSON.parse(Buffer.from(bytes).toString('utf-8')) as PersistedState;
        if (parsed.version !== SCHEMA_VERSION) {
          console.warn(
            `[AuditBuffer persistence] schema mismatch (persisted v${parsed.version}, expected v${SCHEMA_VERSION}); discarding.`,
          );
          return null;
        }
        // Sanity-check shape — reject anything that doesn't smell
        // like a BufferedChange array. Prevents a corrupted file from
        // crashing activation.
        if (!Array.isArray(parsed.entries)) return null;
        return parsed.entries.filter(isBufferedChange);
      } catch (err) {
        console.warn('[AuditBuffer persistence] failed to parse state file:', err);
        return null;
      }
    },

    async clear() {
      const stateUri = resolveStateUri();
      if (!stateUri) return;
      try {
        await workspace.fs.delete(stateUri, { useTrash: false });
      } catch {
        // Already gone — fine.
      }
    },
  };
}

/**
 * Workspace-root-pinned URI for the buffer state file. Returns null
 * when no workspace is open (e.g. VS Code launched with just an
 * untitled editor), in which case every persistence method becomes a
 * no-op so the buffer still works in memory.
 */
function resolveStateUri(): Uri | null {
  const rootUri = workspace.workspaceFolders?.[0]?.uri;
  if (!rootUri) return null;
  return Uri.joinPath(rootUri, '.sidecar', 'audit-buffer', 'state.json');
}

/**
 * Narrow check that a decoded JSON object has the fields
 * `BufferedChange` requires. Loose — we don't re-validate every
 * field's exact type because the file came from our own serializer
 * and schema-version-bumping protects against older shapes.
 */
function isBufferedChange(x: unknown): x is BufferedChange {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.path === 'string' &&
    (r.op === 'create' || r.op === 'modify' || r.op === 'delete') &&
    typeof r.timestamp === 'number'
  );
}
