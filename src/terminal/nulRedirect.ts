// ---------------------------------------------------------------------------
// cmd-style `nul` redirects in a POSIX shell on Windows (#395).
//
// Models write `dir /s /b foo 2>nul` out of cmd habit. run_command runs Git
// Bash on Windows, where `nul` is not the null device: bash creates a real file
// named `nul`. Windows reserves that name, so Explorer and `git clean` cannot
// delete it ("failed to remove nul: Permission denied"); it stays in the
// user's repo, and in the SWE benchmark one such file stopped a whole run.
//
// The command clearly meant the null device, so redirect targets of `nul` are
// rewritten to `/dev/null`. Only unquoted redirect targets change: a quoted
// "nul" argument, `null`, `nul.txt` and heredoc delimiters stay as written.
// ---------------------------------------------------------------------------

/** `>nul`, `2>nul`, `>>nul`, `&>nul`, `2>>nul`, `<nul` (any case, optional space), not `<<nul`. */
const NUL_TARGET = /(&?>>?|(?<!<)<(?!<))([ \t]*)nul(?=$|[\s;|&)<>])/gi;

/**
 * Blank out quoted spans and backslash escapes (same length), so a match on the
 * result is an unquoted redirect at the same offsets in the original.
 */
function maskQuoted(command: string): string {
  let out = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && i + 1 < command.length) {
      out += '__';
      i++;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== c) j += c === '"' && command[j] === '\\' ? 2 : 1;
      const end = Math.min(j, command.length - 1);
      out += '_'.repeat(end - i + 1);
      i = end;
    } else {
      out += c;
    }
  }
  return out;
}

/** Rewrite cmd-style `nul` redirect targets to `/dev/null`, outside quotes. */
export function rewriteNulRedirects(command: string): string {
  if (!/nul/i.test(command)) return command;
  const masked = maskQuoted(command);
  let out = '';
  let last = 0;
  for (const m of masked.matchAll(NUL_TARGET)) {
    const start = m.index + m[1].length + m[2].length;
    out += command.slice(last, start) + '/dev/null';
    last = start + 3;
  }
  return out + command.slice(last);
}
