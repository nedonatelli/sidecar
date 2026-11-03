import * as path from 'path';
import { resolveToolNameAlias } from '../executor/toolNameAlias.js';

/**
 * What a file tool did to the workspace (ADR-008). The text result is for the
 * model; this is for the loop. Every consumer that asks "did this call change a
 * file?" reads it through {@link changedFiles} instead of matching the wording,
 * which changes for model reasons and used to break them one at a time (#361,
 * #362).
 *
 * - `mutated`: the call changed `paths` (on disk, or `staged` for review).
 * - `noop`: it ran and changed nothing ("No change needed", an identical
 *   rewrite, a search that matched nothing).
 * - `failed`: it was refused or threw.
 */
export interface ToolOutcome {
  kind: 'mutated' | 'noop' | 'failed';
  /** Workspace-relative, forward-slashed. */
  paths: string[];
  /** The write was held in the audit buffer or the review store, not written to disk. */
  staged?: 'audit' | 'review';
}

/** The registered tools that change files, and so report an outcome. */
export const FILE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'delete_file']);

/**
 * The file tool a call ran as, or null. An aliased call keeps the model's name
 * in history (`str_replace`, `create_file`) but runs the canonical tool, so a
 * check on `tu.name === 'edit_file'` alone misses it.
 */
export function fileToolName(name: string): string | null {
  const canonical = resolveToolNameAlias(name) ?? name;
  return FILE_TOOLS.has(canonical) ? canonical : null;
}

export function outcomePath(p: string): string {
  return path.posix.normalize(p.replace(/\\/g, '/'));
}

export function mutated(p: string, staged?: 'audit' | 'review'): ToolOutcome {
  return staged ? { kind: 'mutated', paths: [outcomePath(p)], staged } : { kind: 'mutated', paths: [outcomePath(p)] };
}

export function noop(p: string): ToolOutcome {
  return { kind: 'noop', paths: [outcomePath(p)] };
}

export function failed(p?: string): ToolOutcome {
  return { kind: 'failed', paths: p ? [outcomePath(p)] : [] };
}

/**
 * The files a call changed: `paths` for `mutated`, nothing otherwise. A staged
 * write counts — the model's next step should treat it as done, as it treats a
 * disk write. A missing outcome (not a file tool, an MCP tool, a result from a
 * resumed session) is no change.
 */
export function changedFiles(outcome: ToolOutcome | undefined): string[] {
  return outcome?.kind === 'mutated' ? outcome.paths : [];
}
