/**
 * Simple glob matcher supporting *, **, and ? against relative file paths.
 * Avoids a runtime dependency on minimatch/picomatch.
 *
 * Both `pattern` and `filePath` are normalised to forward-slash form first
 * so Windows paths work transparently.
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  const p = pattern.replace(/\\/g, '/');
  const f = filePath.replace(/\\/g, '/');

  const regexStr = p
    .split('**')
    .map((segment) =>
      segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials (except * and ?)
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]'),
    )
    .join('.*');

  return new RegExp(`^${regexStr}$`).test(f);
}
