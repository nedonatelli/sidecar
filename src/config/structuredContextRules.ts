/**
 * Structured context rules for SideCar
 *
 * Reads .sidecarrules files that define constraints for context building.
 * Rules use glob-style patterns to match file paths and influence which
 * files are included in the workspace context sent to the model.
 */

import { workspace, Uri } from 'vscode';

export interface ContextRule {
  /** How to apply this rule */
  type: 'prefer' | 'ban' | 'require';
  /** Glob-style pattern matched against relative file paths */
  pattern: string;
  /** Score boost for 'prefer' rules (default 0.3) */
  boost?: number;
  /** Optional human-readable description */
  description?: string;
}

export interface StructuredContextRules {
  rules: ContextRule[];
}

const VALID_TYPES = new Set(['prefer', 'ban', 'require']);

/**
 * Simple glob matcher supporting *, **, and ? against relative paths.
 * Avoids a runtime dependency on minimatch/picomatch.
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  // Normalise separators
  const p = pattern.replace(/\\/g, '/');
  const f = filePath.replace(/\\/g, '/');

  // Convert glob to regex:
  //   **  → match any path segments (including /)
  //   *   → match within a single segment (no /)
  //   ?   → match a single non-/ character
  //   .   → literal dot
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

/**
 * Read and validate .sidecarrules from the workspace root.
 * Returns empty rules if the file is missing or malformed.
 *
 * Workspace-trust gate: .sidecarrules can elevate arbitrary workspace
 * files into the agent's context via `prefer` and `require` rules. In
 * an untrusted workspace, a cloned repo could use this to smuggle
 * attacker-planted content into the prompt. Match the same trust
 * boundary we apply to SIDECAR.md, workspace skills, doc RAG, and
 * agent memory in `injectSystemContext`.
 */
export async function readStructuredContextRules(): Promise<StructuredContextRules> {
  const folders = workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { rules: [] };
  }
  if (!workspace.isTrusted) {
    return { rules: [] };
  }

  const rulesUri = Uri.joinPath(folders[0].uri, '.sidecarrules');

  try {
    const bytes = await workspace.fs.readFile(rulesUri);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));

    if (!Array.isArray(parsed.rules)) {
      console.warn('[SideCar] Invalid .sidecarrules: "rules" must be an array');
      return { rules: [] };
    }

    const valid: ContextRule[] = [];
    for (const r of parsed.rules) {
      if (VALID_TYPES.has(r.type) && typeof r.pattern === 'string') {
        valid.push({
          type: r.type,
          pattern: r.pattern,
          boost: typeof r.boost === 'number' ? r.boost : undefined,
          description: r.description,
        });
      }
    }
    return { rules: valid };
  } catch {
    return { rules: [] };
  }
}

/**
 * Apply context rules to a scored file list.
 *
 * - **prefer**: adds `boost` (default 0.3) to matching files' scores
 * - **ban**: removes matching files entirely
 * - **require**: ensures matching files have at least a minimum score
 *   so they aren't dropped during top-k selection
 */
export function applyContextRules<T extends { relativePath: string; score: number }>(
  files: T[],
  rules: StructuredContextRules,
): T[] {
  if (!rules.rules || rules.rules.length === 0) {
    return files;
  }

  let result = files;

  for (const rule of rules.rules) {
    switch (rule.type) {
      case 'prefer':
        for (const f of result) {
          if (matchGlob(rule.pattern, f.relativePath)) {
            f.score += rule.boost ?? 0.3;
          }
        }
        break;

      case 'ban':
        result = result.filter((f) => !matchGlob(rule.pattern, f.relativePath));
        break;

      case 'require':
        for (const f of result) {
          if (matchGlob(rule.pattern, f.relativePath) && f.score <= 0) {
            f.score = rule.boost ?? 0.1;
          }
        }
        break;
    }
  }

  return result;
}

/**
 * Load context rules for the current workspace.
 */
export async function getCurrentContextRules(): Promise<StructuredContextRules> {
  return await readStructuredContextRules();
}
