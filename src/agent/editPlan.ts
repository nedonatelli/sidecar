// ---------------------------------------------------------------------------
// EditPlan — typed manifest for multi-file edit streams (v0.65 chunk 4.1).
//
// Purpose: before the agent fires a batch of write_file / edit_file /
// delete_file calls that span N files, we make it declare the full set
// up front as an EditPlan. The runtime builds a DAG from `dependsOn`
// edges, detects conflicts + cycles, and schedules independent nodes
// in parallel up to a cap.
//
// Chunk 4.1 is the pure DAG module — no LLM, no executor, no UI:
//   - `EditPlan`, `PlannedEdit`, `EditOp` — the manifest shape.
//   - `validateEditPlan(plan)` — structural checks (non-empty, valid
//     op values, non-empty paths, no duplicate edit targets, no cycles,
//     every `dependsOn` reference resolves to another edit in the plan).
//   - `layerPlan(plan)` — topological layering: each layer is a set
//     of edits whose dependencies have all landed in earlier layers.
//     The scheduler (chunk 4.3) walks layers in order, parallelizing
//     within each layer.
//
// The validation is intentionally strict. A broken plan is easier to
// feed back to the model ("your plan had a cycle a.ts → b.ts → a.ts —
// revise") than to partially execute.
// ---------------------------------------------------------------------------

export type EditOp = 'create' | 'edit' | 'delete';

export interface PlannedEdit {
  /** Workspace-relative path. Acts as the DAG node id. */
  readonly path: string;
  readonly op: EditOp;
  /** One-sentence why. Surfaced in the "Planned edits" card. */
  readonly rationale: string;
  /**
   * Paths this edit depends on. Each listed path MUST also appear as a
   * `path` on another edit in the same plan — `dependsOn` references a
   * plan-internal predecessor, not arbitrary workspace files.
   */
  readonly dependsOn: readonly string[];
}

export interface EditPlan {
  readonly edits: readonly PlannedEdit[];
}

/** Structured failure — validation layer rejects at the root rather than partially executing. */
export class EditPlanValidationError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'empty-plan'
      | 'invalid-op'
      | 'invalid-path'
      | 'invalid-dependsOn'
      | 'invalid-shape'
      | 'incompatible-duplicate'
      | 'unknown-dependsOn'
      | 'self-dependency'
      | 'cycle',
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'EditPlanValidationError';
  }
}

/**
 * Fold same-path entries into one. The spec says duplicate `edit`
 * targets are merged into a single op with combined rationale rather
 * than forcing the planner to retry. We generalize that:
 *
 *   edit + edit       → one `edit`, rationales joined, dependsOn unioned
 *   create + edit     → one `create` (the file ends up created then
 *                       modified; a single write achieves both)
 *   create + create   → reject (the plan declared the same new file
 *                       twice — that's a semantic bug worth retrying)
 *   delete + anything → reject (delete-and-modify on the same path in
 *                       one plan is semantically broken; ambiguous
 *                       execution order)
 *   delete + delete   → reject (meaningless)
 *
 * Returns a new plan with merges applied. Does NOT run cycle or
 * unknown-dep checks — `validateEditPlan` does those on the merged
 * output. `dependsOn` order after union is stable: first-occurrence
 * order from the original entry list.
 */
export function normalizeEditPlan(plan: EditPlan): EditPlan {
  const merged = new Map<string, PlannedEdit>();
  for (const entry of plan.edits) {
    const existing = merged.get(entry.path);
    if (!existing) {
      merged.set(entry.path, { ...entry, dependsOn: entry.dependsOn.slice() });
      continue;
    }
    const pair = [existing.op, entry.op].sort().join('+');
    switch (pair) {
      case 'edit+edit': {
        merged.set(entry.path, mergeEdits(existing, entry, 'edit'));
        break;
      }
      case 'create+edit': {
        // sorted('create','edit') = 'create+edit'. The create wins.
        merged.set(entry.path, mergeEdits(existing, entry, 'create'));
        break;
      }
      default: {
        // create+create, create+delete, delete+delete, delete+edit.
        throw new EditPlanValidationError(
          `Incompatible duplicate at ${entry.path}: ${existing.op} and ${entry.op} cannot be merged in one plan`,
          'incompatible-duplicate',
          { path: entry.path, ops: [existing.op, entry.op] },
        );
      }
    }
  }
  return { edits: Array.from(merged.values()) };
}

function mergeEdits(a: PlannedEdit, b: PlannedEdit, op: EditOp): PlannedEdit {
  const seen = new Set<string>();
  const dependsOn: string[] = [];
  for (const d of a.dependsOn) if (!seen.has(d)) (seen.add(d), dependsOn.push(d));
  for (const d of b.dependsOn) if (!seen.has(d)) (seen.add(d), dependsOn.push(d));
  const rationale = [a.rationale, b.rationale].filter((r) => r.length > 0).join('; ');
  return { path: a.path, op, rationale, dependsOn };
}

/**
 * Validate an `EditPlan`. Throws `EditPlanValidationError` on the first
 * problem encountered. Reasons are typed so the planner-feedback loop
 * (chunk 4.2) can turn each into a specific "revise your plan"
 * instruction rather than a generic error.
 *
 * Expects the plan to have been run through `normalizeEditPlan` first
 * (same-path merges resolved); this function asserts uniqueness and
 * checks the other structural invariants:
 *   1. Plan has at least one edit.
 *   2. Every edit has a valid `op` and a non-empty `path`.
 *   3. `dependsOn` is an array.
 *   4. No two edits target the same `path` (should be impossible
 *      post-normalize; if it fires, normalize was skipped).
 *   5. Every `dependsOn` entry references another edit in the plan.
 *   6. No self-dependency (`path == dependsOn[i]`).
 *   7. No cycles (DFS 3-color walk).
 */
export function validateEditPlan(plan: EditPlan): void {
  if (!plan.edits || plan.edits.length === 0) {
    throw new EditPlanValidationError('EditPlan must contain at least one edit', 'empty-plan');
  }

  const byPath = new Map<string, PlannedEdit>();
  for (const edit of plan.edits) {
    if (edit.op !== 'create' && edit.op !== 'edit' && edit.op !== 'delete') {
      throw new EditPlanValidationError(`Invalid op "${edit.op}" on ${edit.path}`, 'invalid-op', { edit });
    }
    if (typeof edit.path !== 'string' || edit.path.trim().length === 0) {
      throw new EditPlanValidationError('PlannedEdit.path must be a non-empty string', 'invalid-path', { edit });
    }
    if (!Array.isArray(edit.dependsOn)) {
      throw new EditPlanValidationError(`dependsOn must be an array on ${edit.path}`, 'invalid-dependsOn', { edit });
    }
    if (byPath.has(edit.path)) {
      // Reachable only when the caller skipped normalizeEditPlan.
      throw new EditPlanValidationError(
        `Duplicate edit target ${edit.path} reached validateEditPlan — run normalizeEditPlan first`,
        'incompatible-duplicate',
        { path: edit.path },
      );
    }
    byPath.set(edit.path, edit);
  }

  for (const edit of plan.edits) {
    for (const dep of edit.dependsOn) {
      if (dep === edit.path) {
        throw new EditPlanValidationError(`Self-dependency: ${edit.path} depends on itself`, 'self-dependency', {
          path: edit.path,
        });
      }
      if (!byPath.has(dep)) {
        throw new EditPlanValidationError(
          `dependsOn references ${dep} but no edit in the plan targets that path`,
          'unknown-dependsOn',
          { edit, missingDep: dep },
        );
      }
    }
  }

  // Cycle detection: DFS with WHITE/GRAY/BLACK coloring. GRAY revisit
  // => back edge => cycle. We track the current stack path so the
  // error message names the actual cycle, not just "cycle detected
  // somewhere."
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const e of plan.edits) color.set(e.path, WHITE);

  const stack: string[] = [];
  function visit(path: string): void {
    color.set(path, GRAY);
    stack.push(path);
    const edit = byPath.get(path);
    if (edit) {
      for (const dep of edit.dependsOn) {
        const c = color.get(dep);
        if (c === GRAY) {
          const cycleStart = stack.indexOf(dep);
          const cyclePath = stack.slice(cycleStart).concat(dep).join(' → ');
          throw new EditPlanValidationError(`Dependency cycle: ${cyclePath}`, 'cycle', { cycle: cyclePath });
        }
        if (c === WHITE) visit(dep);
      }
    }
    stack.pop();
    color.set(path, BLACK);
  }
  for (const edit of plan.edits) {
    if (color.get(edit.path) === WHITE) visit(edit.path);
  }
}

/**
 * Topologically layer a valid plan. Layer `k` is the set of edits
 * whose every dependency lives in layers `0..k-1`. The scheduler
 * dispatches all edits in a layer in parallel, waits for the layer
 * to finish, then proceeds to the next.
 *
 * Tradeoff vs. a ready-queue DAG scheduler (fire each node the
 * instant its deps resolve): layering is slightly pessimistic — with
 * `a`, `b dependsOn a`, `c` independent and slow, a ready-queue
 * scheduler starts `b` as soon as `a` finishes, while layering waits
 * for both `a` and `c`. Accepted for two reasons: (1) file-write ops
 * typically finish in tens of milliseconds, so the wait is negligible
 * in practice; (2) the layered contract is easier to reason about,
 * render in the UI (one horizontal "batch" per layer), and abort
 * cleanly.
 *
 * Precondition: plan must pass `validateEditPlan` (and therefore have
 * been normalized). layerPlan does not re-check.
 */
export function layerPlan(plan: EditPlan): PlannedEdit[][] {
  const byPath = new Map<string, PlannedEdit>();
  for (const edit of plan.edits) byPath.set(edit.path, edit);

  // Remaining dependencies per node. Decrements as layers resolve.
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep → list of paths that depend on dep
  for (const edit of plan.edits) {
    remaining.set(edit.path, edit.dependsOn.length);
    for (const dep of edit.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(edit.path);
      dependents.set(dep, list);
    }
  }

  const layers: PlannedEdit[][] = [];
  let ready: string[] = plan.edits.filter((e) => e.dependsOn.length === 0).map((e) => e.path);

  while (ready.length > 0) {
    const layer = ready.map((p) => byPath.get(p)!).filter((e): e is PlannedEdit => !!e);
    layers.push(layer);

    const nextReady: string[] = [];
    for (const p of ready) {
      for (const dependent of dependents.get(p) ?? []) {
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
 * Convenience: normalize → validate → layer in one call. Throws
 * `EditPlanValidationError` on invalid input.
 */
export function planToLayers(plan: EditPlan): PlannedEdit[][] {
  const normalized = normalizeEditPlan(plan);
  validateEditPlan(normalized);
  return layerPlan(normalized);
}

/**
 * Parse a JSON string into an `EditPlan`, validating shape defensively
 * (the source is model output, which is untrusted). Returns a
 * normalized + validated plan, or throws `EditPlanValidationError` on
 * parse failure or shape mismatch.
 *
 * Contract: the input must be `{ "edits": [ ... ] }`. A bare top-level
 * array is rejected — the planner prompt in chunk 4.2 will demand the
 * object shape, and accepting the array form in the parser just hides
 * prompt drift. If a future model reliably deviates, loosen it here
 * behind a flag rather than silently accepting both.
 */
export function parseEditPlanJson(json: string): EditPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new EditPlanValidationError(
      `EditPlan JSON failed to parse: ${err instanceof Error ? err.message : String(err)}`,
      'invalid-shape',
      { raw: json.slice(0, 200) },
    );
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray((raw as { edits?: unknown }).edits)) {
    throw new EditPlanValidationError(
      'EditPlan JSON must be an object with an "edits" array: { "edits": [ ... ] }',
      'invalid-shape',
    );
  }
  const editsRaw = (raw as { edits: unknown[] }).edits;

  const edits: PlannedEdit[] = [];
  for (const entryUnknown of editsRaw) {
    if (!entryUnknown || typeof entryUnknown !== 'object') {
      throw new EditPlanValidationError('Each EditPlan entry must be an object', 'invalid-shape');
    }
    const entry = entryUnknown as Record<string, unknown>;
    const path = entry.path;
    const op = entry.op;
    const rationale = entry.rationale;
    const dependsOnRaw = entry.dependsOn ?? [];
    if (typeof path !== 'string') {
      throw new EditPlanValidationError('entry.path must be a string', 'invalid-path', { entry });
    }
    if (typeof op !== 'string') {
      throw new EditPlanValidationError(`entry.op must be a string on ${path}`, 'invalid-op', { entry });
    }
    if (!Array.isArray(dependsOnRaw) || dependsOnRaw.some((d) => typeof d !== 'string')) {
      throw new EditPlanValidationError(`entry.dependsOn must be string[] on ${path}`, 'invalid-dependsOn', { entry });
    }
    edits.push({
      path,
      op: op as EditOp,
      rationale: typeof rationale === 'string' ? rationale : '',
      dependsOn: dependsOnRaw as string[],
    });
  }

  const normalized = normalizeEditPlan({ edits });
  validateEditPlan(normalized);
  return normalized;
}
