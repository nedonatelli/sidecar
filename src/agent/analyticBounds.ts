/**
 * Analytic-bound contracts (the §5 vertical — pillar 2, "prove the physics").
 *
 * Shape/dtype/unit contracts (`numericalContracts.ts`) answer "is the array the
 * right shape?". They say nothing about whether the *values* are physically
 * admissible. A probability must lie in [0, 1]; an energy or a norm must be
 * ≥ 0; a normalized distribution must sum to 1; a reflection coefficient's
 * magnitude must be ≤ 1. These are ANALYTIC BOUNDS — known-correct constraints
 * a result must satisfy independent of any test's chosen inputs.
 *
 * This module parses bounds a kernel DECLARES (in a comment / docstring /
 * decorator) and checks whether the implementation actually ENFORCES them (an
 * assertion, a clip, a raise-on-violation). A declared-but-unenforced-and-
 * untested bound is the gap the gate surfaces — and `boundAssertion` emits the
 * exact concrete check to close it, so the fix is mechanical, not a stub.
 *
 * Pure and conservative, mirroring `numericalContracts.ts`: ambiguous forms are
 * not accepted, and the gate that consumes this is opt-in + advisory-first.
 */

export type BoundKind = 'range' | 'lower' | 'upper' | 'sign-nonneg' | 'sign-pos' | 'conservation' | 'custom';

export interface BoundDeclaration {
  kind: BoundKind;
  /** The raw predicate text as written (for the reprompt + custom asserts). */
  raw: string;
  /** 1-based line within the analyzed source slice. */
  line: number;
  /** Numeric lower bound, when parseable (range / lower). */
  lower?: number;
  /** Numeric upper bound, when parseable (range / upper). */
  upper?: number;
  /** The variable the bound constrains — the return value, usually `result`. */
  resultVar: string;
  where: 'comment' | 'docstring' | 'decorator';
}

const NUM = String.raw`[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?`;

/** Lines that DECLARE a bound: `# bounds: …`, `# invariant: …`, docstring
 *  `Bounds:` / `Invariant:`, or a `@bounds("…")` / `@ensures("…")` decorator. */
const DECL_PATTERNS: ReadonlyArray<{ re: RegExp; where: BoundDeclaration['where']; invariant?: boolean }> = [
  { re: /^\s*#\s*bounds?\s*:\s*(.+?)\s*$/i, where: 'comment' },
  { re: /^\s*#\s*invariant\s*:\s*(.+?)\s*$/i, where: 'comment', invariant: true },
  { re: /@(?:bounds|ensures)\s*\(\s*["'](.+?)["']\s*\)/, where: 'decorator' },
  { re: /^\s*bounds?\s*:\s*(.+?)\s*$/i, where: 'docstring' },
  { re: /^\s*invariant\s*:\s*(.+?)\s*$/i, where: 'docstring', invariant: true },
];

/** Classify a predicate string into a kind + numeric bounds. `result` is the
 *  variable name the predicate constrains (default `result`). */
export function classifyBound(predicate: string, invariant = false): Omit<BoundDeclaration, 'line' | 'where'> {
  const raw = predicate.trim();
  const resultVar = /\bresult\b/.test(raw) ? 'result' : (raw.match(/\b([A-Za-z_]\w*)\b/)?.[1] ?? 'result');
  if (invariant || /\bsum\s*\(|\bmean\s*\(|==|\bconserv/i.test(raw)) {
    return { kind: 'conservation', raw, resultVar };
  }
  // Two-sided range: A <= result <= B  (or < ).
  const range = raw.match(new RegExp(String.raw`(${NUM})\s*<=?\s*\w+\s*<=?\s*(${NUM})`));
  if (range) {
    return { kind: 'range', raw, resultVar, lower: Number(range[1]), upper: Number(range[2]) };
  }
  // result >= A  /  result > A  (and the flipped A <= result).
  const lower =
    raw.match(new RegExp(String.raw`\w+\s*>=?\s*(${NUM})`)) ?? raw.match(new RegExp(String.raw`(${NUM})\s*<=?\s*\w+`));
  const upper =
    raw.match(new RegExp(String.raw`\w+\s*<=?\s*(${NUM})`)) ?? raw.match(new RegExp(String.raw`(${NUM})\s*>=?\s*\w+`));
  const strict = /[<>](?!=)/.test(raw);
  if (lower && !upper) {
    const lo = Number(lower[1]);
    if (lo === 0) return { kind: strict ? 'sign-pos' : 'sign-nonneg', raw, resultVar, lower: 0 };
    return { kind: 'lower', raw, resultVar, lower: lo };
  }
  if (upper && !lower) return { kind: 'upper', raw, resultVar, upper: Number(upper[1]) };
  return { kind: 'custom', raw, resultVar };
}

/** Parse every bound declaration in a source slice (a kernel's body/docstring). */
export function parseBoundDeclarations(source: string): BoundDeclaration[] {
  const out: BoundDeclaration[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { re, where, invariant } of DECL_PATTERNS) {
      const m = lines[i].match(re);
      if (m && m[1] && m[1].trim()) {
        out.push({ ...classifyBound(m[1], invariant), line: i + 1, where });
        break; // one declaration per line
      }
    }
  }
  return out;
}

/**
 * The concrete Python assertion that ENFORCES a bound — array-safe via `np.all`
 * so it holds for scalars and ndarrays alike. This is what the gate tells the
 * agent to add; a real check, never a placeholder.
 */
export function boundAssertion(bound: BoundDeclaration): string {
  const r = bound.resultVar;
  const msg = (t: string): string => `, "${r} violates bound: ${t.replace(/"/g, "'")}"`;
  switch (bound.kind) {
    case 'range':
      return `assert np.all(${r} >= ${bound.lower}) and np.all(${r} <= ${bound.upper})${msg(bound.raw)}`;
    case 'lower':
      return `assert np.all(${r} >= ${bound.lower})${msg(bound.raw)}`;
    case 'upper':
      return `assert np.all(${r} <= ${bound.upper})${msg(bound.raw)}`;
    case 'sign-nonneg':
      return `assert np.all(${r} >= 0)${msg(bound.raw)}`;
    case 'sign-pos':
      return `assert np.all(${r} > 0)${msg(bound.raw)}`;
    case 'conservation':
    case 'custom':
      return `assert ${bound.raw}${msg(bound.raw)}`;
  }
}

/** Guards that plausibly ENFORCE a bound in a kernel body: an assertion on the
 *  result, a clip/clamp, numpy testing helpers, or a raise-on-violation. */
const ENFORCE_PATTERNS: readonly RegExp[] = [
  /\bassert\b[^\n]*\b(?:np\.all|np\.testing|>=|<=|[<>]|==)/,
  /\b(?:np\.)?clip\s*\(|\.clip\s*\(/,
  /\bnp\.testing\.assert_/,
  /\braise\b[^\n]*(?:Error|Exception)\b/,
  /\bnp\.clip\b|\bnp\.maximum\b|\bnp\.minimum\b/,
];

/** Heuristic: does `kernelBody` already enforce `bound`? Conservative — a clear
 *  guard mentioning the result or a clamp/raise counts; absence flags the gap. */
export function boundEnforced(kernelBody: string, bound: BoundDeclaration): boolean {
  const mentionsResult = new RegExp(String.raw`\b${bound.resultVar}\b`).test(kernelBody);
  for (const re of ENFORCE_PATTERNS) {
    if (re.test(kernelBody)) {
      // A clip/clamp/raise is accepted on its own; an assert must plausibly
      // touch the result (else it's asserting something unrelated).
      if (/assert/.test(re.source) && !mentionsResult) continue;
      return true;
    }
  }
  return false;
}

export interface BoundFinding {
  bound: BoundDeclaration;
  /** The assertion that would close the gap. */
  fix: string;
}

/** Declared bounds in a kernel body that are NOT enforced — the actionable set. */
export function unenforcedBounds(kernelBody: string): BoundFinding[] {
  return parseBoundDeclarations(kernelBody)
    .filter((b) => !boundEnforced(kernelBody, b))
    .map((b) => ({ bound: b, fix: boundAssertion(b) }));
}

// --- graph orchestration (the gate's entry point) ---------------------------

export type SourceReader = (file: string) => string | undefined;

export interface FileBoundFinding {
  func: string;
  file: string;
  /** 1-based line of the bound declaration in the file. */
  fileLine: number;
  bound: BoundDeclaration;
  /** Concrete assertion that would enforce the bound. */
  fix: string;
}

/** Minimal symbol-graph surface this module needs (kept structural so tests can
 *  supply a fake without the full `SymbolGraph`). */
export interface BoundGraph {
  getSymbolsInFile(file: string): ReadonlyArray<{ name: string; startLine: number; endLine: number }>;
}

/**
 * For each function symbol in `files`, slice its body and flag declared bounds
 * that nothing enforces. Per-function slicing (not whole-file) so a guard in an
 * unrelated function can't mask a gap. `startLine`/`endLine` are 0-based (graph
 * convention); the reported `fileLine` is 1-based.
 */
export function findUnenforcedBoundsInFiles(
  files: Iterable<string>,
  graph: BoundGraph,
  readSource: SourceReader,
): FileBoundFinding[] {
  const out: FileBoundFinding[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const content = readSource(file);
    if (!content) continue;
    const lines = content.split('\n');
    for (const sym of graph.getSymbolsInFile(file)) {
      const slice = lines.slice(sym.startLine, sym.endLine + 1).join('\n');
      for (const f of unenforcedBounds(slice)) {
        const fileLine = sym.startLine + f.bound.line; // slice-relative (1-based) → file (1-based)
        const key = `${file}:${fileLine}:${f.bound.raw}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ func: sym.name, file, fileLine, bound: f.bound, fix: f.fix });
      }
    }
  }
  out.sort((a, b) => (a.file === b.file ? a.fileLine - b.fileLine : a.file.localeCompare(b.file)));
  return out;
}
