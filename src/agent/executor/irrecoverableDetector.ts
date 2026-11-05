import type { ToolUseContentBlock } from '../../ollama/types.js';
import { isExecutionConfigPath } from '../tools/shared.js';

/**
 * Detect tool calls that are destructive and hard or impossible to
 * undo. These force an escalated confirmation gate — the user must
 * explicitly type a confirmation phrase, rather than one-click Allow,
 * and the gate runs even in autonomous mode so a runaway agent can't
 * slip a `git push --force` past without the user seeing it.
 *
 * Returns a human-readable description of the destructive action if
 * detected, or null for normal tool calls. Matches are intentionally
 * conservative — we'd rather miss a destructive pattern than prompt
 * on innocuous calls.
 */
/**
 * The shell command a tool call would run, for the tools that take one:
 * run_command, run_tests with an explicit `command`, and
 * research_log_experiment. Null for every other call.
 */
export function shellCommandOf(toolUse: ToolUseContentBlock): string | null {
  const input = toolUse.input as Record<string, unknown>;
  const cmd = typeof input.command === 'string' ? input.command : '';
  if (!cmd) return null;
  return ['run_command', 'run_tests', 'research_log_experiment'].includes(toolUse.name) ? cmd : null;
}

/** Commands that run the command after them: `sudo rm -rf x` is an rm. */
const WRAPPERS = new Set(['sudo', 'doas', 'xargs', 'nohup', 'time', 'command', 'exec', 'env', 'nice']);

/**
 * Each simple command in `cmd`, as its words, with the command name first,
 * lowercased, without a directory or `.exe`. What a quote, backtick or `$( )`
 * holds is read as a command too, so `bash -c "rm -rf x"` is still an rm -- at
 * the cost of also reading an echoed "rm -rf" as one.
 */
function commandSegments(cmd: string, depth = 0): string[][] {
  const out: string[][] = [];
  const outer = cmd.replace(/"([^"]*)"|'([^']*)'|`([^`]*)`|\$\(([^)]*)\)/g, (_m, ...inner: (string | undefined)[]) => {
    const held = inner.slice(0, 4).find((s) => s !== undefined) ?? '';
    if (depth < 3) out.push(...commandSegments(held, depth + 1));
    return ' _ ';
  });
  for (const segment of outer.split(/&&|\|\||[;|&\n()]/)) {
    let words = segment.trim().split(/\s+/).filter(Boolean);
    while (words.length && (/^\w+=/.test(words[0]) || WRAPPERS.has(baseName(words[0])))) {
      words = words.slice(1);
      while (words.length && words[0].startsWith('-')) words = words.slice(1); // the wrapper's own options
    }
    if (words.length) out.push([baseName(words[0]), ...words.slice(1)]);
  }
  return out;
}

const baseName = (word: string): string => (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.exe$/, '');

/** Every short flag letter in `words`, however grouped: `-rfv` and `-r -f` both give the r and the f. */
function shortFlags(words: string[]): string {
  return words
    .filter((w) => /^-[a-zA-Z]+$/.test(w))
    .map((w) => w.slice(1))
    .join('');
}

function destructiveSegment([name, ...args]: string[]): string | null {
  const lower = args.map((a) => a.toLowerCase());
  const has = (...flags: string[]) => flags.some((f) => lower.includes(f));
  if (name === 'rm') {
    const short = shortFlags(args);
    const recursive = /r/i.test(short) || has('--recursive');
    const force = short.includes('f') || has('--force');
    if (recursive && force) return 'Recursive force-delete (rm -rf)';
  }
  // PowerShell's Remove-Item and its aliases, and cmd.exe's /s.
  if (['remove-item', 'ri', 'rm', 'rmdir', 'rd', 'del', 'erase'].includes(name)) {
    if (has('-recurse')) return 'Recursive delete (Remove-Item -Recurse)';
    if (name !== 'rm' && name !== 'remove-item' && name !== 'ri' && has('/s')) {
      return 'Recursive delete (rmdir /s, del /s)';
    }
  }
  if (name === 'find') {
    // Deleting by name (`-name '*.bak' -delete`, the usual cleanup after
    // `sed -i.bak`, 16 of 4,799 recorded commands) is targeted; deleting
    // everything under a path is not.
    const exec = lower.findIndex((a) => a === '-exec' || a === '-execdir' || a === '-ok');
    const deletes = has('-delete') || (exec >= 0 && ['rm', 'rmdir', 'unlink'].includes(baseName(args[exec + 1] ?? '')));
    const filter = lower.findIndex((a) => /^-i?(name|path|wholename|regex)$/.test(a));
    if (deletes && (filter < 0 || args[filter + 1] === '*')) {
      return 'find that deletes everything it reaches (-delete, -exec rm)';
    }
  }
  if (name === 'git') return destructiveGit(args);
  return null;
}

function destructiveGit(args: string[]): string | null {
  // Past git's own options (-C <dir>, -c <key=value>) to the subcommand.
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
  const [sub, ...rest] = args.slice(i);
  const short = shortFlags(rest);
  const has = (...flags: string[]) => flags.some((f) => rest.includes(f));
  const discards = 'Discards uncommitted changes (git checkout / restore of the whole tree)';
  switch (sub) {
    case 'push':
      // A `+` refspec (`+main`) force-pushes that ref.
      return short.includes('f') || rest.some((a) => a.startsWith('--force') || /^\+\S/.test(a))
        ? 'Force push to remote (git push --force)'
        : null;
    case 'reset':
      return has('--hard') ? 'Hard reset (git reset --hard discards uncommitted changes)' : null;
    case 'branch':
      return short.includes('D') ||
        ((short.includes('d') || has('--delete')) && (short.includes('f') || has('--force')))
        ? 'Force branch delete (git branch -D)'
        : null;
    case 'clean':
      return short.includes('f') || has('--force') ? 'git clean (removes untracked files)' : null;
    case 'checkout':
      return short.includes('f') || has('--force') || has('.') ? discards : null;
    case 'restore':
      // `--staged` alone only unstages; the work tree is untouched.
      return has('.') && !(has('--staged', '-S') && !has('--worktree', '-W')) ? discards : null;
    default:
      return null;
  }
}

export function detectIrrecoverable(toolUse: ToolUseContentBlock): string | null {
  const name = toolUse.name;
  const input = toolUse.input as Record<string, unknown>;

  // Every tool that runs a shell command, not only run_command: run_tests and
  // research_log_experiment take a free-form command too.
  const shellCommand = shellCommandOf(toolUse);
  if (shellCommand !== null) {
    const cmd = shellCommand;
    // Read per simple command and by its words, so a flag's order, grouping
    // or spelling (-rfv, -r -f, +main, -fu) and the other shells' commands
    // for the same thing (rmdir /s, Remove-Item -Recurse) all count.
    for (const words of commandSegments(cmd)) {
      const found = destructiveSegment(words);
      if (found) return found;
    }
    // Database DROP / TRUNCATE
    if (/\b(?:DROP|TRUNCATE)\s+(?:DATABASE|TABLE|SCHEMA|INDEX)\b/i.test(cmd)) {
      return 'Destructive SQL (DROP / TRUNCATE)';
    }
    // chmod / chown on home dir roots
    if (/\b(?:chmod|chown)\b.*[\s=](?:\/|~|\$HOME)/.test(cmd)) {
      return 'Permission change targeting home or root';
    }
  }

  // A file another program runs commands from (VS Code tasks, MCP servers,
  // git hook managers): planting one runs code later, outside any approval.
  if (name === 'write_file' || name === 'edit_file' || name === 'delete_file') {
    const target = typeof input.path === 'string' ? input.path : '';
    if (target && isExecutionConfigPath(target)) {
      return `Changes ${target}, a file other tools run commands from`;
    }
  }

  return null;
}
