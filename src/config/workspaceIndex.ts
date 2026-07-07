import { workspace, Uri, FileSystemWatcher, RelativePattern, Disposable } from 'vscode';
import { logger } from '../system/logger.js';
import * as path from 'path';
import type { ParsedFile } from '../astContext.js';
import { getAnalyzer } from '../parsing/registry.js';
import { LimitedCache } from '../agent/memoryManager.js';
import type { SymbolIndexer } from './symbolIndexer.js';
import type { SidecarDir } from './sidecarDir.js';
import { readFileStreaming } from './streamingFileReader.js';
import { getConfig } from './settings.js';
import { getCurrentContextRules, applyContextRules } from './structuredContextRules.js';
import { tokenize } from './workspaceIndex/tokenize.js';
import type { FileNode, RankedFile } from './workspaceIndex/types.js';
export type { FileNode, RankedFile } from './workspaceIndex/types.js';

const MAX_FILE_SIZE = 100 * 1024; // 100KB

const INDEX_CACHE_FILE = 'cache/workspace-index.json';
const INDEX_VERSION = 1;

const DEFAULT_EXCLUDES = [
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
];
const EXCLUDE_PATTERN = `**/{${DEFAULT_EXCLUDES.join(',')}}/**`;

const ROOT_CONFIG_FILES = new Set([
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'build.gradle',
  'build.gradle.kts',
  'pom.xml',
  'Makefile',
  'CMakeLists.txt',
  'Gemfile',
  'composer.json',
]);

interface IndexCache {
  version: number;
  buildTime: string;
  fileCount: number;
  files: Array<{ path: string; size: number; score: number }>;
}

export class WorkspaceIndex implements Disposable {
  private files = new Map<string, FileNode>();
  private treeCache = '';
  private treeDirty = true;
  private watchers: FileSystemWatcher[] = [];
  private ready = false;
  private maxContextChars: number;
  private fileContentCache = new LimitedCache<string, string>(100, 300000); // 100 items, 5 min TTL
  private parsedFiles = new LimitedCache<string, ParsedFile>(100, 300000);
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private pinnedPaths = new Set<string>();
  /** Cached expansion of pinnedPaths to concrete file paths. Null = stale, rebuilt lazily. */
  private pinnedFileCache: Set<string> | null = null;
  private symbolIndexer: SymbolIndexer | null = null;
  private sidecarDir: SidecarDir | null = null;
  /** Files the agent has accessed this session, for graph context. */
  private recentlyAccessedFiles = new Set<string>();
  /** Extra exclude patterns from .sidecarignore */
  private customExcludes = new Set<string>();

  /** Active workspace roots (can be a subset if workspaceRoots is configured) */
  private activeRoots: Array<{ uri: Uri; fsPath: string }> = [];
  /** Semantic embedding index for file-level similarity search */
  private embeddingIndex: import('./embeddingIndex.js').EmbeddingIndex | null = null;
  /** Symbol-level semantic index.
   *  Set when `sidecar.projectKnowledge.enabled` is on; null otherwise. */
  private symbolEmbeddings: import('./symbolEmbeddingIndex.js').SymbolEmbeddingIndex | null = null;

  private lastPatterns: string[] = [];
  private folderChangeListener: import('vscode').Disposable | null = null;

  constructor(maxContextChars = 20_000) {
    this.maxContextChars = maxContextChars;
  }

  /** Attach a SidecarDir for index persistence. */
  setSidecarDir(dir: SidecarDir): void {
    this.sidecarDir = dir;
  }

  /** Attach a symbol indexer to receive file change notifications and provide graph context. */
  setSymbolIndexer(indexer: SymbolIndexer): void {
    this.symbolIndexer = indexer;
  }

  /** Attach a semantic embedding index for similarity-based file scoring. */
  setEmbeddingIndex(index: import('./embeddingIndex.js').EmbeddingIndex): void {
    this.embeddingIndex = index;
  }

  /** Get the embedding index (for extension wiring). */
  getEmbeddingIndex(): import('./embeddingIndex.js').EmbeddingIndex | null {
    return this.embeddingIndex;
  }

  /**
   * Attach the symbol-level embedding index. When set + ready + non-empty, retrievers prefer it
   * over the file-level index because symbol-granularity hits are
   * more precise for agent context. The file-level index stays as
   * the fallback so nothing breaks when PKI is disabled or empty.
   */
  setSymbolEmbeddings(index: import('./symbolEmbeddingIndex.js').SymbolEmbeddingIndex | null): void {
    this.symbolEmbeddings = index;
  }

  /** Get the symbol embedding index (null when PKI isn't wired). */
  getSymbolEmbeddings(): import('./symbolEmbeddingIndex.js').SymbolEmbeddingIndex | null {
    return this.symbolEmbeddings;
  }

  /**
   * Symbol graph accessor.
   * Exposes the SymbolIndexer's underlying call graph so the base
   * SemanticRetriever can walk callers outward from vector hits and
   * surface dependency-coupled symbols on every turn (previously only
   * the `project_knowledge_search` tool did this). Returns `null`
   * when no indexer is wired (pre-PKI workspaces, tests that bypass
   * symbol indexing).
   */
  getSymbolGraph(): import('./symbolGraph.js').SymbolGraph | null {
    return this.symbolIndexer?.getGraph() ?? null;
  }

  /** Set pinned paths from settings (replaces previous pins from settings). */
  setPinnedPaths(paths: string[]): void {
    this.pinnedPaths = new Set(paths);
    this.pinnedFileCache = null;
  }

  /** Add a runtime pin (e.g. from @pin:path in chat). */
  addPin(relativePath: string): void {
    this.pinnedPaths.add(relativePath);
    this.pinnedFileCache = null;
  }

  /** Remove a runtime pin. */
  removePin(relativePath: string): void {
    this.pinnedPaths.delete(relativePath);
    this.pinnedFileCache = null;
  }

  /** Build (or return cached) set of concrete file paths that match pinned prefixes. O(f) on first call per pin-set; O(1) on subsequent calls. */
  private getPinnedFileSet(): Set<string> {
    if (this.pinnedFileCache !== null) return this.pinnedFileCache;
    const result = new Set<string>();
    if (this.pinnedPaths.size > 0) {
      for (const f of this.files.keys()) {
        for (const pinPath of this.pinnedPaths) {
          if (f === pinPath || f.startsWith(pinPath + path.sep)) {
            result.add(f);
            break;
          }
        }
      }
    }
    this.pinnedFileCache = result;
    return result;
  }

  /**
   * Determine which workspace roots to use for indexing.
   * Returns active roots based on configuration (workspaceRoots setting)
   * or all available workspace folders if not configured.
   */
  private getActiveRoots(): Array<{ uri: Uri; fsPath: string }> {
    const folders = workspace.workspaceFolders;
    if (!folders || folders.length === 0) return [];

    const config = getConfig();
    // If workspaceRoots is configured, use only those roots
    if (config.workspaceRoots && config.workspaceRoots.length > 0) {
      const roots: Array<{ uri: Uri; fsPath: string }> = [];
      for (const rootPath of config.workspaceRoots) {
        const matching = folders.find((f) => f.uri.fsPath === rootPath || f.uri.fsPath.endsWith(rootPath));
        if (matching) {
          roots.push({ uri: matching.uri, fsPath: matching.uri.fsPath });
        }
      }
      return roots.length > 0 ? roots : [{ uri: folders[0].uri, fsPath: folders[0].uri.fsPath }];
    }

    // Default: use all available workspace folders
    return folders.map((f) => ({ uri: f.uri, fsPath: f.uri.fsPath }));
  }

  async initialize(patterns: string[]): Promise<void> {
    this.lastPatterns = patterns;
    if (!this.folderChangeListener) {
      this.folderChangeListener = workspace.onDidChangeWorkspaceFolders(() => {
        this.initialize(this.lastPatterns).catch((err) =>
          logger.warn('[SideCar] Workspace re-index after folder change failed:', err),
        );
      });
    }

    const folders = workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;

    // Determine active roots (can be a subset or all folders)
    this.activeRoots = this.getActiveRoots();
    const startTime = Date.now();
    const rootUri = this.activeRoots[0]?.uri || folders[0].uri;
    const rootPath = rootUri.fsPath;

    // Load .sidecarignore patterns if the file exists
    try {
      const ignoreUri = Uri.joinPath(rootUri, '.sidecarignore');
      const ignoreBytes = await workspace.fs.readFile(ignoreUri);
      const ignoreContent = Buffer.from(ignoreBytes).toString('utf-8');
      for (const line of ignoreContent.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          // Strip trailing slashes and glob markers for directory matching
          this.customExcludes.add(trimmed.replace(/\/?\*?\*?$/, '').replace(/^\//, ''));
        }
      }
      if (this.customExcludes.size > 0) {
        logger.info(`[SideCar] Loaded ${this.customExcludes.size} patterns from .sidecarignore`);
      }
    } catch {
      // .sidecarignore doesn't exist — use defaults only
    }

    // Try to restore from persistent cache first (instant startup)
    let restored = false;
    if (this.sidecarDir?.isReady()) {
      const cache = await this.sidecarDir.readJson<IndexCache>(INDEX_CACHE_FILE);
      if (cache && cache.version === INDEX_VERSION && cache.files) {
        for (const f of cache.files) {
          this.files.set(f.path, {
            relativePath: f.path,
            sizeBytes: f.size,
            relevanceScore: f.score,
          });
        }
        this.treeDirty = true;
        this.ready = true;
        restored = true;
        logger.info(
          `[SideCar] Workspace index restored from cache: ${cache.fileCount} files in ${Date.now() - startTime}ms`,
        );
      }
    }

    // Set up file watchers now so they're active regardless of whether the
    // scan below runs synchronously or in the background.
    this.setupFileWatchers(rootUri, rootPath);

    if (restored) {
      // Already serving from cache — verify/update in background so activation
      // is not blocked waiting for the disk scan to finish.
      void this.runFullScan(patterns, rootPath, startTime, true).catch((err) =>
        logger.warn('[SideCar] Background index verification failed:', err),
      );
      return;
    }

    // Cold start (no cache): must complete the scan before returning so the
    // index is populated before the first agent turn.
    await this.runFullScan(patterns, rootPath, startTime, false);
  }

  /**
   * Discover all workspace files matching `patterns`, stat them all in parallel
   * (no serial batching — workspace.fs.stat is non-blocking), and atomically
   * replace this.files with the fresh result.
   *
   * Called synchronously on cold start and as a fire-and-forget background
   * task on warm start (cache hit). The `isBackground` flag only affects
   * which log message is emitted on completion.
   */
  private async runFullScan(
    patterns: string[],
    rootPath: string,
    startTime: number,
    isBackground: boolean,
  ): Promise<void> {
    const scanStart = Date.now();

    const allUris: Uri[] = [];
    const foundUris = await Promise.all(patterns.map((p) => workspace.findFiles(p, EXCLUDE_PATTERN, 500)));
    for (const uris of foundUris) allUris.push(...uris);

    // Stat all files concurrently — replaces the previous serial batch-of-20 loop.
    // findFiles caps at 500 results so at most ~500 concurrent stat calls; each
    // is a lightweight syscall and VS Code's FS layer handles the concurrency.
    const statResults = await Promise.allSettled(allUris.map((uri) => workspace.fs.stat(uri)));
    const freshFiles = new Map<string, FileNode>();
    for (let j = 0; j < allUris.length; j++) {
      const stat = statResults[j];
      if (stat.status !== 'fulfilled' || stat.value.size > MAX_FILE_SIZE) continue;
      const relativePath = path.relative(rootPath, allUris[j].fsPath);
      freshFiles.set(relativePath, {
        relativePath,
        sizeBytes: stat.value.size,
        relevanceScore: this.baseScore(relativePath),
      });
    }

    this.files = freshFiles;
    this.pinnedFileCache = null;
    this.treeDirty = true;
    this.ready = true;

    const scanMs = Date.now() - scanStart;
    const totalMs = Date.now() - startTime;
    if (isBackground) {
      logger.info(
        `[SideCar] Workspace index verified: ${this.files.size} files (scan: ${scanMs}ms, total: ${totalMs}ms)`,
      );
    } else {
      logger.info(`[SideCar] Workspace indexed from scratch: ${this.files.size} files in ${totalMs}ms`);
    }

    this.persistIndex();
  }

  /**
   * Create FileSystemWatchers for all active roots and wire the create/change/delete
   * handlers. Disposes any existing watchers first (safe to call on re-initialization).
   */
  private setupFileWatchers(rootUri: Uri, rootPath: string): void {
    for (const w of this.watchers) w.dispose();
    const watchRoots = this.activeRoots.length > 0 ? this.activeRoots : [{ uri: rootUri, fsPath: rootPath }];
    this.watchers = watchRoots.map((root) => {
      const watchRoot = root.uri.fsPath;
      const watcher = workspace.createFileSystemWatcher(new RelativePattern(root.uri, '**/*'));
      watcher.onDidCreate((uri) => {
        const rel = path.relative(watchRoot, uri.fsPath);
        if (this.shouldExclude(rel)) return;
        workspace.fs.stat(uri).then(
          (stat) => {
            if (stat.size <= MAX_FILE_SIZE) {
              this.files.set(rel, { relativePath: rel, sizeBytes: stat.size, relevanceScore: this.baseScore(rel) });
              this.pinnedFileCache = null;
              this.scheduleRebuild();
              this.symbolIndexer?.queueUpdate(rel);
              this.embeddingIndex?.queuePath(rel, watchRoot);
            }
          },
          () => {},
        );
      });
      watcher.onDidChange((uri) => {
        const rel = path.relative(watchRoot, uri.fsPath);
        if (this.shouldExclude(rel)) return;
        this.fileContentCache.delete(rel);
        this.symbolIndexer?.queueUpdate(rel);
        this.embeddingIndex?.queuePath(rel, watchRoot);
      });
      watcher.onDidDelete((uri) => {
        const rel = path.relative(watchRoot, uri.fsPath);
        this.fileContentCache.delete(rel);
        this.files.delete(rel);
        this.pinnedFileCache = null;
        this.scheduleRebuild();
        this.symbolIndexer?.queueDelete(rel);
        this.embeddingIndex?.removeFile(rel);
      });
      return watcher;
    });
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Score and rank files for a query. Runs heuristic scoring, blends in
   * semantic similarity if the embedding index is available, applies
   * context rules, and returns the score>0 files sorted descending.
   *
   * Extracted from `getRelevantContext` so retrievers (for reciprocal-rank
   * fusion) and the legacy pre-formatted render path can share the same
   * ranking pipeline.
   */
  async rankFiles(query: string, activeFilePath?: string): Promise<RankedFile[]> {
    if (this.files.size === 0) return [];
    const config = getConfig();

    const rules = await getCurrentContextRules();

    // Tokenize the query once — amortizes over all files instead of
    // repeating tokenize(query) inside each computeScore call.
    const queryWords = tokenize(query);

    const scored: RankedFile[] = [...this.files.values()].map((f) => ({
      ...f,
      score: this.computeScore(f, query, queryWords, activeFilePath),
    }));

    if (config.enableSemanticSearch && this.embeddingIndex?.isReady()) {
      const weight = config.semanticSearchWeight;
      const semanticResults = await this.embeddingIndex.search(query, 50);
      if (semanticResults.length > 0) {
        const simMap = new Map(semanticResults.map((r) => [r.relativePath, r.similarity]));
        for (const f of scored) {
          const sim = simMap.get(f.relativePath);
          if (sim !== undefined) {
            // Heuristic * (1 - weight) + semantic * weight, scaled so that
            // the semantic side lands in the same ~0–2 range as the heuristic.
            f.score = f.score * (1 - weight) + sim * 2 * weight;
          }
        }
      }
    }

    const filesToConsider = applyContextRules(scored, rules) as RankedFile[];
    const relevant = filesToConsider.filter((f) => f.score > 0);
    relevant.sort((a, b) => b.score - a.score);
    return relevant;
  }

  /**
   * Read a file from the workspace with streaming + per-index caching.
   * Returns null if the file can't be read. Shared between the legacy
   * render path and retrievers so both benefit from the same LRU.
   */
  async loadFileContent(relativePath: string): Promise<string | null> {
    const folders = workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    const cached = this.fileContentCache.get(relativePath);
    if (cached) return cached;
    try {
      const config = getConfig();
      const fileUri = Uri.joinPath(folders[0].uri, relativePath);
      const size = this.files.get(relativePath)?.sizeBytes ?? 0;
      const result = await readFileStreaming(fileUri, {
        maxBytes: config.maxFileSizeBytes,
        summaryMode: size > config.streamingReadThreshold,
      });
      this.fileContentCache.set(relativePath, result.content);
      return result.content;
    } catch {
      return null;
    }
  }

  /**
   * Render the pinned-files section as a standalone markdown block.
   * Returns an empty string when there are no pinned files or the
   * budget is too small to hold even the header.
   *
   * Extracted so injectSystemContext can inject pinned files
   * independently of the retriever-fusion ranked-files path, which is
   * now handled by SemanticRetriever.
   */
  async getPinnedFilesSection(maxChars: number = this.maxContextChars): Promise<string> {
    if (this.pinnedPaths.size === 0) return '';
    const folders = workspace.workspaceFolders;
    if (!folders || folders.length === 0) return '';

    const pinnedFiles = this.getPinnedFileSet();
    if (pinnedFiles.size === 0) return '';

    const parts: string[] = ['\n## Pinned Files\n'];
    let charCount = parts[0].length;

    for (const filePath of pinnedFiles) {
      if (charCount >= maxChars) break;
      const content = await this.loadFileContent(filePath);
      if (!content) continue;
      const section = `\n### ${filePath} (pinned)\n\`\`\`\n${content}\n\`\`\`\n`;
      if (charCount + section.length > maxChars) continue;
      parts.push(section);
      charCount += section.length;
    }

    return parts.length > 1 ? parts.join('') : '';
  }

  /**
   * Render the file-dependencies (symbol graph) section independently.
   * Returns '' when the symbol indexer isn't wired up, there are no
   * recently accessed files, or the budget is too small.
   */
  getFileDependenciesSection(maxChars: number = 2000): string {
    if (!this.symbolIndexer || this.recentlyAccessedFiles.size === 0) return '';
    if (maxChars < 100) return '';
    const graphContext = this.symbolIndexer.getGraph().getFileGraphContext([...this.recentlyAccessedFiles], maxChars);
    return graphContext ? `\n## File Dependencies\n${graphContext}\n` : '';
  }

  /**
   * Render the workspace file tree as a standalone markdown block.
   * Truncates the tree body to fit `maxChars`. Callers are expected to
   * inject this last so it lands in the uncached suffix after the
   * `## Workspace Structure` cache marker.
   */
  getWorkspaceStructureSection(maxChars: number): string {
    const tree = this.currentTree();
    if (!tree) return '';
    const full = `\n## Workspace Structure\n\`\`\`\n${tree}\n\`\`\`\n`;
    if (full.length <= maxChars) return full;
    if (maxChars < 200) return '';
    const remaining = maxChars - 50;
    return `\n## Workspace Structure\n\`\`\`\n${tree.slice(0, remaining)}\n...\n\`\`\`\n`;
  }

  /**
   * Returns context string with file tree + relevant file contents,
   * staying within the token budget.
   */
  async getRelevantContext(query: string, activeFilePath?: string): Promise<string> {
    if (this.files.size === 0) return '';

    const folders = workspace.workspaceFolders;
    if (!folders || folders.length === 0) return '';
    const rootUri = folders[0].uri;
    const config = getConfig();

    const relevant = await this.rankFiles(query, activeFilePath);

    // Build context with relevant content first, tree last.
    const parts: string[] = [];
    let charCount = 0;
    const budget = this.maxContextChars;

    const pinnedFiles = this.getPinnedFileSet();

    // Include pinned files first (always, regardless of score)
    if (pinnedFiles.size > 0) {
      parts.push('\n## Pinned Files\n');
      charCount += 18;
      for (const filePath of pinnedFiles) {
        if (charCount >= budget) break;
        try {
          const fileUri = Uri.joinPath(rootUri, filePath);
          let content = this.fileContentCache.get(filePath);
          if (!content) {
            // Use streaming reads for large files
            const fileSize = this.files.get(filePath)?.sizeBytes || 0;
            const result = await readFileStreaming(fileUri, {
              maxBytes: config.maxFileSizeBytes,
              summaryMode: fileSize > config.streamingReadThreshold,
            });
            content = result.content;
            this.fileContentCache.set(filePath, content);
          }
          const section = `\n### ${filePath} (pinned)\n\`\`\`\n${content}\n\`\`\`\n`;
          if (charCount + section.length > budget) continue;
          parts.push(section);
          charCount += section.length;
        } catch {
          /* skip unreadable pinned files */
        }
      }
    }

    // Add file contents for top-scoring files
    parts.push('\n## Relevant Files\n');
    charCount += 20;

    for (const file of relevant) {
      // Skip files already included as pinned (O(1) lookup)
      if (pinnedFiles.has(file.relativePath)) continue;
      if (charCount >= budget) break;

      try {
        const fileUri = Uri.joinPath(rootUri, file.relativePath);
        let content = this.fileContentCache.get(file.relativePath);

        // Only read from disk if not cached
        if (!content) {
          // Use streaming reads for large files
          const result = await readFileStreaming(fileUri, {
            maxBytes: config.maxFileSizeBytes,
            summaryMode: file.sizeBytes > config.streamingReadThreshold,
          });
          content = result.content;
          this.fileContentCache.set(file.relativePath, content);
        }

        // Try to extract relevant code elements for smarter context
        const extName = path.extname(file.relativePath).toLowerCase();

        // Try smart code extraction via the analyzer registry (tree-sitter or regex fallback)
        const ext = extName.startsWith('.') ? extName.slice(1) : extName;
        const analyzer = await getAnalyzer(ext);
        if (analyzer.supportedExtensions.has(ext)) {
          let parsedFile = this.parsedFiles.get(file.relativePath);
          if (!parsedFile) {
            parsedFile = analyzer.parseFileContent(file.relativePath, content);
            this.parsedFiles.set(file.relativePath, parsedFile);
          }

          const relevantElements = analyzer.findRelevantElements(parsedFile, query);
          if (relevantElements.length > 0) {
            const sectionContent = analyzer.extractRelevantContent(parsedFile, relevantElements);
            const section = `\n### ${file.relativePath}\n\`\`\`\n${sectionContent}\n\`\`\`\n`;
            if (charCount + section.length > budget) continue;
            parts.push(section);
            charCount += section.length;
            continue;
          }
        }

        const section = `\n### ${file.relativePath}\n\`\`\`\n${content}\n\`\`\`\n`;

        if (charCount + section.length > budget) continue;
        parts.push(section);
        charCount += section.length;
      } catch {
        // skip unreadable
      }
    }

    // Append symbol graph context if available — show dependencies
    // and dependents of recently accessed files.
    if (this.symbolIndexer && this.recentlyAccessedFiles.size > 0) {
      const graphBudget = Math.min(2000, budget - charCount);
      if (graphBudget > 100) {
        const graphContext = this.symbolIndexer
          .getGraph()
          .getFileGraphContext([...this.recentlyAccessedFiles], graphBudget);
        if (graphContext) {
          const section = `\n## File Dependencies\n${graphContext}\n`;
          if (charCount + section.length <= budget) {
            parts.push(section);
            charCount += section.length;
          }
        }
      }
    }

    // Append workspace tree at the end if budget remains — it's useful
    // context but less valuable than actual file contents.
    const treeStr = this.currentTree();
    const tree = `\n## Workspace Structure\n\`\`\`\n${treeStr}\n\`\`\`\n`;
    if (charCount + tree.length <= budget) {
      parts.push(tree);
    } else if (budget - charCount > 200) {
      // Truncate tree to fit remaining budget
      const remaining = budget - charCount - 50;
      parts.push(`\n## Workspace Structure\n\`\`\`\n${treeStr.slice(0, remaining)}\n...\n\`\`\`\n`);
    }

    return parts.join('');
  }

  /**
   * Compute relevance score for a file based on query terms.
   * Combines exact path matching, basename matching, and token-based matching
   * (splits camelCase/snake_case/kebab-case path tokens against query words).
   */
  private computeScore(file: FileNode, query: string, queryWords: string[], activeFilePath?: string): number {
    let score = file.relevanceScore;

    // Strong boost if file path appears in the query — the user is explicitly
    // asking about this file, so it should dominate over accumulated history.
    if (query.includes(file.relativePath) || query.includes(path.basename(file.relativePath))) {
      score += 1.5;
    }

    // Token-based matching: split path identifiers into words and match
    // against query words. Catches "parse util" → parseUtils.ts.
    if (queryWords.length > 0) {
      const pathTokens = tokenize(file.relativePath);
      const pathTokenSet = new Set(pathTokens);
      let matches = 0;
      for (const qw of queryWords) {
        if (pathTokenSet.has(qw)) {
          matches += 1;
        } else {
          // Prefix match on any path token (catches partial words, avoids mid-word false positives)
          for (const pt of pathTokens) {
            if (pt.length >= 3 && (pt.startsWith(qw) || qw.startsWith(pt))) {
              matches += 0.5;
              break;
            }
          }
        }
      }
      if (matches > 0) {
        // Normalize by query length so longer queries don't dominate
        score += Math.min(1.2, matches / queryWords.length);
      }
    }

    // Boost if in same directory as active file
    if (activeFilePath) {
      const fileDir = path.dirname(file.relativePath);
      const activeDir = path.dirname(activeFilePath);
      if (fileDir === activeDir) score += 0.2;
    }

    return score;
  }

  /**
   * Boost relevance for files that were referenced in conversation.
   */
  updateRelevance(mentionedPaths: string[]): void {
    for (const p of mentionedPaths) {
      const node = this.files.get(p);
      if (node) {
        node.relevanceScore = Math.min(1, node.relevanceScore + 0.3);
      }
    }
  }

  /**
   * Track a file accessed by the agent via tool calls.
   * Write access gets a bigger boost than read access.
   */
  trackFileAccess(relativePath: string, accessType: 'read' | 'write'): void {
    const node = this.files.get(relativePath);
    if (node) {
      const boost = accessType === 'write' ? 0.4 : 0.2;
      node.relevanceScore = Math.min(1, node.relevanceScore + boost);
    }
    this.recentlyAccessedFiles.add(relativePath);
  }

  /**
   * Remove a file's cached content so the next `loadFileContent` call
   * re-reads it from disk. Call this immediately after the agent writes
   * or edits a file to prevent subsequent turns from seeing stale content.
   * (The VS Code FileSystemWatcher also invalidates this cache, but fires
   * asynchronously — without this call the agent can read stale content
   * between the write and the watcher event.)
   */
  invalidateFile(relativePath: string): void {
    this.fileContentCache.delete(relativePath);
    this.parsedFiles.delete(relativePath);
  }

  /**
   * Decay all relevance scores so old accesses fade over time.
   * Call this at the start of each conversation turn.
   * Uses aggressive decay (0.5) so that when the user changes topic,
   * previously discussed files don't dominate the context.
   * After two turns without re-access, a file's score drops to ~25%
   * of its boosted value, letting query-matched files take over.
   */
  decayRelevance(factor = 0.5): void {
    for (const node of this.files.values()) {
      const base = this.baseScore(node.relativePath);
      node.relevanceScore = Math.max(base, node.relevanceScore * factor);
    }
  }

  /**
   * Reset all relevance scores back to their base values.
   * Called when the conversation is cleared so that previously discussed
   * files don't carry over into a fresh conversation's workspace context.
   */
  resetRelevance(): void {
    for (const node of this.files.values()) {
      node.relevanceScore = this.baseScore(node.relativePath);
    }
    this.recentlyAccessedFiles.clear();
  }

  getFileCount(): number {
    return this.files.size;
  }

  /** Iterate all indexed files. */
  getFiles(): IterableIterator<FileNode> {
    return this.files.values();
  }

  /** Get the cached file tree string (built during indexing). */
  getFileTree(): string {
    return this.currentTree();
  }

  private currentTree(): string {
    if (this.treeDirty) this.rebuildTree();
    return this.treeCache;
  }

  dispose(): void {
    this.folderChangeListener?.dispose();
    this.folderChangeListener = null;
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  /** Mark the tree stale and schedule a debounced persist after file changes. */
  private scheduleRebuild(): void {
    this.treeDirty = true;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.schedulePersist();
    }, 300);
  }

  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  /** Debounce index persistence — write to disk at most every 30 seconds. */
  private schedulePersist(): void {
    if (this.persistTimer) return; // already scheduled
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistIndex();
    }, 30_000);
  }

  /** Write the file index to .sidecar/cache/ for fast startup on next activation. */
  private persistIndex(): void {
    if (!this.sidecarDir?.isReady()) return;
    const cache: IndexCache = {
      version: INDEX_VERSION,
      buildTime: new Date().toISOString(),
      fileCount: this.files.size,
      files: [...this.files.values()].map((f) => ({
        path: f.relativePath,
        size: f.sizeBytes,
        score: f.relevanceScore,
      })),
    };
    this.sidecarDir.writeJson(INDEX_CACHE_FILE, cache).catch((err) => {
      logger.warn('[SideCar] Failed to persist workspace index:', err);
    });
  }

  private baseScore(relativePath: string): number {
    const basename = path.basename(relativePath);
    if (ROOT_CONFIG_FILES.has(basename)) return 0.15;
    if (basename === 'SIDECAR.md' || basename === 'README.md') return 0.1;
    const ext = path.extname(relativePath).toLowerCase();
    const codeExts = new Set([
      '.ts',
      '.js',
      '.py',
      '.rs',
      '.go',
      '.java',
      '.c',
      '.cpp',
      '.rb',
      '.php',
      '.cs',
      '.kt',
      '.swift',
    ]);
    if (codeExts.has(ext)) return 0.1;
    const configExts = new Set(['.json', '.yaml', '.yml', '.toml']);
    if (configExts.has(ext)) return 0.05;
    return 0.02;
  }

  private rebuildTree(): void {
    this.treeDirty = false;
    const sorted = [...this.files.keys()].sort();
    const lines: string[] = [];

    for (const filePath of sorted) {
      const depth = filePath.split(path.sep).length - 1;
      const indent = '  '.repeat(depth);
      const basename = path.basename(filePath);
      lines.push(`${indent}${basename}`);
    }

    // Truncate tree to ~2K chars
    let tree = lines.join('\n');
    if (tree.length > 2000) {
      tree = tree.slice(0, 2000) + `\n... (${sorted.length} files total)`;
    }
    this.treeCache = tree;
  }

  private shouldExclude(relativePath: string): boolean {
    const parts = relativePath.split(path.sep);
    const defaultExcludes = new Set(DEFAULT_EXCLUDES);
    // Check default directory excludes
    if (parts.some((p) => defaultExcludes.has(p))) return true;
    // Check custom .sidecarignore patterns
    if (this.customExcludes.size > 0) {
      // Match directory names or path prefixes
      for (const pattern of this.customExcludes) {
        if (parts.some((p) => p === pattern)) return true;
        if (relativePath.startsWith(pattern + path.sep) || relativePath === pattern) return true;
      }
    }
    return false;
  }

  /**
   * Check if a file should be included based on depth limits from config.
   * Returns true if the file's depth is within the allowed limit.
   */
  private isWithinDepthLimit(relativePath: string): boolean {
    const config = getConfig();
    if (config.maxTraversalDepth <= 0) return true; // 0 = no limit

    const depth = relativePath.split(path.sep).length - 1;
    return depth < config.maxTraversalDepth;
  }

  /**
   * Get files filtered by depth limit.
   * Returns a map of files that are within the configured depth limit.
   */
  getFilesWithinDepthLimit(): Map<string, FileNode> {
    const filtered = new Map<string, FileNode>();
    for (const [path, node] of this.files) {
      if (this.isWithinDepthLimit(path)) {
        filtered.set(path, node);
      }
    }
    return filtered;
  }
}
