import type { ToolUseContentBlock } from '../../ollama/types.js';
import { shellCommandOf } from './irrecoverableDetector.js';

/**
 * Detect a tool call that changes the project's own configuration -- its
 * package manifest, compiler, linter or test-runner config -- and decide
 * whether the user's request asked for that change (#169).
 *
 * Left to itself the agent rewrote config to make its own checks run during
 * unrelated tasks: on the 2026-10-10 gemma4:31b eval, 13 edits across 4 cases
 * (`module`/`target` changed so `tsc` would accept a file during a JSDoc task),
 * and `npm init -y && npm install --save-dev jest` replaced a fixture's
 * package.json wholesale on ministral-3. Unlike an install (#166), editing
 * config is often the task itself ("add a test script", "enable strict mode"),
 * so the change needs the user's approval only when the request names neither
 * the file nor that kind of change. A false "ask" costs one click; a false
 * "proceed" is the silent edit this exists to stop, so the matching leans to
 * asking.
 *
 * Detection is lexical, like detectPackageInstall: it reads the call, it does
 * not run anything.
 */

export type ConfigFamily = 'package' | 'typescript' | 'lint' | 'test' | 'python';

export interface ConfigEdit {
  family: ConfigFamily;
  /** The config file's path as the call names it. */
  file: string;
  /** How it changes: a file tool, or the shell command that rewrites it. */
  via: 'edit_file' | 'write_file' | 'delete_file' | 'command';
  /** For `command`: the part of the command that changes the file (`npm init`). */
  command?: string;
}

/** Config files by family, matched on the basename. */
const CONFIG_FILES: Array<[ConfigFamily, RegExp]> = [
  ['package', /^package\.json$/i],
  ['typescript', /^(?:tsconfig(?:\.[\w-]+)*\.json|jsconfig\.json)$/i],
  [
    'lint',
    /^(?:\.eslintrc(?:\.\w+)?|eslint\.config\.\w+|\.prettierrc(?:\.\w+)?|prettier\.config\.\w+|biome\.jsonc?|\.flake8|\.?pylintrc|\.?ruff\.toml|\.?mypy\.ini)$/i,
  ],
  [
    'test',
    /^(?:vitest\.config\.\w+|vitest\.workspace\.\w+|jest\.config\.\w+|\.mocharc(?:\.\w+)?|pytest\.ini|tox\.ini|\.coveragerc)$/i,
  ],
  ['python', /^(?:pyproject\.toml|setup\.cfg|requirements[\w.-]*\.txt)$/i],
];

export function configFamilyOf(filePath: string): ConfigFamily | null {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  for (const [family, re] of CONFIG_FILES) if (re.test(base)) return family;
  return null;
}

/** Commands that create or rewrite a config file without naming it. */
const CONFIG_COMMANDS: Array<[RegExp, ConfigFamily, string]> = [
  // `npm init -y` overwrites package.json wholesale; `npm pkg set` edits it.
  [/\b(?:npm|pnpm|yarn|bun)\s+init\b/, 'package', 'package.json'],
  [/\bnpm\s+(?:pkg\s+(?:set|delete)|set-script)\b/, 'package', 'package.json'],
  [/\btsc\s+(?:[^\n|;&]*\s)?--init\b/, 'typescript', 'tsconfig.json'],
  [/\beslint\s+(?:[^\n|;&]*\s)?--init\b/, 'lint', 'eslint config'],
  [/\bjest\s+(?:[^\n|;&]*\s)?--init\b/, 'test', 'jest config'],
  [/\b(?:poetry|uv)\s+init\b/, 'python', 'pyproject.toml'],
];

/** A shell write into a file: `> f`, `>> f`, `tee [-a] f`. */
const SHELL_WRITE_TARGET = /(?:(?<![<>&\d])>>?|\btee\s+(?:-a\s+)?)\s*(['"]?)([^\s'";|&<>]+)\1/g;

function detectInCommand(cmd: string): ConfigEdit | null {
  for (const [re, family, file] of CONFIG_COMMANDS) {
    const m = re.exec(cmd);
    if (m) return { family, file, via: 'command', command: m[0].replace(/\s+/g, ' ') };
  }
  for (const m of cmd.matchAll(SHELL_WRITE_TARGET)) {
    const family = configFamilyOf(m[2]);
    if (family) return { family, file: m[2], via: 'command', command: m[0].trim() };
  }
  // In-place edits: `sed -i … tsconfig.json`, `perl -pi -e … package.json`.
  for (const segment of cmd.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
    if (!/^\s*(?:sudo\s+)?(?:sed|perl)\s(?:.*\s)?-[a-zA-Z]*i/.test(segment)) continue;
    const target = segment
      .split(/\s+/)
      .map((w) => w.replace(/^['"]|['"]$/g, ''))
      .find((w) => configFamilyOf(w) !== null);
    if (target) return { family: configFamilyOf(target)!, file: target, via: 'command', command: segment.trim() };
  }
  return null;
}

export function detectConfigEdit(toolUse: ToolUseContentBlock): ConfigEdit | null {
  const cmd = shellCommandOf(toolUse);
  if (cmd !== null) return detectInCommand(cmd);
  if (toolUse.name !== 'edit_file' && toolUse.name !== 'write_file' && toolUse.name !== 'delete_file') return null;
  const file = (toolUse.input as Record<string, unknown>).path;
  if (typeof file !== 'string' || !file) return null;
  const family = configFamilyOf(file);
  return family ? { family, file, via: toolUse.name } : null;
}

// --- Does the request ask for it? ---

/** A dependency, but not a code one: "circular dependency", "dependency injection". */
const DEPENDENCIES =
  /\b(?<!(?:circular|cyclic|import|code|module|function|class)\s)(?:(?:dev|peer|optional)[\s-]?)?dependenc(?:y|ies)\b(?!\s+(?:injection|graph|cycle|inversion))|\bdevDependencies\b|\bdev[\s-]?deps?\b/i;

const LINT_KINDS: RegExp[] = [
  /\b(?:eslintrc|prettierrc|pylintrc)\b/i,
  /\b(?:eslint|lint(?:er|ing)?|prettier|biome|ruff|flake8|pylint|mypy|formatter|formatting)[\s.-]?(?:config(?:uration)?|rules?|settings|setup|options|ignores?)\b/i,
  // "disable the no-console rule", "turn off `max-len` rule"
  /\b(?:enable|disable|turn\s+(?:on|off)|add|remove|configure|relax|tighten)\s+(?:the\s+|a\s+)?[`'"]?[\w@/-]+[`'"]?\s+(?:lint\s+)?rule\b/i,
];

const TEST_KINDS: RegExp[] = [
  /\b(?:vitest|jest|mocha|pytest|tox|coverage|test[\s-]?runner)[\s.-]?(?:config(?:uration)?|settings|setup|options|workspace)\b/i,
  /\btest\s+(?:config(?:uration)?|environment)\b/i,
  /\bcoverage\s+(?:thresholds?|reporters?)\b/i,
  /\bmocharc\b|\bcoveragerc\b|\bpytest\.ini\b|\btox\.ini\b/i,
];

/**
 * The kinds of change, by family. A file's own basename always counts too.
 * Generic words are left out on purpose: "fix the lint errors" is not a
 * request to change lint config, "compare version numbers" is not a version
 * bump, and `tsc --noEmit` in a request is a check to run, not an option to set.
 */
const KINDS: Record<ConfigFamily, RegExp[]> = {
  package: [
    /\bpackage\.json\b/i,
    /\b(?:npm|yarn|pnpm|package)\s+scripts?\b|\b(?:test|build|lint|start|dev|format|typecheck|prepare|watch|clean)\s+scripts?\b|\bscripts\s+(?:entry|field|section|block)\b/i,
    DEPENDENCIES,
    /\b(?:bump|increment|update|set|change)\s+(?:the\s+)?(?:package\s+)?version\b|\bversion\s+(?:bump|field)\b|\bpackage\s+version\b/i,
    /\bnpm\s+(?:init|pkg)\b/i,
    /\b(?:main|exports|bin|engines|files|workspaces|type)\s+field\b|\bpackage\s+(?:manifest|metadata)\b/i,
  ],
  typescript: [
    /\b(?:ts|js)config\b/i,
    /\bstrict\s+mode\b/i,
    /\bcompiler\s+options?\b|\bcompilerOptions\b/i,
    /\b(?:typescript|tsc|ts)\s+(?:config(?:uration)?|settings|options)\b/i,
    /\bpath\s+aliases?\b/i,
    // Option names are camelCase, so match them case-sensitively: "strict" or
    // "target" alone are ordinary words.
    /\b(?:strict[A-Z]\w*|noImplicit\w+|noUnused\w+|exactOptional\w+|moduleResolution|esModuleInterop|allowJs|checkJs|skipLibCheck|baseUrl|isolatedModules|resolveJsonModule|allowSyntheticDefaultImports|experimentalDecorators|emitDecoratorMetadata|outDir|rootDir|sourceMap|verbatimModuleSyntax)\b/,
  ],
  lint: LINT_KINDS,
  test: TEST_KINDS,
  python: [
    /\bpyproject(?:\.toml)?\b|\bsetup\.cfg\b|\brequirements(?:[\w.-]*)\.txt\b/i,
    DEPENDENCIES,
    /\b(?:project|package)\s+metadata\b|\bentry[\s_-]?points?\b|\bconsole[\s_]scripts\b|\bbuild[\s-]system\b/i,
    // pyproject.toml and setup.cfg also hold the linters' and test runners' sections.
    ...LINT_KINDS,
    ...TEST_KINDS,
  ],
};

/**
 * Clauses: split after . ! ? ; followed by whitespace, at newlines, and at
 * ", but" -- a path's `.json` does not split. A negation reaches only the end
 * of its own clause: "Don't use any; enable strict mode" asks for strict mode.
 */
function clauses(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+|\n+|,\s*but\b/i).filter((s) => s.trim() !== '');
}

/** A negation earlier in the clause: "do not touch tsconfig.json", "without changing package.json". */
const NEGATION_BEFORE = /\b(?:not|never|without|avoid|no need to)\b|n't\b/i;
/** ...or after it: "leave package.json alone", "keep tsconfig.json unchanged". */
const NEGATION_AFTER = /^\S*\s*(?:\S+\s+){0,2}?(?:alone|untouched|unchanged|as[\s-]is)\b/i;

function mentions(clause: string, re: RegExp): boolean {
  const m = new RegExp(re.source, re.flags.replace('g', '')).exec(clause);
  if (!m) return false;
  const before = clause.slice(0, m.index);
  const after = clause.slice(m.index + m[0].length);
  return !NEGATION_BEFORE.test(before) && !NEGATION_AFTER.test(after);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when the request names the config file, or asks for the kind of change
 * this file holds. A mention under a negation ("do not touch tsconfig.json")
 * does not count. An empty request -- a caller that has none to give -- never
 * names anything, so the change asks.
 */
export function requestNamesConfigChange(edit: ConfigEdit, requestText: string | undefined): boolean {
  if (!requestText) return false;
  const base = edit.file.replace(/\\/g, '/').split('/').pop() ?? edit.file;
  const own = new RegExp(`(?<![\\w.-])${escapeRegExp(base)}(?![\\w-])`, 'i');
  const kinds = [own, ...KINDS[edit.family]];
  return clauses(requestText).some((clause) => kinds.some((re) => mentions(clause, re)));
}

/** The approval question for a config change the request did not ask for. */
export function configEditQuestion(edit: ConfigEdit): string {
  const what =
    edit.via === 'command'
      ? `run a command that changes **${edit.file}** (\`${edit.command}\`)`
      : `${edit.via === 'delete_file' ? 'delete' : edit.via === 'write_file' ? 'write' : 'edit'} **${edit.file}**`;
  return `SideCar wants to ${what}. That is project config, and your request did not ask to change it.`;
}

/** What the agent is told when the config change did not happen. */
export function configEditRefusal(edit: ConfigEdit, askedUser: boolean): string {
  const who = askedUser
    ? `The user declined this change to ${edit.file}: the request did not ask to change project config.`
    : `${edit.file} was not changed: this run has no one to ask, and changing project config the request did not ask for needs the user's approval.`;
  return (
    `${who} Do not change it another way -- not with a shell command, and not by writing a different config file. ` +
    'Finish the task without changing project config. If a check cannot run without the change, ' +
    'say in your answer what change it needs and why, and leave it to the user.'
  );
}
