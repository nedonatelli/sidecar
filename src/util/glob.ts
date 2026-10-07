/**
 * Simple glob matcher supporting *, **, and ? against relative file paths.
 * Avoids a runtime dependency on minimatch/picomatch.
 *
 * Both `pattern` and `filePath` are normalised to forward-slash form first
 * so Windows paths work transparently.
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  return globToRegExp(pattern).test(filePath.replace(/\\/g, '/'));
}

/**
 * Translate a glob to an anchored RegExp: `*` is any run of characters within
 * one path segment, `?` one such character, and `**` any depth. A `**` that
 * is a whole segment followed by `/` matches ZERO or more directories, so
 * `src/<star><star>/<star>.ts` matches `src/x.ts` as well as `src/a/b/x.ts`. Turning `**`
 * into `.*` while keeping both slashes required at least one directory in
 * between, and `src/x.ts` did not match. The one translator for every glob
 * SideCar evaluates (matchGlob, model routing rules, SIDECAR.md @paths).
 */
export function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      const wholeSegment = i === 0 || p[i - 1] === '/';
      if (wholeSegment && p[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}
