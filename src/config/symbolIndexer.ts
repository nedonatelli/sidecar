/**
 * Orchestrates building and maintaining the SymbolGraph.
 * Handles initial indexing, incremental updates, and persistence to .sidecar/cache/.
 */

import { workspace, Uri, Disposable } from 'vscode';
import { logger } from '../system/logger.js';
import * as path from 'path';
import { SimpleCodeAnalyzer } from '../astContext.js';
import { getAnalyzer } from '../parsing/registry.js';
import {
  SymbolGraph,
  type SymbolEntry,
  type ImportEdge,
  type CallEdge,
  type TypeEdge,
  type TypeUseEdge,
} from './symbolGraph.js';
import type { SidecarDir } from './sidecarDir.js';
import { assignOrdinals, makeSymbolId, type SymbolEmbeddingIndex } from './symbolEmbeddingIndex.js';
import {
  INDEX_EXCLUDE_DIRS,
  INDEX_EXCLUDE_PATTERN,
  INDEX_MAX_FILES_PER_PATTERN,
  indexScanTruncated,
} from './indexExcludes.js';

const CACHE_FILE = 'cache/symbol-graph.json';
const MAX_FILE_SIZE = 100 * 1024; // 100KB
const MAX_JSON_SIZE = 50 * 1024 * 1024; // 50MB persistence limit

/** Outcome of `replaySymbolsToEmbeddingIndex` — used to log real numbers (and
 *  warn on a surprising zero) rather than the graph's symbol count. */
export interface ReplayResult {
  queued: number;
  filesRead: number;
  filesSkipped: number;
}
const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.kts',
  '.cs',
  '.rb',
  '.swift',
  '.c',
  '.h',
  '.cpp',
  '.cc',
  '.cxx',
  '.hpp',
  '.hh',
  '.sh',
  '.bash',
  '.zsh',
  '.php',
  '.lua',
  '.scala',
  '.dart',
  '.vue',
]);

const EXCLUDE_DIRS = new Set<string>(INDEX_EXCLUDE_DIRS);

export class SymbolIndexer implements Disposable {
  private graph = new SymbolGraph();
  private sidecarDir: SidecarDir | null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUpdates = new Set<string>();
  private pendingDeletes = new Set<string>();
  private rootPath = '';
  /**
   * Optional PKI symbol-embedding index. When wired, each
   * `indexFile` pass feeds every extracted symbol's body through the
   * embedder queue so semantic search has per-symbol vectors. Keeps
   * the graph's structural role unchanged — the graph still answers
   * "who calls what," the embedder just adds "what's semantically
   * similar to X" as a parallel capability.
   */
  private symbolEmbeddings: SymbolEmbeddingIndex | null = null;
  /** Cap on symbols fed to the embedder per file — see
   *  `sidecar.projectKnowledge.maxSymbolsPerFile`. Set via `setSymbolEmbeddings`
   *  when the embedder is wired; default stays wide enough that normal
   *  files aren't truncated. */
  private maxSymbolsPerFile = 500;

  constructor(sidecarDir: SidecarDir | null) {
    this.sidecarDir = sidecarDir;
  }

  /**
   * Attach a `SymbolEmbeddingIndex` so the indexer starts feeding it
   * per-symbol bodies on every parsed file. Optional —
   * passing `null` (or never calling this) preserves the pre-PKI
   * behavior where symbol embeddings are never computed. Changing
   * the reference mid-session is supported for tests.
   */
  setSymbolEmbeddings(index: SymbolEmbeddingIndex | null, maxSymbolsPerFile = 500): void {
    this.symbolEmbeddings = index;
    this.maxSymbolsPerFile = Math.max(1, maxSymbolsPerFile);
  }

  /**
   * Build the symbol graph for the workspace.
   * Tries to restore from cache first, then incrementally updates stale files.
   */
  async initialize(filePatterns: string[]): Promise<void> {
    const folders = workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;

    this.rootPath = folders[0].uri.fsPath;

    // Try to restore from cache
    const restored = await this.restore();

    // Discover workspace files — all patterns in parallel
    const excludePattern = INDEX_EXCLUDE_PATTERN;
    const foundUris = await Promise.all(
      filePatterns.map((pattern) => workspace.findFiles(pattern, excludePattern, INDEX_MAX_FILES_PER_PATTERN)),
    );
    const allUris: Uri[] = [];
    for (const [i, uris] of foundUris.entries()) {
      // findFiles truncates at maxResults and returns no indication that it
      // did. At the previous limit of 1000 against this repo's 1035 `.ts`
      // files, every run dropped a different ~35 of them and reported success.
      const warning = indexScanTruncated('symbolIndexer', filePatterns[i], uris.length);
      if (warning) logger.warn(warning);
      allUris.push(...uris);
    }

    // Filter to code files
    const codeUris = allUris.filter((uri) => {
      const ext = path.extname(uri.fsPath).toLowerCase();
      return CODE_EXTENSIONS.has(ext);
    });

    // Stat + read + parse all files concurrently. Each callback is
    // synchronous after its awaits, so graph mutations don't race.
    let parsed = 0;
    await Promise.allSettled(
      codeUris.map(async (uri) => {
        const relativePath = path.relative(this.rootPath, uri.fsPath);
        const stat = await workspace.fs.stat(uri);
        const hash = `${stat.size}:${stat.mtime}`;
        if (restored && this.graph.getFileHash(relativePath) === hash) return;
        const bytes = await workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString('utf-8');
        if (content.length > MAX_FILE_SIZE) return;
        await this.indexFile(relativePath, content, hash);
        parsed++;
      }),
    );

    // Remove files that no longer exist
    if (restored) {
      const currentFiles = new Set(codeUris.map((u) => path.relative(this.rootPath, u.fsPath)));
      for (const indexed of Object.entries(this.graph.toJSON().fileHashes)) {
        if (!currentFiles.has(indexed[0])) {
          this.graph.removeFile(indexed[0]);
        }
      }
    }

    // Persist if we did work
    if (parsed > 0 || !restored) {
      await this.persist();
    }
  }

  /** Parse a single file and add its symbols/imports to the graph. Uses
   *  tree-sitter when a grammar is available for the extension (AST-accurate
   *  call/type edges for TS/JS), falling back to the regex analyzer otherwise. */
  private async indexFile(relativePath: string, content: string, hash: string): Promise<void> {
    const ext = path.extname(relativePath).slice(1).toLowerCase();
    const analyzer = await getAnalyzer(ext);
    const parsed = analyzer.parseFileContent(relativePath, content);

    const symbols: SymbolEntry[] = [];
    const imports: ImportEdge[] = [];

    for (const el of parsed.elements) {
      if (el.type === 'import') {
        // Resolve the import path
        const resolved = SimpleCodeAnalyzer.resolveImportPath(relativePath, el.name);
        if (resolved) {
          imports.push({
            fromFile: relativePath,
            toFile: resolved,
            importedNames: el.bindings || [],
          });
        }
      } else if (
        el.type === 'function' ||
        el.type === 'class' ||
        el.type === 'method' ||
        el.type === 'interface' ||
        el.type === 'type' ||
        el.type === 'enum' ||
        el.type === 'variable'
      ) {
        symbols.push({
          name: el.name,
          qualifiedName: el.name,
          type: el.type,
          filePath: relativePath,
          startLine: el.startLine,
          endLine: el.endLine,
          exported: el.exported ?? false,
        });
      }
    }

    // Map parsed calls/type relations to graph edge types
    const calls: CallEdge[] = (parsed.calls || []).map((c) => ({
      callerFile: relativePath,
      callerName: c.callerName,
      calleeName: c.calleeName,
      line: c.line,
    }));
    const typeEdges: TypeEdge[] = (parsed.typeRelations || []).map((r) => ({
      childFile: relativePath,
      childName: r.childName,
      parentName: r.parentName,
      kind: r.kind,
    }));
    const typeUses: TypeUseEdge[] = (parsed.typeUses || []).map((u) => ({
      userFile: relativePath,
      userName: u.userName,
      typeName: u.typeName,
      role: u.role,
      line: u.line,
    }));

    // addFile() clears any prior fileContents for this path (via removeFile),
    // so the content MUST be stored after it — otherwise getFileContent is
    // wiped and reference search / source readers fall back to disk needlessly.
    this.graph.addFile(relativePath, symbols, imports, hash, calls, typeEdges, typeUses);
    this.graph.setFileContent(relativePath, content);

    // PKI b.2: feed each symbol's body into the embedding queue so
    // semantic search can rank at symbol granularity. Skipped when
    // no index is wired (pre-PKI behavior). Body extraction slices
    // the file content by 1-based line range; we cap to 400 lines
    // per symbol as a defense against pathologically large blocks,
    // and cap total symbols per file via the `maxSymbolsPerFile`
    // setting so a generated file with 50k declarations can't
    // monopolize the embedder.
    if (this.symbolEmbeddings) {
      const lines = content.split('\n');
      const limited = this.cappedSymbols(symbols);
      const ordinals = assignOrdinals(limited.map((s) => s.qualifiedName));
      for (const [i, sym] of limited.entries()) {
        const startIdx = Math.max(0, sym.startLine - 1);
        const endIdx = Math.min(lines.length, sym.endLine);
        if (endIdx <= startIdx) continue;
        const body = lines.slice(startIdx, Math.min(endIdx, startIdx + 400)).join('\n');
        if (!body.trim()) continue;
        this.symbolEmbeddings.queueSymbol({
          filePath: relativePath,
          qualifiedName: sym.qualifiedName,
          name: sym.name,
          kind: sym.type,
          startLine: sym.startLine,
          endLine: sym.endLine,
          body,
          ordinal: ordinals[i],
        });
      }
    }
  }

  /** Update a single file incrementally. */
  async updateFile(relativePath: string): Promise<void> {
    if (this.shouldExclude(relativePath)) return;
    const ext = path.extname(relativePath).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) return;

    const folders = workspace.workspaceFolders;
    if (!folders) return;

    try {
      const uri = Uri.joinPath(folders[0].uri, relativePath);
      const stat = await workspace.fs.stat(uri);
      const hash = `${stat.size}:${stat.mtime}`;

      if (this.graph.getFileHash(relativePath) === hash) return;

      const bytes = await workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString('utf-8');
      if (content.length > MAX_FILE_SIZE) return;

      await this.indexFile(relativePath, content, hash);
      this.schedulePersist();
    } catch {
      // File unreadable — remove from graph
      this.graph.removeFile(relativePath);
    }
  }

  /** Remove a file from the graph (and from the symbol-embedding
   *  index when one is wired). */
  removeFileFromGraph(relativePath: string): void {
    this.graph.removeFile(relativePath);
    this.symbolEmbeddings?.removeFile(relativePath);
    this.schedulePersist();
  }

  /** Queue an incremental file update (debounced). */
  queueUpdate(relativePath: string): void {
    this.pendingUpdates.add(relativePath);
    this.pendingDeletes.delete(relativePath);
    this.scheduleFlush();
  }

  /**
   * Feed all already-indexed symbols into the embedding queue. Called when
   * PKI is wired after the symbol graph is already built — `queueUpdate`
   * would hit the hash-match short-circuit and skip every file, leaving
   * symbols queued but never embedded.
   *
   * The graph's in-memory `fileContents` map is only populated when a file
   * is freshly parsed this session. On a warm reload the graph is restored
   * from `symbol-graph.json` — which persists symbols + hashes but NOT file
   * contents (see SymbolGraph.toJSON) — so `getFileContent` is empty for
   * every unchanged file and the replay would queue nothing. When the cached
   * content is missing we read the file from disk so the embedding store gets
   * rebuilt across reloads, not just for files edited this session.
   */
  async replaySymbolsToEmbeddingIndex(): Promise<ReplayResult> {
    const embeddings = this.symbolEmbeddings;
    if (!embeddings) return { queued: 0, filesRead: 0, filesSkipped: 0 };
    const rootUri = workspace.workspaceFolders?.[0]?.uri;
    let queued = 0;
    let filesRead = 0;
    let filesSkipped = 0;
    await Promise.allSettled(
      Array.from(this.graph.indexedFilePaths()).map(async (filePath) => {
        let content = this.graph.getFileContent(filePath);
        if (!content && rootUri) {
          try {
            const bytes = await workspace.fs.readFile(Uri.joinPath(rootUri, filePath));
            content = Buffer.from(bytes).toString('utf-8');
            if (content.length > MAX_FILE_SIZE) {
              filesSkipped++;
              return;
            }
          } catch {
            filesSkipped++;
            return;
          }
        }
        if (!content) {
          filesSkipped++;
          return;
        }
        filesRead++;
        const limited = this.cappedSymbols(this.graph.getSymbolsInFile(filePath));
        const ordinals = assignOrdinals(limited.map((s) => s.qualifiedName));
        const lines = content.split('\n');
        for (const [i, sym] of limited.entries()) {
          const startIdx = Math.max(0, sym.startLine - 1);
          const endIdx = Math.min(lines.length, sym.endLine);
          if (endIdx <= startIdx) continue;
          const body = lines.slice(startIdx, Math.min(endIdx, startIdx + 400)).join('\n');
          if (!body.trim()) continue;
          embeddings.queueSymbol({
            filePath,
            qualifiedName: sym.qualifiedName,
            name: sym.name,
            kind: sym.type,
            startLine: sym.startLine,
            endLine: sym.endLine,
            body,
            ordinal: ordinals[i],
          });
          queued++;
        }
      }),
    );
    return { queued, filesRead, filesSkipped };
  }

  /** The symbols of one file that are eligible for embedding, in document
   *  order. Capped so a generated file with 50k declarations can't monopolize
   *  the embedder — and applied identically everywhere, because the cap is
   *  part of what fixes a symbol's ordinal. */
  private cappedSymbols(symbols: SymbolEntry[]): SymbolEntry[] {
    const cap = this.maxSymbolsPerFile;
    return symbols.length > cap ? symbols.slice(0, cap) : symbols;
  }

  /**
   * Every symbol ID the graph currently justifies, for `SymbolEmbeddingIndex.
   * reconcile`. Anything in the index and not in here is an orphan.
   *
   * Deliberately derived from the same `cappedSymbols` + `assignOrdinals` pair
   * the two queueing paths use: if this set and those disagreed by a single
   * ordinal, reconcile would delete live rows that the next replay re-embeds,
   * every start, forever. It is a superset of what's actually indexed — the
   * queue paths additionally skip empty bodies — and a superset is safe here,
   * since only absence from this set deletes anything.
   */
  liveSymbolIds(): Set<string> {
    const ids = new Set<string>();
    for (const filePath of this.graph.indexedFilePaths()) {
      const limited = this.cappedSymbols(this.graph.getSymbolsInFile(filePath));
      const ordinals = assignOrdinals(limited.map((s) => s.qualifiedName));
      for (const [i, sym] of limited.entries()) {
        ids.add(makeSymbolId(filePath, sym.qualifiedName, ordinals[i]));
      }
    }
    return ids;
  }

  /** Queue a file removal (debounced). */
  queueDelete(relativePath: string): void {
    this.pendingDeletes.add(relativePath);
    this.pendingUpdates.delete(relativePath);
    this.scheduleFlush();
  }

  /** Flush pending updates after a debounce period. */
  private scheduleFlush(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(async () => {
      this.updateTimer = null;
      const updates = [...this.pendingUpdates];
      const deletes = [...this.pendingDeletes];
      this.pendingUpdates.clear();
      this.pendingDeletes.clear();

      for (const del of deletes) {
        this.graph.removeFile(del);
        this.symbolEmbeddings?.removeFile(del);
      }
      await Promise.allSettled(updates.map((upd) => this.updateFile(upd)));
      if (updates.length > 0 || deletes.length > 0) {
        this.schedulePersist();
      }
    }, 500);
  }

  /** Save the graph to .sidecar/cache/. */
  async persist(): Promise<void> {
    if (!this.sidecarDir) return;
    try {
      const data = this.graph.toJSON();
      const json = JSON.stringify(data);
      if (json.length > MAX_JSON_SIZE) {
        logger.warn('[SideCar] Symbol graph too large to persist, skipping');
        return;
      }
      await this.sidecarDir.writeText(CACHE_FILE, json);
    } catch (err) {
      logger.warn('[SideCar] Failed to persist symbol graph:', err);
    }
  }

  /** Load the graph from .sidecar/cache/. Returns true if successful. */
  private async restore(): Promise<boolean> {
    if (!this.sidecarDir) return false;
    try {
      const text = await this.sidecarDir.readText(CACHE_FILE);
      if (!text) return false;
      const data = JSON.parse(text);
      const restored = SymbolGraph.fromJSON(data);
      if (restored) {
        this.graph = restored;
        return true;
      }
    } catch {
      // Corrupted or missing — rebuild from scratch
    }
    return false;
  }

  /** Debounced persistence to avoid disk thrashing. */
  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, 30000); // 30 seconds
  }

  getGraph(): SymbolGraph {
    return this.graph;
  }

  private shouldExclude(relativePath: string): boolean {
    return relativePath.split(path.sep).some((p) => EXCLUDE_DIRS.has(p));
  }

  dispose(): void {
    // Cancel both debounce timers, then flush whatever the in-memory index
    // currently holds. If only persistTimer was set (correct path) this is
    // equivalent to the old early-persist. If only updateTimer was set (pending
    // incremental updates that hadn't drained yet) we still get a persist
    // rather than silently losing those edits on shutdown.
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    void this.persist();
  }
}
