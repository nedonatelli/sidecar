import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { workspace } from 'vscode';

// ---------------------------------------------------------------------------
// Per-case workspace sandbox for the agent-loop eval layer.
//
// The existing prompt-only eval harness (prompt.eval.ts) goes directly
// from a system prompt to a model response and doesn't touch the
// filesystem. The agent-loop layer is different — it runs
// `runAgentLoop` which executes real tools (read_file, edit_file,
// grep, etc.) against whatever `workspace.workspaceFolders[0].uri`
// points at, through `workspace.fs.*`. That's the hook we intercept
// here.
//
// What this module does:
//   1. Create a unique temp directory per case (os.tmpdir() is enough
//      — we don't need a git repo or a real VS Code workspace).
//   2. Materialize the case's fixture file map into the temp dir
//      (including mkdir -p for intermediate directories).
//   3. Mutate the vitest vscode mock so `workspace.workspaceFolders`
//      points at the temp dir and `workspace.fs.*` routes through real
//      node:fs operations backed by the temp dir.
//   4. Return a teardown function that restores the mock and
//      recursively removes the temp dir.
//
// Why mutation instead of a dedicated mock variant: the alternative is
// writing a second `__mocks__/vscode.ts` just for eval, but every test
// in the repo already imports the default mock via the vitest alias.
// Scoped mutation keeps one source of truth and lets the sandbox
// cleanly reset to the default shape after each case.
//
// Thread safety: vitest runs test files sequentially by default in the
// forks pool, and `prompt.eval.ts` / `agent.eval.ts` don't parallelize
// within a file, so concurrent mutation isn't a concern today. If we
// ever switch to parallel eval, the sandbox would need per-case
// isolation via something like `vi.stubGlobal` or worker threads.
// ---------------------------------------------------------------------------

/** Files to materialize in the sandbox. Keys are relative paths, values are file contents. */
export type WorkspaceFixture = Record<string, string>;

export interface Sandbox {
  /** Absolute path to the temp dir backing this sandbox. */
  root: string;
  /** Restore the vscode mock to its pre-install state and remove the temp dir. */
  teardown: () => Promise<void>;
  /** Snapshot the current state of every file under the sandbox root (recursive). */
  snapshot: () => Promise<WorkspaceFixture>;
}

interface VscodeWorkspaceMutable {
  workspaceFolders?: unknown;
  fs: {
    readFile: (uri: unknown) => Promise<Uint8Array | Buffer>;
    writeFile: (uri: unknown, content: Uint8Array) => Promise<void>;
    readDirectory: (uri: unknown) => Promise<[string, number][]>;
    stat: (uri: unknown) => Promise<{ type: number; size: number }>;
    rename: (source: unknown, target: unknown, options?: unknown) => Promise<void>;
    createDirectory: (uri: unknown) => Promise<void>;
    delete?: (uri: unknown, options?: unknown) => Promise<void>;
  };
}

const FILE_TYPE_FILE = 1;
const FILE_TYPE_DIRECTORY = 2;

function fsPathOf(uri: unknown): string {
  const u = uri as { fsPath?: string; path?: string };
  return u.fsPath || u.path || String(uri);
}

/**
 * Install a fresh sandbox for one eval case. Materializes the fixture,
 * points the vscode mock at the temp dir, and returns a handle with a
 * teardown hook the caller must invoke in a `finally` block.
 */
export async function installSandbox(fixture: WorkspaceFixture, caseId: string): Promise<Sandbox> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `sidecar-eval-${caseId}-`));

  // Materialize every fixture file, creating intermediate dirs as needed.
  for (const [relPath, content] of Object.entries(fixture)) {
    const abs = path.join(root, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
  }

  // Save originals so teardown can restore them.
  const mutable = workspace as unknown as VscodeWorkspaceMutable;
  const origFolders = mutable.workspaceFolders;
  const origFs = { ...mutable.fs };

  // Point workspace.workspaceFolders at the temp dir so tools that read
  // `workspace.workspaceFolders[0].uri.fsPath` via getRoot() land in the sandbox.
  mutable.workspaceFolders = [{ uri: { fsPath: root, scheme: 'file', path: root }, name: 'eval', index: 0 }];

  // Swap workspace.fs with real-node-fs-backed wrappers. Each wrapper
  // pulls the fsPath out of the uri arg and hands it to node:fs.
  mutable.fs = {
    readFile: async (uri: unknown) => {
      const buf = await fs.readFile(fsPathOf(uri));
      return new Uint8Array(buf);
    },
    writeFile: async (uri: unknown, content: Uint8Array) => {
      const abs = fsPathOf(uri);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    },
    readDirectory: async (uri: unknown) => {
      const entries = await fs.readdir(fsPathOf(uri), { withFileTypes: true });
      return entries.map((e) => [e.name, e.isDirectory() ? FILE_TYPE_DIRECTORY : FILE_TYPE_FILE] as [string, number]);
    },
    stat: async (uri: unknown) => {
      const st = await fs.stat(fsPathOf(uri));
      return { type: st.isDirectory() ? FILE_TYPE_DIRECTORY : FILE_TYPE_FILE, size: st.size };
    },
    rename: async (source: unknown, target: unknown) => {
      await fs.rename(fsPathOf(source), fsPathOf(target));
    },
    createDirectory: async (uri: unknown) => {
      await fs.mkdir(fsPathOf(uri), { recursive: true });
    },
    delete: async (uri: unknown) => {
      await fs.rm(fsPathOf(uri), { recursive: true, force: true });
    },
  };

  return {
    root,
    snapshot: async () => walk(root, root),
    teardown: async () => {
      mutable.workspaceFolders = origFolders;
      mutable.fs = origFs;
      // Best-effort cleanup — don't throw if another process is still
      // holding a file handle (shell session on Windows is the most
      // likely culprit).
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Recursively read every file under `dir`, returning a flat fixture-shaped map. */
async function walk(dir: string, rootForRelative: string): Promise<WorkspaceFixture> {
  const out: WorkspaceFixture = {};
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as Array<{ name: string; isDirectory: () => boolean }>);
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await walk(abs, rootForRelative);
      for (const [k, v] of Object.entries(sub)) out[k] = v;
    } else {
      const rel = path.relative(rootForRelative, abs).split(path.sep).join('/');
      out[rel] = await fs.readFile(abs, 'utf-8').catch(() => '');
    }
  }
  return out;
}
