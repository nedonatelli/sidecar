// UTF-8 output from Python commands on Windows.
//
// SideCar decodes every command's output as UTF-8. On Windows, Python writing
// to a pipe uses the ANSI code page (cp1252) instead, so its output arrived as
// mojibake (U+FFFD), and printing a character cp1252 cannot hold (✓, →, most
// non-Latin text, common in test output and paths) raised UnicodeEncodeError
// and the command died. The same applies when Python reads a UTF-8 file
// without an explicit encoding. PYTHONUTF8=1 puts Python in UTF-8 mode for
// I/O and file defaults; PYTHONIOENCODING covers interpreters older than 3.7,
// which ignore it. A value the user has set is kept.

/** `env` with Python forced to UTF-8 on Windows; unchanged elsewhere. */
export function withUtf8ChildEnv(
  env: Record<string, string | undefined>,
  isWindows: boolean,
): Record<string, string | undefined> {
  if (!isWindows) return env;
  return {
    ...env,
    PYTHONUTF8: env.PYTHONUTF8 ?? '1',
    PYTHONIOENCODING: env.PYTHONIOENCODING ?? 'utf-8',
  };
}
