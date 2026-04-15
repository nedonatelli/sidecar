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
  findFiles?: (
    include: unknown,
    exclude?: unknown,
    maxResults?: number,
  ) => Promise<Array<{ fsPath: string; scheme: string; path: string }>>;
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
  const origFindFiles = mutable.findFiles;

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

  // workspace.findFiles powers the `search_files` tool. The default
  // vscode mock returns [] unconditionally, so search_files always
  // reports "No files found" in the eval harness. Swap in a
  // minimatch-style walker that applies the include glob against
  // every file under the sandbox root and respects the exclude
  // pattern (used to skip node_modules / .git / dist etc. in the
  // real tool). Minimal glob grammar — enough to cover the
  // patterns the agent emits in practice (`**/*.ts`, `src/**/*.test.ts`,
  // `**/README.md`) without pulling in a dependency.
  mutable.findFiles = async (include, exclude, maxResults) => {
    const includePattern = typeof include === 'string' ? include : String(include);
    const excludePattern = typeof exclude === 'string' ? exclude : '';
    const includeRe = globToRegExp(includePattern);
    const excludeRe = excludePattern ? globToRegExp(excludePattern) : null;
    const limit = typeof maxResults === 'number' && maxResults > 0 ? maxResults : 200;

    const results: Array<{ fsPath: string; scheme: string; path: string }> = [];
    for (const relPath of await listAllFiles(root, root)) {
      if (excludeRe && excludeRe.test(relPath)) continue;
      if (!includeRe.test(relPath)) continue;
      const abs = path.join(root, relPath);
      results.push({ fsPath: abs, scheme: 'file', path: abs });
      if (results.length >= limit) break;
    }
    return results;
  };

  return {
    root,
    snapshot: async () => walk(root, root),
    teardown: async () => {
      mutable.workspaceFolders = origFolders;
      mutable.fs = origFs;
      mutable.findFiles = origFindFiles;
      // Best-effort cleanup — don't throw if another process is still
      // holding a file handle (shell session on Windows is the most
      // likely culprit).
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Convert a VS Code style glob to a RegExp that matches a relative
 * path (forward-slash separated). Supports the subset we actually
 * need for eval cases:
 *
 *   `**`                → any path segment(s), including empty
 *   `*`                 → any single segment (no `/`)
 *   `?`                 → any single character
 *   `.`                 → literal `.`
 *   `{a,b}`             → alternation (one level, no nesting)
 *
 * Any other character is matched literally. This is deliberately
 * minimal — for bigger grammars bring in minimatch. The real
 * `workspace.findFiles` supports the full VS Code glob spec; we
 * just cover enough for the tool-use patterns the agent emits.
 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` → any number of path segments (possibly empty)
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 3;
      } else {
        out += '.*';
        i += 2;
      }
    } else if (c === '*') {
      out += '[^/]*';
      i++;
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else if (c === '.') {
      out += '\\.';
      i++;
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        out += '\\{';
        i++;
      } else {
        const inner = glob.slice(i + 1, end);
        out += '(?:' + inner.split(',').join('|') + ')';
        i = end + 1;
      }
    } else if (/[\\^$+|()[\]]/.test(c)) {
      out += '\\' + c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return new RegExp('^' + out + '$');
}

/**
 * Recursively list every file under `dir` as a forward-slash
 * separated relative path from `rootForRelative`. Used by the
 * `findFiles` mock to iterate candidates for glob matching.
 */
async function listAllFiles(dir: string, rootForRelative: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => [] as Array<{ name: string; isDirectory: () => boolean }>);
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await listAllFiles(abs, rootForRelative);
      for (const s of sub) out.push(s);
    } else {
      out.push(path.relative(rootForRelative, abs).split(path.sep).join('/'));
    }
  }
  return out;
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
