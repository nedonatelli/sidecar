/**
 * Shared data types for the symbol graph: the symbol/edge records, the
 * change-impact report shapes, and the persistence format. Pure type
 * declarations — no logic, no VS Code — imported across the codebase (and
 * re-exported from symbolGraph.ts for the historical import surface).
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

/** A function/method call from one symbol to another. */
export interface CallEdge {
  callerFile: string;
  callerName: string; // qualified name of the calling function/method
  calleeName: string; // name of the called function/method
  line: number; // 1-based line of the call site
}

/** A type relationship (extends, implements). */
export interface TypeEdge {
  childFile: string;
  childName: string;
  parentName: string;
  kind: 'extends' | 'implements';
}

/**
 * A use of a named type inside a symbol's signature/body — the return type,
 * a parameter type, or a typed variable. Feeds change-impact analysis: if the
 * referenced type changes, every user is potentially affected.
 */
export interface TypeUseEdge {
  userFile: string;
  userName: string; // qualified name of the symbol that references the type
  typeName: string;
  role: 'return' | 'param' | 'variable';
  line: number; // 1-based
}

/** One entry in a change-impact report (see {@link SymbolGraph.impactOf}). */
export interface ImpactedItem {
  /** The affected symbol (or file path, for file-level import impact). */
  name: string;
  file: string;
  line?: number;
  reason: 'calls' | 'type-use' | 'subtype' | 'imports';
  /** Human-readable explanation, e.g. "calls requireAuth" or "param typed AuthConfig". */
  detail: string;
  /** Hop distance from the changed symbol (1 = direct). */
  hops: number;
  /**
   * True when the edge was import-resolved to the changed symbol's defining
   * file (binding-accurate), false when matched on name alone. Callers that
   * block (vs. advise) should require `resolved` so name collisions never gate.
   */
  resolved: boolean;
}

/**
 * A changed symbol for impact analysis. When `file` is given, edges are
 * resolved against the import graph so only references that actually bind to
 * THIS definition surface — eliminating same-name collisions across files.
 * Omit `file` for name-only (Stage 1) over-approximation.
 */
export interface ImpactSeed {
  name: string;
  file?: string;
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
  calls: CallEdge[];
  typeEdges: TypeEdge[];
  typeUses: TypeUseEdge[];
  fileHashes: Record<string, string>;
}
