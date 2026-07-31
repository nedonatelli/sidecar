/**
 * Symbol graph for deep codebase indexing.
 *
 * Tracks symbols (functions, classes, interfaces, types), import/export
 * relationships between files, and provides cross-file reference lookups.
 * Pure data structure — no VS Code dependencies — for testability.
 */

import type {
  SymbolEntry,
  ImportEdge,
  CallEdge,
  TypeEdge,
  TypeUseEdge,
  ImpactedItem,
  ImpactSeed,
  SymbolReference,
  SymbolGraphData,
} from './symbolGraph/types.js';

export type {
  SymbolEntry,
  ImportEdge,
  CallEdge,
  TypeEdge,
  TypeUseEdge,
  ImpactedItem,
  ImpactSeed,
  SymbolReference,
  SymbolGraphData,
} from './symbolGraph/types.js';

// v3: added typeUses edges + the callsFrom (callee) index for change-impact analysis.
// v4: top-level variable declarations are indexed as `variable` symbols. The bump
//     is what forces the re-index — reconciliation is by content hash, so an
//     existing cache would otherwise serve a graph with no variable symbols
//     forever, since none of the files changed.
export const GRAPH_VERSION = 4;

export class SymbolGraph {
  // Primary storage: symbols indexed by file
  private symbolsByFile = new Map<string, SymbolEntry[]>();
  // Index: symbols indexed by name (multiple files can define the same name)
  private symbolsByName = new Map<string, SymbolEntry[]>();
  // Outgoing imports per file
  private importsByFile = new Map<string, ImportEdge[]>();
  // Reverse index: which files import a given file
  private importedBy = new Map<string, ImportEdge[]>();
  // Call edges per file (caller side)
  private callsByFile = new Map<string, CallEdge[]>();
  // Reverse call index: callee name → call edges
  private callsTo = new Map<string, CallEdge[]>();
  // Forward call index: caller name → call edges (what does this symbol call?)
  private callsFrom = new Map<string, CallEdge[]>();
  // Type-use edges per file (user side)
  private typeUsesByFile = new Map<string, TypeUseEdge[]>();
  // Reverse type-use index: type name → edges that reference it
  private typeUsesByName = new Map<string, TypeUseEdge[]>();
  // Type relationship edges per file (child side)
  private typeEdgesByFile = new Map<string, TypeEdge[]>();
  // Reverse type index: parent name → type edges
  private subtypesOf = new Map<string, TypeEdge[]>();
  // Reverse type index: child name → type edges (for getSupertypes O(1) lookup)
  private childTypesOf = new Map<string, TypeEdge[]>();
  // File content hashes for incremental rebuild
  private fileHashes = new Map<string, string>();
  // Cached file content for reference searching (populated on demand)
  private fileContents = new Map<string, string>();

  /** Add or replace all data for a single file. */
  addFile(
    filePath: string,
    symbols: SymbolEntry[],
    imports: ImportEdge[],
    hash: string,
    calls?: CallEdge[],
    typeEdges?: TypeEdge[],
    typeUses?: TypeUseEdge[],
  ): void {
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

    // Store call edges
    if (calls && calls.length > 0) {
      this.callsByFile.set(filePath, calls);
      for (const edge of calls) {
        const existing = this.callsTo.get(edge.calleeName);
        if (existing) {
          existing.push(edge);
        } else {
          this.callsTo.set(edge.calleeName, [edge]);
        }
        const fromExisting = this.callsFrom.get(edge.callerName);
        if (fromExisting) {
          fromExisting.push(edge);
        } else {
          this.callsFrom.set(edge.callerName, [edge]);
        }
      }
    }

    // Store type-use edges
    if (typeUses && typeUses.length > 0) {
      this.typeUsesByFile.set(filePath, typeUses);
      for (const edge of typeUses) {
        const existing = this.typeUsesByName.get(edge.typeName);
        if (existing) {
          existing.push(edge);
        } else {
          this.typeUsesByName.set(edge.typeName, [edge]);
        }
      }
    }

    // Store type relationship edges
    if (typeEdges && typeEdges.length > 0) {
      this.typeEdgesByFile.set(filePath, typeEdges);
      for (const edge of typeEdges) {
        const existing = this.subtypesOf.get(edge.parentName);
        if (existing) {
          existing.push(edge);
        } else {
          this.subtypesOf.set(edge.parentName, [edge]);
        }
        const existingChild = this.childTypesOf.get(edge.childName);
        if (existingChild) {
          existingChild.push(edge);
        } else {
          this.childTypesOf.set(edge.childName, [edge]);
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

    // Remove call edges
    const oldCalls = this.callsByFile.get(filePath);
    if (oldCalls) {
      for (const edge of oldCalls) {
        const reverseList = this.callsTo.get(edge.calleeName);
        if (reverseList) {
          const filtered = reverseList.filter((e) => e.callerFile !== filePath);
          if (filtered.length > 0) {
            this.callsTo.set(edge.calleeName, filtered);
          } else {
            this.callsTo.delete(edge.calleeName);
          }
        }
        const fromList = this.callsFrom.get(edge.callerName);
        if (fromList) {
          const filtered = fromList.filter((e) => e.callerFile !== filePath);
          if (filtered.length > 0) {
            this.callsFrom.set(edge.callerName, filtered);
          } else {
            this.callsFrom.delete(edge.callerName);
          }
        }
      }
      this.callsByFile.delete(filePath);
    }

    // Remove type-use edges
    const oldTypeUses = this.typeUsesByFile.get(filePath);
    if (oldTypeUses) {
      for (const edge of oldTypeUses) {
        const reverseList = this.typeUsesByName.get(edge.typeName);
        if (reverseList) {
          const filtered = reverseList.filter((e) => e.userFile !== filePath);
          if (filtered.length > 0) {
            this.typeUsesByName.set(edge.typeName, filtered);
          } else {
            this.typeUsesByName.delete(edge.typeName);
          }
        }
      }
      this.typeUsesByFile.delete(filePath);
    }

    // Remove type edges
    const oldTypeEdges = this.typeEdgesByFile.get(filePath);
    if (oldTypeEdges) {
      for (const edge of oldTypeEdges) {
        const childList = this.childTypesOf.get(edge.childName);
        if (childList) {
          const filtered = childList.filter((e) => e.childFile !== filePath);
          if (filtered.length > 0) {
            this.childTypesOf.set(edge.childName, filtered);
          } else {
            this.childTypesOf.delete(edge.childName);
          }
        }
        const reverseList = this.subtypesOf.get(edge.parentName);
        if (reverseList) {
          const filtered = reverseList.filter((e) => e.childFile !== filePath);
          if (filtered.length > 0) {
            this.subtypesOf.set(edge.parentName, filtered);
          } else {
            this.subtypesOf.delete(edge.parentName);
          }
        }
      }
      this.typeEdgesByFile.delete(filePath);
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

  /** Get all call sites where `symbolName` is called. */
  getCallers(symbolName: string): CallEdge[] {
    return this.callsTo.get(symbolName) || [];
  }

  /** Get all calls made from within `callerName` (what this symbol calls). */
  getCallees(callerName: string): CallEdge[] {
    return this.callsFrom.get(callerName) || [];
  }

  /** Get all symbols that reference `typeName` in a signature/variable. */
  getTypeUsers(typeName: string): TypeUseEdge[] {
    return this.typeUsesByName.get(typeName) || [];
  }

  /**
   * Does `file` import `name` from `defFile`? Import edges resolve to
   * extensionless module paths (resolveImportPath) while symbol files carry an
   * extension, so we match `defFile` both ways. A `*` (namespace) or `default`
   * binding counts as importing every name.
   */
  private fileImportsSymbol(file: string, name: string, defFile: string): boolean {
    const edges = this.importsByFile.get(file);
    if (!edges || edges.length === 0) return false;
    const defKeys = new Set([defFile, defFile.replace(/\.[^./]+$/, '')]);
    for (const e of edges) {
      if (!defKeys.has(e.toFile)) continue;
      if (e.importedNames.includes(name) || e.importedNames.includes('*') || e.importedNames.includes('default')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether an edge located in `edgeFile` that references `name` binds to the
   * definition in `defFile`. With no `defFile` it's name-only (always true,
   * Stage 1). Otherwise it binds iff the edge is in the defining file itself or
   * the edge's file imports `name` from the defining file.
   */
  private edgeBindsTo(edgeFile: string, name: string, defFile?: string): boolean {
    if (defFile === undefined) return true;
    if (edgeFile === defFile) return true;
    return this.fileImportsSymbol(edgeFile, name, defFile);
  }

  /**
   * Change-impact analysis: given the symbols a change touches, return the
   * symbols/files potentially affected — direct + transitive callers (up to
   * `maxDepth` hops), symbols that use a changed symbol as a type, declared
   * subtypes, and files that import the changed symbol.
   *
   * Pass {@link ImpactSeed}s with a `file` to get binding-accurate results:
   * each edge is resolved against the import graph, so a change to `foo` in
   * `a.ts` never reports dependents of an unrelated `foo` in `b.ts`. Bare
   * strings (or seeds without `file`) fall back to name-only matching — an
   * over-approximation flagged with `resolved: false` on every item.
   */
  impactOf(changed: ReadonlyArray<string | ImpactSeed>, opts?: { maxDepth?: number; limit?: number }): ImpactedItem[] {
    const maxDepth = Math.max(1, opts?.maxDepth ?? 2);
    const limit = Math.max(1, opts?.limit ?? 200);
    const seeds: ImpactSeed[] = changed
      .map((c) => (typeof c === 'string' ? { name: c } : c))
      .filter((s) => s.name && s.name !== '<module>');
    if (seeds.length === 0) return [];

    const items: ImpactedItem[] = [];
    const seen = new Set<string>(); // dedupe key: reason|file|name|line
    const push = (item: ImpactedItem): void => {
      const key = `${item.reason}|${item.file}|${item.name}|${item.line ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push(item);
    };

    // Transitive caller walk (BFS), carrying each symbol's defining file so
    // resolution holds at every hop: a caller of `foo@a.ts` must itself bind to
    // `a.ts`, and its own callers then resolve against the caller's file.
    const visited = new Set<string>(); // key: name|file
    let frontier: ImpactSeed[] = [];
    for (const s of seeds) {
      const key = `${s.name}|${s.file ?? ''}`;
      if (!visited.has(key)) {
        visited.add(key);
        frontier.push(s);
      }
    }
    for (let hop = 1; hop <= maxDepth && frontier.length > 0; hop++) {
      const next: ImpactSeed[] = [];
      for (const cur of frontier) {
        for (const edge of this.getCallers(cur.name)) {
          if (!this.edgeBindsTo(edge.callerFile, cur.name, cur.file)) continue;
          push({
            name: edge.callerName,
            file: edge.callerFile,
            line: edge.line,
            reason: 'calls',
            detail: `calls ${cur.name}`,
            hops: hop,
            resolved: cur.file !== undefined,
          });
          if (edge.callerName !== '<module>') {
            // Keep a name-only walk name-only; only carry file context forward
            // when the seed opted into resolution, so the next hop resolves the
            // caller's own callers against the caller's file.
            const nextFile = cur.file !== undefined ? edge.callerFile : undefined;
            const k = `${edge.callerName}|${nextFile ?? ''}`;
            if (!visited.has(k)) {
              visited.add(k);
              next.push({ name: edge.callerName, file: nextFile });
            }
          }
        }
      }
      frontier = next;
    }

    // Direct type users + subtypes + importers (1 hop — not walked transitively).
    for (const s of seeds) {
      const resolved = s.file !== undefined;
      for (const edge of this.getTypeUsers(s.name)) {
        if (!this.edgeBindsTo(edge.userFile, s.name, s.file)) continue;
        push({
          name: edge.userName,
          file: edge.userFile,
          line: edge.line,
          reason: 'type-use',
          detail: `${edge.role} typed ${s.name}`,
          hops: 1,
          resolved,
        });
      }
      for (const edge of this.getSubtypes(s.name)) {
        if (!this.edgeBindsTo(edge.childFile, s.name, s.file)) continue;
        push({
          name: edge.childName,
          file: edge.childFile,
          reason: 'subtype',
          detail: `${edge.kind} ${s.name}`,
          hops: 1,
          resolved,
        });
      }
      // Importers: files that import the changed symbol's defining file. In
      // resolved mode we additionally require the dependent to import THIS name.
      const defFiles = s.file
        ? [s.file]
        : this.lookupSymbol(s.name)
            .filter((d) => d.exported)
            .map((d) => d.filePath);
      for (const defFile of defFiles) {
        const depKeys = new Set([defFile, defFile.replace(/\.[^./]+$/, '')]);
        const dependents = new Set<string>();
        for (const k of depKeys) for (const d of this.getDependents(k)) dependents.add(d);
        for (const dependent of dependents) {
          if (resolved && !this.fileImportsSymbol(dependent, s.name, defFile)) continue;
          push({
            name: dependent,
            file: dependent,
            reason: 'imports',
            detail: `imports ${s.name}`,
            hops: 1,
            resolved,
          });
        }
      }
    }

    items.sort((a, b) => a.hops - b.hops);
    return items.slice(0, limit);
  }

  /** Get all calls made from within a file. */
  getCallsInFile(filePath: string): CallEdge[] {
    return this.callsByFile.get(filePath) || [];
  }

  /** Get types that extend or implement `parentName`. */
  getSubtypes(parentName: string): TypeEdge[] {
    return this.subtypesOf.get(parentName) || [];
  }

  /** Get the extends/implements edges originating from a file. */
  getTypeEdgesInFile(filePath: string): TypeEdge[] {
    return this.typeEdgesByFile.get(filePath) || [];
  }

  /** Get the parent types (extends/implements) for a given child type name. */
  getSupertypes(childName: string): TypeEdge[] {
    return this.childTypesOf.get(childName) ?? [];
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

  getFileContent(filePath: string): string | undefined {
    return this.fileContents.get(filePath);
  }

  indexedFilePaths(): Iterable<string> {
    return this.fileHashes.keys();
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

      // Add callers
      const callers = this.getCallers(symbolName);
      if (callers.length > 0 && chars < maxChars) {
        const callerSummary = callers
          .slice(0, 5)
          .map((c) => `${c.callerName} (${c.callerFile}:${c.line})`)
          .join(', ');
        const callLine = `  Called by: ${callerSummary}${callers.length > 5 ? ` (+${callers.length - 5} more)` : ''}`;
        parts.push(callLine);
        chars += callLine.length;
      }

      // Add type hierarchy
      if (def.type === 'class' || def.type === 'interface') {
        const supertypes = this.getSupertypes(symbolName);
        if (supertypes.length > 0 && chars < maxChars) {
          const superLine = `  Extends/implements: ${supertypes.map((e) => e.parentName).join(', ')}`;
          parts.push(superLine);
          chars += superLine.length;
        }
        const subtypes = this.getSubtypes(symbolName);
        if (subtypes.length > 0 && chars < maxChars) {
          const subLine = `  Subtypes: ${subtypes.map((e) => e.childName).join(', ')}`;
          parts.push(subLine);
          chars += subLine.length;
        }
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

    const calls: CallEdge[] = [];
    for (const edges of this.callsByFile.values()) {
      calls.push(...edges);
    }

    const typeEdges: TypeEdge[] = [];
    for (const edges of this.typeEdgesByFile.values()) {
      typeEdges.push(...edges);
    }

    const typeUses: TypeUseEdge[] = [];
    for (const edges of this.typeUsesByFile.values()) {
      typeUses.push(...edges);
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
      calls,
      typeEdges,
      typeUses,
      fileHashes,
    };
  }

  /** Deserialize from persisted format. */
  static fromJSON(data: SymbolGraphData): SymbolGraph | null {
    if (!data || data.version !== GRAPH_VERSION) return null;
    if (!Array.isArray(data.symbols) || !Array.isArray(data.imports)) return null;

    const graph = new SymbolGraph();

    // Group symbols by file
    const byFile = new Map<string, SymbolEntry[]>();
    for (const sym of data.symbols) {
      if (!sym || typeof sym.filePath !== 'string') continue;
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
      if (!edge || typeof edge.fromFile !== 'string') continue;
      const list = importsByFrom.get(edge.fromFile);
      if (list) {
        list.push(edge);
      } else {
        importsByFrom.set(edge.fromFile, [edge]);
      }
    }

    // Group calls by callerFile
    const callsByFrom = new Map<string, CallEdge[]>();
    for (const edge of data.calls || []) {
      if (!edge || typeof edge.callerFile !== 'string' || typeof edge.line !== 'number') continue;
      const list = callsByFrom.get(edge.callerFile);
      if (list) {
        list.push(edge);
      } else {
        callsByFrom.set(edge.callerFile, [edge]);
      }
    }

    // Group type edges by childFile
    const typeEdgesByFrom = new Map<string, TypeEdge[]>();
    for (const edge of data.typeEdges || []) {
      if (!edge || typeof edge.childFile !== 'string') continue;
      const list = typeEdgesByFrom.get(edge.childFile);
      if (list) {
        list.push(edge);
      } else {
        typeEdgesByFrom.set(edge.childFile, [edge]);
      }
    }

    // Group type-use edges by userFile
    const typeUsesByFrom = new Map<string, TypeUseEdge[]>();
    for (const edge of data.typeUses || []) {
      if (!edge || typeof edge.userFile !== 'string') continue;
      const list = typeUsesByFrom.get(edge.userFile);
      if (list) {
        list.push(edge);
      } else {
        typeUsesByFrom.set(edge.userFile, [edge]);
      }
    }

    // Collect all files referenced by any edge type
    const allFiles = new Set<string>();
    for (const f of byFile.keys()) allFiles.add(f);
    for (const f of importsByFrom.keys()) allFiles.add(f);
    for (const f of callsByFrom.keys()) allFiles.add(f);
    for (const f of typeEdgesByFrom.keys()) allFiles.add(f);
    for (const f of typeUsesByFrom.keys()) allFiles.add(f);

    // Rebuild the graph file by file
    for (const filePath of allFiles) {
      const symbols = byFile.get(filePath) || [];
      const imports = importsByFrom.get(filePath) || [];
      const fileCalls = callsByFrom.get(filePath) || [];
      const fileTypeEdges = typeEdgesByFrom.get(filePath) || [];
      const fileTypeUses = typeUsesByFrom.get(filePath) || [];
      const hash = data.fileHashes[filePath] || '';
      graph.addFile(filePath, symbols, imports, hash, fileCalls, fileTypeEdges, fileTypeUses);
    }

    return graph;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
