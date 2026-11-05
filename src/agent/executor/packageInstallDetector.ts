import type { ToolUseContentBlock } from '../../ollama/types.js';
import { shellCommandOf } from './irrecoverableDetector.js';

/**
 * Detect a shell command that installs software: a new package in any common
 * ecosystem, system software, or a remote install script.
 *
 * Installing anything is the user's call in every approval mode, autonomous
 * included -- even when the user asked for it, an install is one Allow/Deny
 * click, because SideCar cannot reliably tell from the request whether this
 * exact package is the one meant. Left to itself the agent installed packages
 * to make its own checks run: on 2026-10-08, 30% of ministral-3 runs and 8% of
 * gemma4:31b runs installed packages or edited package.json / tsconfig.json
 * during an unrelated task.
 *
 * Restoring what the project already declares -- `npm install` / `npm ci`
 * with no package, `pip install -r requirements.txt`, `poetry install`,
 * `bundle install`, `go mod download` -- adds nothing new and is not matched.
 *
 * Detection is lexical: it reads the command, it does not run anything. A
 * command quoted inside another (`echo "npm install x"`) can match; that costs
 * one approval prompt, never a silent install.
 */

export type InstallKind = 'checker' | 'package' | 'system' | 'script';

export interface PackageInstall {
  kind: InstallKind;
  /** What is being installed, for the prompt: package names, or the script's source. */
  what: string;
}

/**
 * Type-checkers, linters, test runners and test libraries. An install of one
 * of these is reported as `checker`, so the prompt can say why the agent wants
 * it ("to check its changes").
 */
const CHECKERS =
  /^(typescript|tsc|ts-node|tsx|eslint|eslint-.+|@eslint\/.+|@typescript-eslint\/.+|tslint|prettier|biome|@biomejs\/biome|oxlint|vitest|@vitest\/.+|jest|ts-jest|babel-jest|@babel\/jest|@jest\/.+|expect|mocha|ts-mocha|chai|sinon|supertest|@testing-library\/.+|ava|tap|jasmine|@types\/(node|jest|mocha|chai|sinon|supertest)|mypy|pyright|ruff|pylint|flake8|pyflakes|pycodestyle|black|isort|pytest|pytest-.+|nose2?|tox|golangci-lint|staticcheck|revive|clippy|rubocop|rspec|phpunit|phpstan)$/i;

/** Long option flags that take a value, so the value is not mistaken for a package. */
const VALUE_FLAGS = new Set([
  '--registry',
  '--prefix',
  '--cache',
  '--tag',
  '--target',
  '--index-url',
  '--extra-index-url',
  '--find-links',
  '--trusted-host',
  '--python',
  '--version',
  '--source',
  '--channel',
  '--name',
  '--root',
  '--git',
  '--branch',
  '--rev',
  '--path',
  '--framework',
  '--workspace',
  '--filter',
  '--dir',
  '--group',
  '--extras',
  '--features',
]);

/**
 * Short flags that take a value, per tool: one letter means different things
 * to different tools. `-f` is npm's --force, which takes none, and pip's
 * --find-links, which does; one shared list skipped the package after
 * `npm i -f`, so that install asked nothing. A letter that takes a value for
 * one tool of a family and not another (`-w`: npm's workspace, pnpm's
 * workspace root) is left out: reading a value as a package costs a word in
 * the prompt, reading a package as a value costs the prompt.
 */
const SHORT_VALUE_FLAGS = {
  node: new Set(['-F', '-C']),
  pip: new Set(['-i', '-f', '-t']),
  pyAdd: new Set(['-G', '-E', '-p']),
  conda: new Set(['-n', '-p', '-c']),
  cargo: new Set(['-F', '-j']),
  gem: new Set(['-v', '-i', '-n']),
  dotnet: new Set(['-f', '-v', '-s']),
  system: new Set(['-t']),
  none: new Set<string>(),
};
type Tool = keyof typeof SHORT_VALUE_FLAGS;

/** Flags whose value is a file of the project's own declared dependencies. */
const RESTORE_FLAGS = new Set(['-r', '--requirement', '-c', '--constraint', '-e', '--editable']);

/** A local path or archive, not a package from a registry. */
const LOCAL = /^(\.{1,2}(\/|\\|$)|\/|[A-Za-z]:[\\/]|file:|~)/;

/** Strip a version or tag (`typescript@5`, `ruff==0.4`, `eslint@latest`, `x@^1`), keeping scoped names. */
function bareName(spec: string): string {
  const s = spec.replace(/^['"]|['"]$/g, '');
  const at = s.startsWith('@') ? s.indexOf('@', 1) : s.indexOf('@');
  const base = at > 0 ? s.slice(0, at) : s;
  return base.split(/[=<>~!\[;]/)[0];
}

/** The package arguments after an install verb, up to the next shell separator. */
function packageArgs(rest: string, tool: Tool): string[] {
  const segment = rest.split(/\s*(?:&&|\|\||;|\||>|<)\s*/)[0];
  const words = segment.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith('-')) {
      const [flag] = w.split('=');
      const takesValue = VALUE_FLAGS.has(flag) || RESTORE_FLAGS.has(flag) || SHORT_VALUE_FLAGS[tool].has(flag);
      if (takesValue && !w.includes('=')) i++; // skip its value
      continue;
    }
    if (LOCAL.test(w)) continue;
    const name = bareName(w);
    if (name) out.push(name);
  }
  return out;
}

/** Ecosystem package installs: a verb, then the package arguments. */
const PACKAGE_VERBS: [RegExp, Tool][] = [
  [/\bnpm\s+(?:i|install|add|in|ins|inst|insta|instal|isnt|isntall)\b([^\n]*)/g, 'node'],
  [/\bpnpm\s+(?:add|i|install)\b([^\n]*)/g, 'node'],
  [/\byarn\s+(?:global\s+)?add\b([^\n]*)/g, 'node'],
  [/\bbun\s+(?:add|install|i)\b([^\n]*)/g, 'node'],
  // pip, pip3 and pip3.11; `python -m pip` and `py -m pip` end in `pip install` too.
  [/\b(?:pip[0-9.]*|uv\s+pip|pipx)\s+install\b([^\n]*)/g, 'pip'],
  [/\b(?:uv|poetry|pdm|rye)\s+add\b([^\n]*)/g, 'pyAdd'],
  [/\b(?:conda|mamba|micromamba)\s+install\b([^\n]*)/g, 'conda'],
  [/\bcargo\s+(?:add|install)\b([^\n]*)/g, 'cargo'],
  [/\bgo\s+(?:get|install)\b([^\n]*)/g, 'none'],
  [/\bgem\s+install\b([^\n]*)/g, 'gem'],
  [/\bbundle\s+add\b([^\n]*)/g, 'gem'],
  [/\bcomposer\s+(?:require|global\s+require)\b([^\n]*)/g, 'none'],
  [/\bdotnet\s+(?:add\s+(?:\S+\s+)?package|tool\s+install)\b([^\n]*)/g, 'dotnet'],
];

/** Fetch-and-run: installs (into a cache) whatever it names, then runs it. */
const FETCH_AND_RUN: RegExp[] = [
  // `npx -p typescript tsc` installs the package it names: 40 distinct such
  // commands in a week of eval runs, all fetching typescript or ts-node.
  /\b(?:npx|npm\s+exec)\b[^\n|;&]*?\s(?:-p|--package)(?:=|\s+)([^\n]*)/g,
  /\b(?:npx|npm\s+exec)\s+(?:[^\n]*?\s)?(?:-y|--yes)\b([^\n]*)/g,
  /\b(?:pnpm|yarn)\s+dlx\b([^\n]*)/g,
  /\bbunx\b([^\n]*)/g,
  /\buvx\b([^\n]*)/g,
];

/** System package managers: software installed on the machine, not the project. */
const SYSTEM_VERBS: RegExp[] = [
  /\b(?:sudo\s+)?(?:apt|apt-get|yum|dnf|zypper|snap|port)\s+install\b([^\n]*)/g,
  /\bbrew\s+(?:install|reinstall)\b([^\n]*)/g,
  /\b(?:choco|winget|scoop)\s+install\b([^\n]*)/g,
  /\bpacman\s+-S\w*\b([^\n]*)/g,
  /\bapk\s+add\b([^\n]*)/g,
];

/** A script downloaded and executed in one go: `curl … | sh`, `iwr … | iex`. */
const REMOTE_SCRIPT =
  /\b(?:curl|wget)\b[^|\n]*?(https?:\/\/\S+)[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|\n]*?(https?:\/\/\S+)[^|\n]*\|\s*(?:iex|Invoke-Expression)\b/i;

function collect(cmd: string, patterns: (RegExp | [RegExp, Tool])[], firstOnly = false, tool: Tool = 'none'): string[] {
  const found: string[] = [];
  for (const entry of patterns) {
    const [re, flags] = Array.isArray(entry) ? entry : [entry, tool];
    for (const m of cmd.matchAll(re)) {
      const args = packageArgs(m[1] ?? '', flags);
      found.push(...(firstOnly ? args.slice(0, 1) : args));
    }
  }
  return found;
}

/**
 * The binary a bare `npx <bin>` runs, or null. npx runs a binary the project
 * has; when the project does not have it, npx downloads the registry package
 * of that NAME -- for `npx tsc` the unrelated package `tsc`, not TypeScript
 * (the eval logs' "could not determine executable to run").
 */
function bareNpxBinary(cmd: string): string | null {
  const m = /\bnpx\s+((?:-\S+\s+)*)([^\s-][^\s]*)/.exec(cmd);
  if (!m || /(^|\s)(-y|--yes|-p|--package|--no-install|--no)\b/.test(m[1])) return null;
  return bareName(m[2]);
}

/**
 * @param hasLocalBin  Whether the project has a binary in node_modules/.bin.
 *   When given, a bare `npx <bin>` whose binary is missing counts as an
 *   install of `<bin>`. Without it (no workspace to check), it does not.
 */
export function detectPackageInstall(
  toolUse: ToolUseContentBlock,
  hasLocalBin?: (name: string) => boolean,
): PackageInstall | null {
  const cmd = shellCommandOf(toolUse);
  if (cmd === null) return null;

  const script = REMOTE_SCRIPT.exec(cmd);
  if (script) return { kind: 'script', what: script[1] ?? script[2] };

  const system = [...new Set(collect(cmd, SYSTEM_VERBS, false, 'system'))];
  if (system.length > 0) return { kind: 'system', what: system.join(', ') };

  const packages = [...new Set([...collect(cmd, PACKAGE_VERBS), ...collect(cmd, FETCH_AND_RUN, true)])];
  const npxBin = hasLocalBin ? bareNpxBinary(cmd) : null;
  if (npxBin && !hasLocalBin!(npxBin) && !packages.includes(npxBin)) packages.push(npxBin);
  if (packages.length === 0) return null;
  const checker = packages.some((p) => CHECKERS.test(p.split('/').pop() ?? p) || CHECKERS.test(p));
  return { kind: checker ? 'checker' : 'package', what: packages.join(', ') };
}

/** The approval question for an install, by kind. */
export function installQuestion(install: PackageInstall): string {
  switch (install.kind) {
    case 'checker':
      return `SideCar wants to install **${install.what}** to check its changes. This adds it to your project.`;
    case 'package':
      return `SideCar wants to install **${install.what}**. This adds it to your project.`;
    case 'system':
      return `SideCar wants to install **${install.what}** on this machine with the system package manager.`;
    case 'script':
      return `SideCar wants to download and run an install script from **${install.what}**.`;
  }
}

/** What the agent is told when the install did not happen. */
export function installRefusal(install: PackageInstall, askedUser: boolean): string {
  const who = askedUser
    ? `The user declined installing ${install.what}.`
    : `${install.what} was not installed: this run has no one to ask, and installing software needs the user's approval.`;
  const next =
    install.kind === 'checker'
      ? 'Say in your answer which checker is missing and that it needs installing.'
      : 'If the task needs it, say so in your answer and leave the install to the user.';
  return `${who} Do not install it another way, and do not change project config to work around it. ${next}`;
}
