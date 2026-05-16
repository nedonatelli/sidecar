/** Strip leading range operators (^, ~, >=, <=, >, <, =, *, v) and return just the version string. */
export function stripRange(version: string): string {
  const stripped =
    version
      .trim()
      .replace(/^[^0-9]*/, '')
      .split(/[\s,]+/)[0] ?? '';
  return stripped || '0.0.0';
}

/** Split a version string into numeric parts for comparison. */
function parseParts(v: string): number[] {
  return v
    .replace(/[-+].*$/, '') // drop pre-release and build metadata
    .split('.')
    .map((p) => parseInt(p.replace(/[^0-9]/g, ''), 10) || 0);
}

/** Returns true if version `a` is strictly greater than version `b`. */
export function semverGt(a: string, b: string): boolean {
  const pa = parseParts(stripRange(a));
  const pb = parseParts(stripRange(b));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return false;
}

/** Returns true if two version strings represent the same release. */
export function semverEq(a: string, b: string): boolean {
  return !semverGt(a, b) && !semverGt(b, a);
}
