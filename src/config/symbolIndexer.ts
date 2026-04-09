/**
 * Orchestrates building and maintaining the SymbolGraph.
 * Handles initial indexing, incremental updates, and persistence to .sidecar/cache/.
 */

import { workspace, Uri, Disposable } from 'vscode';
import * as path from 'path';
import { SimpleCodeAnalyzer } from '../astContext.js';
import { getRegexAnalyzer } from '../parsing/registry.js';
import { SymbolGraph, type SymbolEntry, type ImportEdge } from './symbolGraph.js';
import type { SidecarDir } from './sidecarDir.js';

const CACHE_FILE = 'cache/symbol-graph.json';
const MAX_FILE_SIZE = 100 * 1024; // 100KB
const MAX_JSON_SIZE = 5 * 1024 * 1024; // 5MB persistence limit
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.kt']);

const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.sidecar',
  'coverage',
  'out',
  'dist',
  'build',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.turbo',
  '.cache',
]);

export class SymbolIndexer implements Disposable {
  private graph = new SymbolGraph();
  private sidecarDir: SidecarDir | null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUpdates = new Set<string>();
  private pendingDeletes = new Set<string>();
  private rootPath = '';

  constructor(sidecarDir: SidecarDir | null) {
    this.sidecarDir = sidecarDir;
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

    // Discover workspace files
    const allUris: Uri[] = [];
    const excludePattern = `**/{${[...EXCLUDE_DIRS].join(',')}}/**`;
    for (const pattern of filePatterns) {
      const uris = await workspace.findFiles(pattern, excludePattern, 1000);
      allUris.push(...uris);
    }

    // Filter to code files
    const codeUris = allUris.filter((uri) => {
      const ext = path.extname(uri.fsPath).toLowerCase();
      return CODE_EXTENSIONS.has(ext);
    });

    // Process files — skip unchanged ones if we restored from cache
    let parsed = 0;
    const batchSize = 20;
    for (let i = 0; i < codeUris.length; i += batchSize) {
      const batch = codeUris.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (uri) => {
          const relativePath = path.relative(this.rootPath, uri.fsPath);
          const stat = await workspace.fs.stat(uri);

          // Fast hash: size + mtime
          const hash = `${stat.size}:${stat.mtime}`;
          if (restored && this.graph.getFileHash(relativePath) === hash) {
            return; // unchanged
          }

          // Read and parse
          const bytes = await workspace.fs.readFile(uri);
          const content = Buffer.from(bytes).toString('utf-8');
          if (content.length > MAX_FILE_SIZE) return;

          this.indexFile(relativePath, content, hash);
          parsed++;
        }),
      );

      // Log errors but don't abort
      for (const r of results) {
        if (r.status === 'rejected') {
          // skip unreadable files
        }
      }
    }

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

  /** Parse a single file and add its symbols/imports to the graph. */
  private indexFile(relativePath: string, content: string, hash: string): void {
    const analyzer = getRegexAnalyzer();
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

    // Store content for reference searching
    this.graph.setFileContent(relativePath, content);
    this.graph.addFile(relativePath, symbols, imports, hash);
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

      this.indexFile(relativePath, content, hash);
      this.schedulePersist();
    } catch {
      // File unreadable — remove from graph
      this.graph.removeFile(relativePath);
    }
  }

  /** Remove a file from the graph. */
  removeFileFromGraph(relativePath: string): void {
    this.graph.removeFile(relativePath);
    this.schedulePersist();
  }

  /** Queue an incremental file update (debounced). */
  queueUpdate(relativePath: string): void {
    this.pendingUpdates.add(relativePath);
    this.pendingDeletes.delete(relativePath);
    this.scheduleFlush();
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
      }
      for (const upd of updates) {
        await this.updateFile(upd);
      }
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
        console.warn('[SideCar] Symbol graph too large to persist, skipping');
        return;
      }
      await this.sidecarDir.writeText(CACHE_FILE, json);
    } catch (err) {
      console.warn('[SideCar] Failed to persist symbol graph:', err);
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
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      // Final persist on dispose
      this.persist();
    }
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }
  }
}
