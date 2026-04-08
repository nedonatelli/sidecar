import { workspace, Uri, FileSystemWatcher, RelativePattern, Disposable } from 'vscode';
import * as path from 'path';
import { SimpleCodeAnalyzer, ParsedFile } from '../astContext.js';
import { LimitedCache } from '../agent/memoryManager.js';

const MAX_FILE_SIZE = 100 * 1024; // 100KB
const MAX_CONTENT_LENGTH = 10_000; // 10K chars per file
const EXCLUDE_PATTERN = `**/{node_modules,.git,.sidecar,coverage,out,dist,build,.venv,venv,__pycache__,.next,.turbo,.cache}/**`;

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

export interface FileNode {
  relativePath: string;
  sizeBytes: number;
  relevanceScore: number;
}

export class WorkspaceIndex implements Disposable {
  private files = new Map<string, FileNode>();
  private treeCache = '';
  private watcher: FileSystemWatcher | null = null;
  private ready = false;
  private maxContextChars: number;
  private fileContentCache = new LimitedCache<string, string>(100, 300000); // 100 items, 5 min TTL
  private parsedFiles = new LimitedCache<string, ParsedFile>(100, 300000);
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private pinnedPaths = new Set<string>();

  constructor(maxContextChars = 20_000) {
    this.maxContextChars = maxContextChars;
  }

  /** Set pinned paths from settings (replaces previous pins from settings). */
  setPinnedPaths(paths: string[]): void {
    this.pinnedPaths = new Set(paths);
  }

  /** Add a runtime pin (e.g. from @pin:path in chat). */
  addPin(relativePath: string): void {
    this.pinnedPaths.add(relativePath);
  }

  /** Remove a runtime pin. */
  removePin(relativePath: string): void {
    this.pinnedPaths.delete(relativePath);
  }

  async initialize(patterns: string[]): Promise<void> {
    const folders = workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;

    const rootUri = folders[0].uri;
    const rootPath = rootUri.fsPath;

    // Parallelize file discovery and stat calls
    const allUris: Uri[] = [];
    const findPromises = patterns.map((pattern) => workspace.findFiles(pattern, EXCLUDE_PATTERN, 500));
    const foundUris = await Promise.all(findPromises);
    for (const uris of foundUris) {
      allUris.push(...uris);
    }

    // Process files in parallel with batching
    const batchSize = 20;
    for (let i = 0; i < allUris.length; i += batchSize) {
      const batch = allUris.slice(i, i + batchSize);
      const statPromises = batch.map((uri) => workspace.fs.stat(uri));
      const stats = await Promise.allSettled(statPromises);

      for (let j = 0; j < batch.length; j++) {
        const stat = stats[j];
        if (stat.status === 'fulfilled' && stat.value.size <= MAX_FILE_SIZE) {
          const uri = batch[j];
          const relativePath = path.relative(rootPath, uri.fsPath);
          this.files.set(relativePath, {
            relativePath,
            sizeBytes: stat.value.size,
            relevanceScore: this.baseScore(relativePath),
          });
        }
      }
    }

    this.rebuildTree();
    this.ready = true;

    // Watch for file changes — debounce rebuilds to avoid thrashing
    this.watcher = workspace.createFileSystemWatcher(new RelativePattern(rootUri, '**/*'));
    this.watcher.onDidCreate((uri) => {
      const rel = path.relative(rootPath, uri.fsPath);
      if (this.shouldExclude(rel)) return;
      workspace.fs.stat(uri).then(
        (stat) => {
          if (stat.size <= MAX_FILE_SIZE) {
            this.files.set(rel, { relativePath: rel, sizeBytes: stat.size, relevanceScore: this.baseScore(rel) });
            this.scheduleRebuild();
          }
        },
        () => {},
      );
    });
    this.watcher.onDidDelete((uri) => {
      const rel = path.relative(rootPath, uri.fsPath);
      this.files.delete(rel);
      this.scheduleRebuild();
    });
  }

  isReady(): boolean {
    return this.ready;
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

    // Score files based on query relevance
    const scored = [...this.files.values()].map((f) => ({
      ...f,
      score: this.computeScore(f, query, activeFilePath),
    }));
    scored.sort((a, b) => b.score - a.score);

    // Build context with relevant content first, tree last.
    // Relevant files and pinned files are more valuable than the tree
    // structure, so they get priority in the context budget.
    const parts: string[] = [];
    let charCount = 0;
    const budget = this.maxContextChars;

    // Include pinned files first (always, regardless of score)
    if (this.pinnedPaths.size > 0) {
      parts.push('\n## Pinned Files\n');
      charCount += 18;
      for (const pinPath of this.pinnedPaths) {
        if (charCount >= budget) break;
        try {
          // Support pinned folders: include all files under the prefix
          const matchingFiles = [...this.files.keys()].filter((f) => f === pinPath || f.startsWith(pinPath + path.sep));
          for (const filePath of matchingFiles) {
            if (charCount >= budget) break;
            const fileUri = Uri.joinPath(rootUri, filePath);
            let content = this.fileContentCache.get(filePath);
            if (!content) {
              const bytes = await workspace.fs.readFile(fileUri);
              content = Buffer.from(bytes).toString('utf-8').slice(0, MAX_CONTENT_LENGTH);
              this.fileContentCache.set(filePath, content);
            }
            const section = `\n### ${filePath} (pinned)\n\`\`\`\n${content}\n\`\`\`\n`;
            if (charCount + section.length > budget) continue;
            parts.push(section);
            charCount += section.length;
          }
        } catch {
          /* skip unreadable pinned files */
        }
      }
    }

    // Add file contents for top-scoring files
    parts.push('\n## Relevant Files\n');
    charCount += 20;

    for (const file of scored) {
      // Skip files already included as pinned
      if (this.pinnedPaths.has(file.relativePath)) continue;
      const isPinnedFolder = [...this.pinnedPaths].some((p) => file.relativePath.startsWith(p + path.sep));
      if (isPinnedFolder) continue;
      if (charCount >= budget) break;
      if (file.score <= 0) break;

      try {
        const fileUri = Uri.joinPath(rootUri, file.relativePath);
        let content = this.fileContentCache.get(file.relativePath);

        // Only read from disk if not cached
        if (!content) {
          const bytes = await workspace.fs.readFile(fileUri);
          content = Buffer.from(bytes).toString('utf-8').slice(0, MAX_CONTENT_LENGTH);
          this.fileContentCache.set(file.relativePath, content);
        }

        // Try to extract relevant code elements for smarter context
        const extName = path.extname(file.relativePath).toLowerCase();

        // For JavaScript/TypeScript files, use smart parsing
        if (extName === '.js' || extName === '.ts' || extName === '.jsx' || extName === '.tsx') {
          let parsedFile = this.parsedFiles.get(file.relativePath);

          // Only parse if not cached
          if (!parsedFile) {
            parsedFile = SimpleCodeAnalyzer.parseFileContent(file.relativePath, content);
            this.parsedFiles.set(file.relativePath, parsedFile);
          }

          // Extract relevant code elements based on the query
          const relevantElements = SimpleCodeAnalyzer.findRelevantElements(parsedFile, query);
          if (relevantElements.length > 0) {
            // Use the extracted relevant content instead of full file content
            const sectionContent = SimpleCodeAnalyzer.extractRelevantContent(parsedFile, relevantElements);
            const section = `\n### ${file.relativePath}\n\`\`\`\n${sectionContent}\n\`\`\`\n`;

            if (charCount + section.length > budget) continue;
            parts.push(section);
            charCount += section.length;
            continue; // Skip the default content
          }
        }

        // For other file types, use basic smart context selection
        if (extName === '.py' || extName === '.rs' || extName === '.go' || extName === '.java') {
          // Try to extract relevant code elements for Python/Rust/Go/Java files
          let parsedFile = this.parsedFiles.get(file.relativePath);

          // Only parse if not cached
          if (!parsedFile) {
            parsedFile = SimpleCodeAnalyzer.parseFileContent(file.relativePath, content);
            this.parsedFiles.set(file.relativePath, parsedFile);
          }

          // Extract relevant code elements based on the query
          const relevantElements = SimpleCodeAnalyzer.findRelevantElements(parsedFile, query);
          if (relevantElements.length > 0) {
            // Use the extracted relevant content instead of full file content
            const sectionContent = SimpleCodeAnalyzer.extractRelevantContent(parsedFile, relevantElements);
            const section = `\n### ${file.relativePath}\n\`\`\`\n${sectionContent}\n\`\`\`\n`;

            if (charCount + section.length > budget) continue;
            parts.push(section);
            charCount += section.length;
            continue; // Skip the default content
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

    // Append workspace tree at the end if budget remains — it's useful
    // context but less valuable than actual file contents.
    const tree = `\n## Workspace Structure\n\`\`\`\n${this.treeCache}\n\`\`\`\n`;
    if (charCount + tree.length <= budget) {
      parts.push(tree);
    } else if (budget - charCount > 200) {
      // Truncate tree to fit remaining budget
      const remaining = budget - charCount - 50;
      parts.push(`\n## Workspace Structure\n\`\`\`\n${this.treeCache.slice(0, remaining)}\n...\n\`\`\`\n`);
    }

    return parts.join('');
  }

  /**
   * Compute relevance score for a file based on query terms
   */
  private computeScore(file: FileNode, query: string, activeFilePath?: string): number {
    let score = file.relevanceScore;

    // Boost if file path appears in the query
    if (query.includes(file.relativePath) || query.includes(path.basename(file.relativePath))) {
      score += 0.5;
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
  }

  /**
   * Decay all relevance scores slightly so old accesses fade over time.
   * Call this at the start of each conversation turn.
   */
  decayRelevance(factor = 0.95): void {
    for (const node of this.files.values()) {
      const base = this.baseScore(node.relativePath);
      node.relevanceScore = Math.max(base, node.relevanceScore * factor);
    }
  }

  getFileCount(): number {
    return this.files.size;
  }

  dispose(): void {
    this.watcher?.dispose();
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
  }

  /** Debounce tree rebuilds — coalesce rapid file changes into one rebuild. */
  private scheduleRebuild(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuildTree();
    }, 300);
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
    const excluded = new Set([
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
    return parts.some((p) => excluded.has(p));
  }
}
