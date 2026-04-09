/**
 * Symbol graph for deep codebase indexing.
 *
 * Tracks symbols (functions, classes, interfaces, types), import/export
 * relationships between files, and provides cross-file reference lookups.
 * Pure data structure — no VS Code dependencies — for testability.
 */

export interface SymbolEntry {
  name: string;
  qualifiedName: string; // e.g. "MyClass.myMethod" or just "myFunction"
  type: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'method' | 'enum';
  filePath: string; // relative to workspace root
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface ImportEdge {
  fromFile: string; // the file that imports
  toFile: string; // resolved relative path of the imported file
  importedNames: string[]; // named imports, or ['*'] for star, ['default'] for default
}

export interface SymbolReference {
  file: string;
  line: number;
  context: string; // truncated line content
}

/** Serialization format for persistence. */
export interface SymbolGraphData {
  version: number;
  buildTime: string;
  symbols: SymbolEntry[];
  imports: ImportEdge[];
  fileHashes: Record<string, string>;
}

const GRAPH_VERSION = 1;

export class SymbolGraph {
  // Primary storage: symbols indexed by file
  private symbolsByFile = new Map<string, SymbolEntry[]>();
  // Index: symbols indexed by name (multiple files can define the same name)
  private symbolsByName = new Map<string, SymbolEntry[]>();
  // Outgoing imports per file
  private importsByFile = new Map<string, ImportEdge[]>();
  // Reverse index: which files import a given file
  private importedBy = new Map<string, ImportEdge[]>();
  // File content hashes for incremental rebuild
  private fileHashes = new Map<string, string>();
  // Cached file content for reference searching (populated on demand)
  private fileContents = new Map<string, string>();

  /** Add or replace all data for a single file. */
  addFile(filePath: string, symbols: SymbolEntry[], imports: ImportEdge[], hash: string): void {
    // Remove old data first
    this.removeFile(filePath);

    // Store symbols
    this.symbolsByFile.set(filePath, symbols);
    for (const sym of symbols) {
      const existing = this.symbolsByName.get(sym.name);
      if (existing) {
        existing.push(sym);
      } else {
        this.symbolsByName.set(sym.name, [sym]);
      }
    }

    // Store imports
    if (imports.length > 0) {
      this.importsByFile.set(filePath, imports);
      for (const edge of imports) {
        const existing = this.importedBy.get(edge.toFile);
        if (existing) {
          existing.push(edge);
        } else {
          this.importedBy.set(edge.toFile, [edge]);
        }
      }
    }

    this.fileHashes.set(filePath, hash);
  }

  /** Remove all data for a file. */
  removeFile(filePath: string): void {
    // Remove symbols from name index
    const oldSymbols = this.symbolsByFile.get(filePath);
    if (oldSymbols) {
      for (const sym of oldSymbols) {
        const byName = this.symbolsByName.get(sym.name);
        if (byName) {
          const filtered = byName.filter((s) => s.filePath !== filePath);
          if (filtered.length > 0) {
            this.symbolsByName.set(sym.name, filtered);
          } else {
            this.symbolsByName.delete(sym.name);
          }
        }
      }
      this.symbolsByFile.delete(filePath);
    }

    // Remove import edges
    const oldImports = this.importsByFile.get(filePath);
    if (oldImports) {
      for (const edge of oldImports) {
        const reverseList = this.importedBy.get(edge.toFile);
        if (reverseList) {
          const filtered = reverseList.filter((e) => e.fromFile !== filePath);
          if (filtered.length > 0) {
            this.importedBy.set(edge.toFile, filtered);
          } else {
            this.importedBy.delete(edge.toFile);
          }
        }
      }
      this.importsByFile.delete(filePath);
    }

    this.fileHashes.delete(filePath);
    this.fileContents.delete(filePath);
  }

  /** Check if a file needs re-parsing. */
  getFileHash(filePath: string): string | undefined {
    return this.fileHashes.get(filePath);
  }

  /** Find all symbol definitions with this name. */
  lookupSymbol(name: string): SymbolEntry[] {
    return this.symbolsByName.get(name) || [];
  }

  /** Get all exported symbols from a file. */
  getExportsOf(filePath: string): SymbolEntry[] {
    const symbols = this.symbolsByFile.get(filePath) || [];
    return symbols.filter((s) => s.exported);
  }

  /** Get all symbols defined in a file. */
  getSymbolsInFile(filePath: string): SymbolEntry[] {
    return this.symbolsByFile.get(filePath) || [];
  }

  /** Files this file imports (outgoing dependencies). */
  getDependencies(filePath: string): string[] {
    const imports = this.importsByFile.get(filePath) || [];
    return [...new Set(imports.map((e) => e.toFile))];
  }

  /** Files that import this file (incoming dependents). */
  getDependents(filePath: string): string[] {
    const edges = this.importedBy.get(filePath) || [];
    return [...new Set(edges.map((e) => e.fromFile))];
  }

  /**
   * Find references to a symbol across the workspace.
   * Uses the import graph to narrow the search to files that import
   * the defining file, then does a word-boundary string search.
   */
  findReferences(symbolName: string, fileContentsProvider?: (path: string) => string | undefined): SymbolReference[] {
    const definitions = this.lookupSymbol(symbolName);
    if (definitions.length === 0) return [];

    // Collect candidate files: files that import any file defining this symbol
    const candidateFiles = new Set<string>();
    for (const def of definitions) {
      // Check the defining file itself
      candidateFiles.add(def.filePath);
      // Check files that import the defining file
      const dependents = this.getDependents(def.filePath);
      for (const dep of dependents) {
        candidateFiles.add(dep);
      }
      // Also check files that import with a matching binding name
      const allDependents = this.importedBy.get(def.filePath) || [];
      for (const edge of allDependents) {
        if (edge.importedNames.includes(symbolName) || edge.importedNames.includes('*')) {
          candidateFiles.add(edge.fromFile);
        }
      }
    }

    // Search candidate files for the symbol name
    const results: SymbolReference[] = [];
    const pattern = new RegExp(`\\b${escapeRegex(symbolName)}\\b`);

    for (const file of candidateFiles) {
      const content = fileContentsProvider?.(file) ?? this.fileContents.get(file);
      if (!content) continue;

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          // Skip import/from lines — they're declarations, not usages
          const trimmed = lines[i].trim();
          if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) continue;

          results.push({
            file,
            line: i + 1, // 1-based
            context: lines[i].trim().slice(0, 120),
          });
        }
      }
    }

    return results;
  }

  /**
   * Store file content for reference searching.
   * Content is stored in-memory (not persisted) for fast grep-like lookups.
   */
  setFileContent(filePath: string, content: string): void {
    this.fileContents.set(filePath, content);
  }

  /**
   * Build a context string for a symbol suitable for injection into the LLM prompt.
   * Includes the definition, importers, and dependents.
   */
  getSymbolContext(symbolName: string, maxChars: number): string {
    const definitions = this.lookupSymbol(symbolName);
    if (definitions.length === 0) return '';

    const parts: string[] = [];
    let chars = 0;

    for (const def of definitions) {
      const header = `${def.exported ? 'export ' : ''}${def.type} ${def.qualifiedName} — ${def.filePath}:${def.startLine + 1}`;
      parts.push(header);
      chars += header.length;

      // Add dependents
      const dependents = this.getDependents(def.filePath);
      if (dependents.length > 0) {
        const depLine = `  Imported by: ${dependents.slice(0, 5).join(', ')}${dependents.length > 5 ? ` (+${dependents.length - 5} more)` : ''}`;
        parts.push(depLine);
        chars += depLine.length;
      }

      if (chars > maxChars) break;
    }

    return parts.join('\n');
  }

  /**
   * Build a dependency context string for files the agent has accessed.
   */
  getFileGraphContext(filePaths: string[], maxChars: number): string {
    const parts: string[] = [];
    let chars = 0;

    for (const fp of filePaths) {
      if (chars >= maxChars) break;

      const deps = this.getDependencies(fp);
      const dependents = this.getDependents(fp);
      if (deps.length === 0 && dependents.length === 0) continue;

      const lines: string[] = [`### ${fp}`];
      if (deps.length > 0) {
        lines.push(`  Imports: ${deps.slice(0, 8).join(', ')}${deps.length > 8 ? ` (+${deps.length - 8})` : ''}`);
      }
      if (dependents.length > 0) {
        lines.push(
          `  Used by: ${dependents.slice(0, 8).join(', ')}${dependents.length > 8 ? ` (+${dependents.length - 8})` : ''}`,
        );
      }
      const section = lines.join('\n');
      parts.push(section);
      chars += section.length;
    }

    return parts.join('\n');
  }

  /** Total number of indexed symbols. */
  symbolCount(): number {
    let count = 0;
    for (const syms of this.symbolsByFile.values()) {
      count += syms.length;
    }
    return count;
  }

  /** Total number of indexed files. */
  fileCount(): number {
    return this.symbolsByFile.size;
  }

  /** Serialize to a persistable format (no file contents). */
  toJSON(): SymbolGraphData {
    const symbols: SymbolEntry[] = [];
    for (const syms of this.symbolsByFile.values()) {
      symbols.push(...syms);
    }

    const imports: ImportEdge[] = [];
    for (const edges of this.importsByFile.values()) {
      imports.push(...edges);
    }

    const fileHashes: Record<string, string> = {};
    for (const [k, v] of this.fileHashes) {
      fileHashes[k] = v;
    }

    return {
      version: GRAPH_VERSION,
      buildTime: new Date().toISOString(),
      symbols,
      imports,
      fileHashes,
    };
  }

  /** Deserialize from persisted format. */
  static fromJSON(data: SymbolGraphData): SymbolGraph | null {
    if (!data || data.version !== GRAPH_VERSION) return null;

    const graph = new SymbolGraph();

    // Group symbols by file
    const byFile = new Map<string, SymbolEntry[]>();
    for (const sym of data.symbols) {
      const list = byFile.get(sym.filePath);
      if (list) {
        list.push(sym);
      } else {
        byFile.set(sym.filePath, [sym]);
      }
    }

    // Group imports by fromFile
    const importsByFrom = new Map<string, ImportEdge[]>();
    for (const edge of data.imports) {
      const list = importsByFrom.get(edge.fromFile);
      if (list) {
        list.push(edge);
      } else {
        importsByFrom.set(edge.fromFile, [edge]);
      }
    }

    // Rebuild the graph file by file
    for (const [filePath, symbols] of byFile) {
      const imports = importsByFrom.get(filePath) || [];
      const hash = data.fileHashes[filePath] || '';
      graph.addFile(filePath, symbols, imports, hash);
    }

    // Also add files that only have imports (no symbols)
    for (const [filePath, imports] of importsByFrom) {
      if (!byFile.has(filePath)) {
        const hash = data.fileHashes[filePath] || '';
        graph.addFile(filePath, [], imports, hash);
      }
    }

    return graph;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
