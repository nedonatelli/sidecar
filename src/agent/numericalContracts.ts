/**
 * Numerical-correctness contracts (the §5 vertical) — wired onto the code
 * graph's type-flow edges.
 *
 * A "numerical kernel" is a function whose signature touches an array/quantity
 * type (numpy `ndarray`, `NDArray`, a tensor, a `Quantity`, …). Bare `np.ndarray`
 * annotations carry no shape, dtype, or unit information, so a green test suite
 * says nothing about whether the *physics* is right. This analyzer uses the
 * graph to locate the kernels, then checks whether each one declares a
 * shape/dtype/unit contract — surfacing the ones that don't.
 *
 * It does NOT propagate shapes across calls yet (that needs a contract spec to
 * propagate); this is the coverage rung — "does every numerical kernel state
 * its contract?" — which is the precondition for everything downstream.
 */

import type { SymbolGraph } from '../config/symbolGraph.js';

/** Type-name heads that mark a function as numerical. Matched against the
 *  graph's type-use edges (which capture the identifier heads of annotations —
 *  `np.ndarray` surfaces as `ndarray`). */
export const NUMERICAL_TYPE_NAMES: ReadonlySet<string> = new Set([
  'ndarray',
  'NDArray',
  'ArrayLike',
  'Tensor',
  'DataFrame',
  'Series',
  'Quantity', // pint units
]);

/** Evidence that a numerical kernel declares a contract, strongest first. Kept
 *  conservative: weak/ambiguous forms are NOT accepted, so the gate errs toward
 *  flagging an uncontracted kernel rather than passing a bare one. */
const CONTRACT_PATTERNS: ReadonlyArray<{ kind: ContractKind; re: RegExp }> = [
  // Shaped/typed array annotations: nptyping NDArray[Shape[...]], jaxtyping
  // Float[Array, "n 3"], numpy.typing npt.NDArray[np.float64], dtype generics.
  {
    kind: 'shaped-type',
    re: /\bNDArray\[|\bShape\[|\b(?:Float|Int|UInt|Bool|Complex)\d*\[\s*[\w.]+\s*,|npt\.NDArray\[\s*np\.|\[\s*np\.(?:float|int|uint|complex|bool)\w*\s*\]/,
  },
  // Explicit runtime shape/dtype assertions or numpy testing helpers.
  {
    kind: 'assertion',
    re: /\bassert\b[^\n]*\b\w+\.(?:shape|ndim|dtype|size)\b|np\.testing\.assert_|\bnp\.broadcast_shapes\(/,
  },
  // Docstring shape/dtype specification, e.g. "shape (N, 3)", "(N, 3) ndarray",
  // "dtype: float64", "ndim: 2".
  {
    kind: 'docstring',
    re: /\bshape\s*[:=]?\s*\(|\(\s*[A-Za-z0-9_]+\s*,[^)\n]*\)\s*(?:np\.)?ndarray|\bdtype\s*[:=]\s*\w|\bndim\s*[:=]\s*\d/i,
  },
];

export type ContractKind = 'shaped-type' | 'assertion' | 'docstring';

export interface NumericalKernel {
  name: string;
  file: string;
  startLine: number; // 1-based
  endLine: number;
  /** Which signature positions are numerical (param / return / variable). */
  roles: string[];
  hasContract: boolean;
  contractKind?: ContractKind;
}

/** Reader for a graph-relative file's source. Returns undefined if unavailable. */
export type SourceReader = (file: string) => string | undefined;

/** Detect a contract in a function's source slice; null if none. */
export function detectContract(source: string): ContractKind | null {
  for (const { kind, re } of CONTRACT_PATTERNS) {
    if (re.test(source)) return kind;
  }
  return null;
}

/**
 * Find numerical kernels via the graph's type-use edges and classify each as
 * contracted or not. `fileFilter` restricts the scan (e.g. to edited files).
 */
export function findNumericalKernels(
  graph: SymbolGraph,
  readSource: SourceReader,
  opts?: { fileFilter?: (file: string) => boolean },
): NumericalKernel[] {
  // Collect (file → funcName → roles) for every numerical type-use.
  const byFunc = new Map<string, { file: string; name: string; roles: Set<string> }>();
  for (const typeName of NUMERICAL_TYPE_NAMES) {
    for (const edge of graph.getTypeUsers(typeName)) {
      if (edge.userName === '<module>') continue;
      if (opts?.fileFilter && !opts.fileFilter(edge.userFile)) continue;
      const key = `${edge.userFile}::${edge.userName}`;
      const existing = byFunc.get(key);
      if (existing) existing.roles.add(edge.role);
      else byFunc.set(key, { file: edge.userFile, name: edge.userName, roles: new Set([edge.role]) });
    }
  }

  const kernels: NumericalKernel[] = [];
  const sourceCache = new Map<string, string | undefined>();
  for (const { file, name, roles } of byFunc.values()) {
    const sym = graph.getSymbolsInFile(file).find((s) => s.name === name);
    if (!sym) continue;

    if (!sourceCache.has(file)) sourceCache.set(file, readSource(file));
    const content = sourceCache.get(file);
    let contractKind: ContractKind | null = null;
    if (content) {
      const lines = content.split('\n');
      const slice = lines.slice(Math.max(0, sym.startLine), sym.endLine + 1).join('\n');
      contractKind = detectContract(slice);
    }

    kernels.push({
      name,
      file,
      startLine: sym.startLine + 1,
      endLine: sym.endLine + 1,
      roles: [...roles].sort(),
      hasContract: contractKind !== null,
      contractKind: contractKind ?? undefined,
    });
  }

  kernels.sort((a, b) => (a.file === b.file ? a.startLine - b.startLine : a.file.localeCompare(b.file)));
  return kernels;
}

/** The kernels that lack any contract — the actionable set. */
export function uncontractedKernels(kernels: readonly NumericalKernel[]): NumericalKernel[] {
  return kernels.filter((k) => !k.hasContract);
}
