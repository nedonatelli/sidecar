import { workspace, Uri } from 'vscode';
import type { AuditBufferPersistence, BufferedChange, BufferedCommit } from './auditBuffer.js';

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
/**
 * Schema v1 — v0.61 a.3. Shape: `{ entries: BufferedChange[] }`.
 * Schema v2 — v0.61 a.4. Envelope adds `commits: BufferedCommit[]`
 * so buffered git commits survive reloads alongside file writes.
 * Older v1 files are migrated on load (commits default to []).
 */
const SCHEMA_VERSION = 2;

interface PersistedStateV1 {
  version: 1;
  savedAt: number;
  entries: BufferedChange[];
}

interface PersistedStateV2 {
  version: 2;
  savedAt: number;
  entries: BufferedChange[];
  commits: BufferedCommit[];
}

type PersistedStateAny = PersistedStateV1 | PersistedStateV2;

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
    async save(snapshot) {
      const stateUri = resolveStateUri();
      if (!stateUri) return; // no workspace — silent no-op (matches SidecarDir's fail-closed)

      const payload: PersistedStateV2 = {
        version: 2,
        savedAt: Date.now(),
        entries: snapshot.entries,
        commits: snapshot.commits,
      };
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
        const parsed = JSON.parse(Buffer.from(bytes).toString('utf-8')) as PersistedStateAny;
        // Migrate v1 → v2 by defaulting commits to []. Anything
        // else is discarded with a warning.
        if (parsed.version === 1) {
          if (!Array.isArray(parsed.entries)) return null;
          return { entries: parsed.entries.filter(isBufferedChange), commits: [] };
        }
        if (parsed.version === 2) {
          if (!Array.isArray(parsed.entries)) return null;
          return {
            entries: parsed.entries.filter(isBufferedChange),
            commits: Array.isArray(parsed.commits) ? parsed.commits.filter(isBufferedCommit) : [],
          };
        }
        console.warn(
          `[AuditBuffer persistence] schema mismatch (persisted v${(parsed as { version: unknown }).version}, expected v${SCHEMA_VERSION}); discarding.`,
        );
        return null;
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

function isBufferedCommit(x: unknown): x is BufferedCommit {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return typeof r.message === 'string' && typeof r.timestamp === 'number';
}
