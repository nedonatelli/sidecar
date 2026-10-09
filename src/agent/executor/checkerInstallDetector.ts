import type { ToolUseContentBlock } from '../../ollama/types.js';
import { shellCommandOf } from './irrecoverableDetector.js';

/**
 * Detect a shell command that installs a type-checker, linter or test runner.
 *
 * Installing one is the user's call, not the agent's, in every approval mode:
 * when a project has no checker for the agent to verify with, the agent says
 * so and asks whether to install it. Left to itself it installed one: on
 * 2026-10-08, 30% of ministral-3 runs and 8% of gemma4:31b runs installed
 * packages or edited package.json / tsconfig.json during an unrelated task,
 * to make a check run. Prompt wording asks the model not to; this makes the
 * install itself an approval prompt, autonomous mode included.
 *
 * Returns a description naming the packages ("typescript, eslint"), or null.
 * Deliberately narrow: an install of anything else is not this gate's
 * business, and `npm install` with no package (installing the project's own
 * declared dependencies) is not adding a checker.
 */

/** Node packages that type-check, lint or run tests. Matched on the bare name. */
const NODE_CHECKERS =
  /^(typescript|tsc|ts-node|tsx|eslint|eslint-.+|@eslint\/.+|@typescript-eslint\/.+|tslint|prettier|biome|@biomejs\/biome|oxlint|vitest|@vitest\/.+|jest|ts-jest|@jest\/.+|mocha|ava|tap|jasmine|@types\/(node|jest|mocha))$/;

/** Python packages that type-check, lint or run tests. */
const PY_CHECKERS = /^(mypy|pyright|ruff|pylint|flake8|pyflakes|pycodestyle|black|isort|pytest|pytest-.+|nose2?|tox)$/i;

/** Strip a version or tag (`typescript@5`, `ruff==0.4`, `eslint@latest`), keeping scoped names. */
function bareName(spec: string): string {
  const s = spec.replace(/^['"]|['"]$/g, '');
  const at = s.startsWith('@') ? s.indexOf('@', 1) : s.indexOf('@');
  const base = at > 0 ? s.slice(0, at) : s;
  return base.split(/[=<>~!]/)[0];
}

/** Positional (non-flag) words after the install verb, up to the next shell separator. */
function packageArgs(rest: string): string[] {
  const segment = rest.split(/\s*(?:&&|\|\||;|\|)\s*/)[0];
  return segment
    .split(/\s+/)
    .filter((w) => w && !w.startsWith('-'))
    .map(bareName);
}

export function detectCheckerInstall(toolUse: ToolUseContentBlock): string | null {
  const cmd = shellCommandOf(toolUse);
  if (cmd === null) return null;
  const found = new Set<string>();

  // npm/pnpm/yarn/bun add or install <pkgs>
  for (const m of cmd.matchAll(
    /\b(?:npm\s+(?:i|install|add)|pnpm\s+(?:i|install|add)|yarn\s+(?:global\s+)?add|bun\s+(?:add|install|i))\b([^\n]*)/g,
  )) {
    for (const p of packageArgs(m[1])) if (NODE_CHECKERS.test(p)) found.add(p);
  }
  // npx -y / --yes / npm exec --yes <pkg>: fetches and runs a package the project does not have.
  for (const m of cmd.matchAll(/\b(?:npx|npm\s+exec)\s+(?:[^\n]*?\s)?(?:-y|--yes)\b([^\n]*)/g)) {
    const first = packageArgs(m[1])[0];
    if (first && NODE_CHECKERS.test(first)) found.add(first);
  }
  // pip / pip3 / python -m pip / uv pip / pipx install <pkgs>
  for (const m of cmd.matchAll(/\b(?:pip3?|python[0-9.]*\s+-m\s+pip|uv\s+pip|pipx)\s+install\b([^\n]*)/g)) {
    for (const p of packageArgs(m[1])) if (PY_CHECKERS.test(p)) found.add(p);
  }
  // go install <module>@<version> of a linter
  for (const m of cmd.matchAll(/\bgo\s+install\s+(\S+)/g)) {
    if (/golangci-lint|staticcheck|revive/.test(m[1])) found.add(m[1].split('@')[0].split('/').pop()!);
  }

  return found.size > 0 ? [...found].join(', ') : null;
}
