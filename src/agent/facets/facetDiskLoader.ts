import { workspace, Uri } from 'vscode';
import * as path from 'path';
import { parseFacetFile, FacetValidationError, type FacetDefinition } from './facetLoader.js';
import { buildFacetRegistry, mergeWithBuiltInFacets, type FacetRegistry } from './facetRegistry.js';

// ---------------------------------------------------------------------------
// Facet disk loader (v0.66 chunk 3.5a).
//
// Scans the workspace + configured registry paths for facet markdown
// files, parses each through `parseFacetFile`, merges with built-ins,
// and returns a validated `FacetRegistry` (or a structured failure
// record naming every bad file). Separate from the loader primitive
// (chunk 3.1) so that module stays filesystem-free.
//
// Sources, in merge order (last wins on id collision):
//   1. built-in catalog (always present)
//   2. `<workspaceRoot>/.sidecar/facets/*.md`   — source: 'project'
//   3. paths from `sidecar.facets.registry`     — source: 'user'
//
// Result is a `LoadFacetsOutcome` tuple: always carries the best-effort
// registry the loader COULD build plus a list of per-file errors so the
// Expert Panel can surface them without hiding the valid facets.
// ---------------------------------------------------------------------------

export interface LoadFacetError {
  readonly filePath: string;
  readonly reason: FacetValidationError['reason'] | 'io-error';
  readonly message: string;
}

export interface LoadFacetsOutcome {
  /** Registry built from built-ins + every valid disk facet. */
  readonly registry: FacetRegistry;
  /** Per-file errors — both parse failures and registry-build failures. */
  readonly errors: readonly LoadFacetError[];
}

export interface LoadFacetsOptions {
  /** Absolute paths to individual facet files. From `sidecar.facets.registry`. */
  readonly registryPaths?: readonly string[];
  /** Scan this workspace-root directory's `.sidecar/facets/*.md`. */
  readonly workspaceRoot?: string;
  /** Test/injection seam — replaces real fs reads with an in-memory map. */
  readonly fsOverride?: FacetFsOverride;
}

/**
 * Filesystem abstraction. Real extension uses `workspace.fs`; tests
 * inject a map so they don't have to reach real disk. Both methods
 * are async because the production implementation is.
 */
export interface FacetFsOverride {
  readFile(absolutePath: string): Promise<string>;
  readDirectory(absolutePath: string): Promise<string[]>;
}

/**
 * Load every facet discoverable on disk (via `registryPaths` +
 * `workspaceRoot/.sidecar/facets/*.md`), merge with built-ins, and
 * return the validated registry. Per-file errors never abort the
 * load — users get the largest possible registry plus a clear list
 * of what failed to parse.
 *
 * Registry-level errors (duplicate ids across sources, cycle in
 * `dependsOn`, unknown dependency) are reported as synthetic entries
 * in `errors` pointing at the offending facet; the returned registry
 * omits the disk contributions that caused the break so the user
 * still gets the built-in catalog.
 */
export async function loadFacetRegistry(options: LoadFacetsOptions): Promise<LoadFacetsOutcome> {
  const errors: LoadFacetError[] = [];
  const fs = options.fsOverride ?? defaultFacetFsOverride();

  const parsed: FacetDefinition[] = [];
  const workspaceDir = options.workspaceRoot ? path.join(options.workspaceRoot, '.sidecar', 'facets') : undefined;

  if (workspaceDir) {
    for (const absPath of await listMarkdownFiles(fs, workspaceDir, errors)) {
      const facet = await tryParse(fs, absPath, 'project', errors);
      if (facet) parsed.push(facet);
    }
  }

  for (const absPath of options.registryPaths ?? []) {
    const facet = await tryParse(fs, absPath, 'user', errors);
    if (facet) parsed.push(facet);
  }

  // Per-source duplicate-id rejection (delegated to mergeWithBuiltInFacets
  // via its own check). Dedupe by id within `parsed`: two disk facets
  // sharing an id is an author error; we keep the first and flag the
  // second so the registry stays buildable.
  const deduped: FacetDefinition[] = [];
  const seenIds = new Set<string>();
  for (const facet of parsed) {
    if (seenIds.has(facet.id)) {
      errors.push({
        filePath: facet.filePath,
        reason: 'duplicate-id',
        message: `Duplicate facet id "${facet.id}" — already declared by an earlier disk source`,
      });
      continue;
    }
    seenIds.add(facet.id);
    deduped.push(facet);
  }

  // Merge with built-ins (disk facets override built-in ids) and build
  // the registry. If the merged set still fails cross-facet validation
  // (dependency cycle, unknown dep), we drop the offending disk facets
  // and retry with built-ins alone so the Expert Panel isn't empty.
  try {
    const merged = mergeWithBuiltInFacets(deduped);
    return { registry: buildFacetRegistry(merged), errors };
  } catch (err) {
    if (err instanceof FacetValidationError) {
      errors.push({
        filePath: describeErrorPath(err),
        reason: err.reason,
        message: `Disk facets rejected by registry validation: ${err.message} — falling back to built-ins only`,
      });
      // Fallback: built-ins only.
      return { registry: buildFacetRegistry(mergeWithBuiltInFacets([])), errors };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tryParse(
  fs: FacetFsOverride,
  filePath: string,
  source: FacetDefinition['source'],
  errors: LoadFacetError[],
): Promise<FacetDefinition | null> {
  try {
    const raw = await fs.readFile(filePath);
    return parseFacetFile(filePath, raw, source);
  } catch (err) {
    if (err instanceof FacetValidationError) {
      errors.push({ filePath, reason: err.reason, message: err.message });
    } else {
      errors.push({
        filePath,
        reason: 'io-error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

async function listMarkdownFiles(fs: FacetFsOverride, dir: string, errors: LoadFacetError[]): Promise<string[]> {
  try {
    const entries = await fs.readDirectory(dir);
    return entries
      .filter((name) => name.endsWith('.md'))
      .map((name) => path.join(dir, name))
      .sort();
  } catch (err) {
    // Missing directory is the expected case for workspaces without
    // any custom facets — don't log that as an error. Other failures
    // (permissions, corrupted FS) surface so the user sees them.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/ENOENT|not found|FileNotFound/i.test(msg)) {
      errors.push({ filePath: dir, reason: 'io-error', message: msg });
    }
    return [];
  }
}

function describeErrorPath(err: FacetValidationError): string {
  const detail = err.detail;
  if (detail && typeof detail === 'object') {
    const path =
      (detail as { filePath?: string; firstPath?: string }).filePath ?? (detail as { firstPath?: string }).firstPath;
    if (typeof path === 'string' && path.length > 0) return path;
  }
  return '(registry)';
}

/**
 * Default filesystem override using `workspace.fs`. Preserves the
 * pattern from `skillLoader.ts` so facet loading feels consistent
 * with existing SideCar file scans.
 */
function defaultFacetFsOverride(): FacetFsOverride {
  return {
    async readFile(absolutePath: string): Promise<string> {
      const bytes = await workspace.fs.readFile(Uri.file(absolutePath));
      return Buffer.from(bytes).toString('utf-8');
    },
    async readDirectory(absolutePath: string): Promise<string[]> {
      const entries = await workspace.fs.readDirectory(Uri.file(absolutePath));
      return entries
        .filter(([, type]) => type === 1) // FileType.File
        .map(([name]) => name);
    },
  };
}
