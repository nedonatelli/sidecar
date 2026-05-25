import * as fs from 'fs';
import * as path from 'path';
import type { RegressionGuardConfig } from './regressionGuardHook.js';

/**
 * Stable IDs for built-in guards. Used in skill frontmatter:
 *   guards: [lint-clean, tests-pass]
 */
export const BUILT_IN_GUARD_IDS = ['lint-clean', 'tests-pass', 'no-new-todos'] as const;
export type BuiltInGuardId = (typeof BUILT_IN_GUARD_IDS)[number];

export function isBuiltInGuardId(id: string): id is BuiltInGuardId {
  return (BUILT_IN_GUARD_IDS as readonly string[]).includes(id);
}

/** Human-readable descriptions for the /guards slash command. */
export const BUILT_IN_GUARD_DESCRIPTIONS: Record<BuiltInGuardId, string> = {
  'lint-clean': 'Run the project linter and require zero warnings before completion.',
  'tests-pass': 'Run the project test suite and require exit 0 before completion.',
  'no-new-todos': 'Fail if the working-tree diff introduces new TODO/FIXME/HACK/XXX comments.',
};

// ---------------------------------------------------------------------------
// Ecosystem detection
// ---------------------------------------------------------------------------

type Ecosystem = 'node' | 'python' | 'rust' | 'go' | null;

function detectEcosystem(workspaceRoot: string): Ecosystem {
  if (fs.existsSync(path.join(workspaceRoot, 'package.json'))) return 'node';
  if (
    fs.existsSync(path.join(workspaceRoot, 'pyproject.toml')) ||
    fs.existsSync(path.join(workspaceRoot, 'requirements.txt')) ||
    fs.existsSync(path.join(workspaceRoot, 'setup.py'))
  )
    return 'python';
  if (fs.existsSync(path.join(workspaceRoot, 'Cargo.toml'))) return 'rust';
  if (fs.existsSync(path.join(workspaceRoot, 'go.mod'))) return 'go';
  return null;
}

function testCommand(eco: Ecosystem): string | null {
  switch (eco) {
    case 'node':
      return 'npm test --if-present';
    case 'python':
      return 'python -m pytest --tb=short -q';
    case 'rust':
      return 'cargo test';
    case 'go':
      return 'go test ./...';
    default:
      return null;
  }
}

function lintCommand(eco: Ecosystem): string | null {
  switch (eco) {
    case 'node':
      return 'npx eslint --max-warnings=0 .';
    case 'python':
      return 'ruff check .';
    case 'rust':
      return 'cargo clippy -- -D warnings';
    case 'go':
      return 'go vet ./...';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Guard builders
// ---------------------------------------------------------------------------

/**
 * Build a `RegressionGuardConfig` for a built-in guard ID given the workspace
 * root. Returns `null` when the ecosystem can't be detected and no meaningful
 * command can be produced (so callers can skip rather than register a no-op).
 */
export function buildBuiltInGuard(id: BuiltInGuardId, workspaceRoot: string): RegressionGuardConfig | null {
  const eco = detectEcosystem(workspaceRoot);

  switch (id) {
    case 'tests-pass': {
      const cmd = testCommand(eco);
      if (!cmd) return null;
      return { name: 'tests-pass', command: cmd, trigger: 'pre-completion', blocking: true, timeoutMs: 120_000 };
    }
    case 'lint-clean': {
      const cmd = lintCommand(eco);
      if (!cmd) return null;
      return { name: 'lint-clean', command: cmd, trigger: 'post-write', blocking: true, timeoutMs: 30_000 };
    }
    case 'no-new-todos': {
      // Exit 0 = no new TODOs (clean); exit 1 = new TODOs found (fail).
      // `test -z` exits 0 when the variable is empty, 1 when non-empty.
      const cmd =
        'result=$(git diff -U0 2>/dev/null | grep "^+" | grep -E "TODO|FIXME|HACK|XXX" | head -5); test -z "$result"';
      return { name: 'no-new-todos', command: cmd, trigger: 'pre-completion', blocking: true, timeoutMs: 10_000 };
    }
  }
}

/**
 * Resolve a list of guard IDs (from skill frontmatter `guards:` field) into
 * `RegressionGuardConfig` objects. Unknown IDs are silently skipped — a typo
 * in frontmatter shouldn't break the skill.
 *
 * Only built-in IDs are resolved here. User-configured guards from
 * `sidecar.regressionGuards` are registered separately by `buildRegressionGuardHooks`.
 */
export function resolveGuardsByIds(ids: string[], workspaceRoot: string): RegressionGuardConfig[] {
  const results: RegressionGuardConfig[] = [];
  for (const id of ids) {
    if (!isBuiltInGuardId(id)) continue;
    const guard = buildBuiltInGuard(id, workspaceRoot);
    if (guard) results.push(guard);
  }
  return results;
}
