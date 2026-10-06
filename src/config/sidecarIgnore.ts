import { workspace, Uri } from 'vscode';

// .sidecarignore: paths the user keeps OUT of SideCar's context. The docs
// present it as the way to exclude sensitive files from context indexing, so
// every index that reads file content must apply it -- the workspace index's
// full scan and cache restore, and the symbol indexer, all used to skip it.

/** A compiled ignore pattern: matched against the whole path and each segment. */
export type IgnoreMatcher = (relativePath: string) => boolean;

/** Turn `*` / `?` globs into a regex over one path or segment (no `/` crossing). */
function globToRegex(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${body}$`, 'i');
}

/**
 * Parse .sidecarignore text. Supported, per line: a directory or file name
 * (`secrets`, `.env.local`), a path prefix (`config/prod`), and `*`/`?` globs
 * on a name or path (`*.pem`, `secrets/*.json`). A trailing `/`, `/*` or
 * `/**` means the directory and everything under it. `#` starts a comment.
 */
export function parseSidecarIgnore(text: string): IgnoreMatcher[] {
  const matchers: IgnoreMatcher[] = [];
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) continue;
    const pattern = raw
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/(\*\*?)?$/, '');
    if (!pattern) continue;
    if (/[*?]/.test(pattern)) {
      const re = globToRegex(pattern);
      matchers.push((rel) => {
        if (re.test(rel)) return true;
        const parts = rel.split('/');
        // A name glob (`*.pem`) matches any segment; a path glob matches any prefix.
        if (!pattern.includes('/')) return parts.some((p) => re.test(p));
        for (let i = 1; i <= parts.length; i++) if (re.test(parts.slice(0, i).join('/'))) return true;
        return false;
      });
    } else if (pattern.includes('/')) {
      const lower = pattern.toLowerCase();
      matchers.push((rel) => {
        const r = rel.toLowerCase();
        return r === lower || r.startsWith(lower + '/');
      });
    } else {
      const lower = pattern.toLowerCase();
      matchers.push((rel) => rel.toLowerCase().split('/').includes(lower));
    }
  }
  return matchers;
}

/** True when `relativePath` (forward slashes) is ignored by any matcher. */
export function isSidecarIgnored(relativePath: string, matchers: readonly IgnoreMatcher[]): boolean {
  const rel = relativePath.replace(/\\/g, '/');
  return matchers.some((m) => m(rel));
}

/** Read and parse `<root>/.sidecarignore`; no file means no patterns. */
export async function loadSidecarIgnore(rootUri: Uri): Promise<IgnoreMatcher[]> {
  try {
    const bytes = await workspace.fs.readFile(Uri.joinPath(rootUri, '.sidecarignore'));
    return parseSidecarIgnore(Buffer.from(bytes).toString('utf-8'));
  } catch {
    return [];
  }
}
