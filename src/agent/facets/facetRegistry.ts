import { FacetValidationError, builtInFacets, type FacetDefinition } from './facetLoader.js';

// ---------------------------------------------------------------------------
// FacetRegistry (v0.66 chunk 3.2).
//
// Holds the live set of loaded facet definitions and runs cross-facet
// validation (duplicate IDs, dependency-graph cycles). The loader
// (chunk 3.1) is responsible for per-file structural validation; the
// registry composes that with the invariants that only make sense
// when you know about more than one facet at a time.
//
// The registry is deliberately stateless-at-rest — a caller builds it
// once from a list of `FacetDefinition`s (typically built-ins merged
// with disk-loaded project/user facets), validation runs, and the
// result is used read-only by the dispatcher + UI. Mutations are not
// supported; reload = build a new registry.
// ---------------------------------------------------------------------------

export interface FacetRegistry {
  /** All facets, in a stable order (builtins first, then disk in input order). */
  readonly all: readonly FacetDefinition[];
  /** Lookup by id. Returns `undefined` when no facet matches. */
  get(id: string): FacetDefinition | undefined;
  /** Returns true when `id` exists in the registry. */
  has(id: string): boolean;
  /** Dependency-aware topological layers (for UI grouping + dispatch). */
  layers(): readonly (readonly FacetDefinition[])[];
}

/**
 * Build a registry from the given facets. Runs:
 *   1. Duplicate-id rejection (last-write-wins would hide bugs — we
 *      reject loudly instead so authors see the conflict).
 *   2. Unknown-dependency rejection (a facet that depends on `foo`
 *      when no facet with `id === 'foo'` is registered).
 *   3. Cycle rejection via DFS 3-coloring, matching the same contract
 *      the EditPlan validator uses (v0.65 chunk 4.1).
 *
 * Any failure throws a `FacetValidationError` — callers surface the
 * message in the Expert Panel error strip so authors can fix the
 * declaration without reloading the extension.
 */
export function buildFacetRegistry(facets: readonly FacetDefinition[]): FacetRegistry {
  const byId = new Map<string, FacetDefinition>();
  for (const f of facets) {
    if (byId.has(f.id)) {
      const existing = byId.get(f.id)!;
      throw new FacetValidationError(
        `Duplicate facet id "${f.id}" — declared in both ${existing.filePath || '(builtin)'} and ${f.filePath || '(builtin)'}`,
        'duplicate-id',
        { id: f.id, firstPath: existing.filePath, secondPath: f.filePath },
      );
    }
    byId.set(f.id, f);
  }

  // Unknown-dependency check.
  for (const f of facets) {
    for (const dep of f.dependsOn ?? []) {
      if (!byId.has(dep)) {
        throw new FacetValidationError(
          `Facet "${f.id}" depends on "${dep}" but no facet with that id is registered`,
          'invalid-field-shape',
          { facet: f.id, missingDep: dep },
        );
      }
    }
  }

  // Cycle detection via DFS 3-coloring (same shape as EditPlan cycle check).
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const f of facets) color.set(f.id, WHITE);

  const stack: string[] = [];
  function visit(id: string): void {
    color.set(id, GRAY);
    stack.push(id);
    const f = byId.get(id);
    if (f) {
      for (const dep of f.dependsOn ?? []) {
        const c = color.get(dep);
        if (c === GRAY) {
          const cycleStart = stack.indexOf(dep);
          const cyclePath = stack.slice(cycleStart).concat(dep).join(' → ');
          throw new FacetValidationError(`Facet dependency cycle: ${cyclePath}`, 'cycle', { cycle: cyclePath });
        }
        if (c === WHITE) visit(dep);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  }
  for (const f of facets) {
    if (color.get(f.id) === WHITE) visit(f.id);
  }

  // Topological layers — same contract as `layerPlan` from v0.65: each
  // layer's facets have every dependency already landed in earlier
  // layers, so the dispatcher (chunk 3.3) can run a whole layer in
  // parallel and then proceed to the next.
  const layered = computeLayers(facets, byId);

  return {
    all: facets.slice(),
    get: (id: string) => byId.get(id),
    has: (id: string) => byId.has(id),
    layers: () => layered,
  };
}

function computeLayers(
  facets: readonly FacetDefinition[],
  byId: ReadonlyMap<string, FacetDefinition>,
): readonly (readonly FacetDefinition[])[] {
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const f of facets) {
    remaining.set(f.id, (f.dependsOn ?? []).length);
    for (const dep of f.dependsOn ?? []) {
      const list = dependents.get(dep) ?? [];
      list.push(f.id);
      dependents.set(dep, list);
    }
  }

  const layers: FacetDefinition[][] = [];
  let ready: string[] = facets.filter((f) => (f.dependsOn ?? []).length === 0).map((f) => f.id);
  while (ready.length > 0) {
    const layer = ready.map((id) => byId.get(id)!).filter((f): f is FacetDefinition => !!f);
    layers.push(layer);
    const nextReady: string[] = [];
    for (const id of ready) {
      for (const dependent of dependents.get(id) ?? []) {
        const r = (remaining.get(dependent) ?? 0) - 1;
        remaining.set(dependent, r);
        if (r === 0) nextReady.push(dependent);
      }
    }
    ready = nextReady;
  }
  return layers;
}

/**
 * Build a registry from ONLY the built-in facet catalog. Convenience
 * helper for callers that don't need disk-loaded extensions (tests,
 * the extension's initial activation path before user configs land).
 */
export function buildDefaultFacetRegistry(): FacetRegistry {
  return buildFacetRegistry(builtInFacets());
}

/**
 * Merge builtins with a list of disk-loaded overrides. A disk-loaded
 * facet with the same id as a builtin REPLACES the builtin (last-wins)
 * so users can override the shipped prompt or tool allowlist without
 * losing the registered id. Duplicate ids WITHIN `overrides` still
 * reject — overriding a builtin is intentional, but ambiguous author
 * intent across two user files is not.
 */
export function mergeWithBuiltInFacets(overrides: readonly FacetDefinition[]): FacetDefinition[] {
  const byId = new Map<string, FacetDefinition>();
  for (const f of builtInFacets()) byId.set(f.id, f);
  const seenOverride = new Set<string>();
  for (const f of overrides) {
    if (seenOverride.has(f.id)) {
      throw new FacetValidationError(
        `Duplicate facet id "${f.id}" in override set — two disk-loaded facets can't share an id`,
        'duplicate-id',
        { id: f.id },
      );
    }
    seenOverride.add(f.id);
    byId.set(f.id, f); // override the builtin
  }
  return Array.from(byId.values());
}
