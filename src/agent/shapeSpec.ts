/**
 * Canonical shape model + parsers for numerical contract propagation (§5).
 *
 * Turns the contract forms the agent writes — jaxtyping `Float[Array, "n 3"]`,
 * nptyping `NDArray[Shape["3, N"], Float]`, numpy.typing `npt.NDArray[np.float64]`,
 * and `assert x.shape == (3, N)` tuples — into a single `ShapeSpec`, then
 * compares two specs for an unambiguous conflict. Pure and string-only so it's
 * trivially testable and reusable by every propagation rung.
 *
 * Conservative by design: a symbolic dim (`N`) is treated as compatible with
 * anything (it *could* equal that value), so only RANK mismatches, conflicting
 * LITERAL dims, and conflicting dtypes are reported. We never invent a conflict
 * we can't prove from the contracts alone.
 */

/** A single dimension: a literal extent, a symbolic name, or `'...'` (variadic). */
export type Dim = number | string;

export interface ShapeSpec {
  /** Ordered dims, or null when the contract states a dtype but no shape. */
  dims: Dim[] | null;
  dtype?: string;
}

export type ShapeConflictKind = 'rank' | 'dim' | 'dtype';

export interface ShapeConflict {
  kind: ShapeConflictKind;
  detail: string;
}

/** Normalize a dtype token: strip a `np.`/`numpy.` prefix, lowercase. */
export function normalizeDtype(d: string): string {
  return d.replace(/^(?:np|numpy)\./, '').toLowerCase();
}

function parseDimToken(tok: string): Dim | null {
  const t = tok.trim().replace(/^["']|["']$/g, '');
  if (!t) return null;
  if (t === '...' || t === '*') return '...';
  if (/^\d+$/.test(t)) return Number(t);
  return t;
}

/** Split a dim list on `sep`, parsing each token; empties dropped. */
function parseDims(s: string, sep: RegExp): Dim[] {
  return s
    .split(sep)
    .map(parseDimToken)
    .filter((d): d is Dim => d !== null);
}

/**
 * Parse a shape from a type-annotation expression. Returns null for an
 * unshaped/bare type (e.g. `np.ndarray`) — i.e. "no contract here".
 */
export function parseTypeShape(expr: string): ShapeSpec | null {
  // jaxtyping: DType[array, "n 3"] — space-separated dims.
  const jax = expr.match(/\b(Float|Int|UInt|Bool|Complex|Shaped|Num|Inexact)\w*\s*\[\s*[\w.]+\s*,\s*["']([^"']*)["']/);
  if (jax) return { dtype: normalizeDtype(jax[1]), dims: parseDims(jax[2], /\s+/) };

  // nptyping: Shape["3, N"] — comma-separated dims; optional trailing DType.
  const np = expr.match(/\bShape\s*\[\s*["']([^"']*)["']\s*\]/);
  if (np) {
    const dt = expr.match(/\bShape\[[^\]]*\]\s*,\s*([\w.]+)/);
    return { dims: parseDims(np[1], /\s*,\s*/), dtype: dt ? normalizeDtype(dt[1]) : undefined };
  }

  // dtype-only: NDArray[np.float64] / npt.NDArray[Any, np.float64] — no shape.
  if (!/\bShape\b/.test(expr)) {
    const dt = expr.match(/\bNDArray\s*\[\s*(?:[\w.]+\s*,\s*)?(?:np\.|numpy\.)?([a-zA-Z]\w*)\s*\]/);
    if (dt) return { dims: null, dtype: normalizeDtype(dt[1]) };
  }
  return null;
}

/** Parse a shape from a Python tuple literal, e.g. `(3, N)` or `(3,)`. */
export function parseShapeTuple(expr: string): ShapeSpec | null {
  const m = expr.match(/\(([^)]*)\)/);
  if (!m) return null;
  const dims = parseDims(m[1], /\s*,\s*/);
  return { dims };
}

/**
 * The provable conflict between two specs, or null. Symbolic dims are
 * wildcards; only rank mismatches (absent a variadic), conflicting literal dims
 * at the same position, and conflicting dtypes count.
 */
export function shapeConflict(a: ShapeSpec, b: ShapeSpec): ShapeConflict | null {
  if (a.dtype && b.dtype && normalizeDtype(a.dtype) !== normalizeDtype(b.dtype)) {
    return { kind: 'dtype', detail: `dtype ${a.dtype} vs ${b.dtype}` };
  }
  if (a.dims && b.dims) {
    const variadic = a.dims.includes('...') || b.dims.includes('...');
    if (!variadic) {
      if (a.dims.length !== b.dims.length) {
        return {
          kind: 'rank',
          detail: `rank ${a.dims.length} vs ${b.dims.length} ((${fmt(a.dims)}) vs (${fmt(b.dims)}))`,
        };
      }
      for (let i = 0; i < a.dims.length; i++) {
        const x = a.dims[i];
        const y = b.dims[i];
        if (typeof x === 'number' && typeof y === 'number' && x !== y) {
          return { kind: 'dim', detail: `dim ${i}: ${x} vs ${y} ((${fmt(a.dims)}) vs (${fmt(b.dims)}))` };
        }
      }
    }
  }
  return null;
}

function fmt(dims: Dim[]): string {
  return dims.join(', ');
}
