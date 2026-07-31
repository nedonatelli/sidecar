# Byte-domain corpus

Real files whose **bytes** are the test input, written from outside the
TypeScript source. Every other fixture in this repo is a TS string literal,
which means the test and the implementation share one author's assumptions —
and that is exactly how `edit_file` shipped unable to edit a CRLF file on any
multi-line search while 8,350 tests passed.

Rules:

- **Do not open these in an editor that normalizes line endings on save.** The
  `.gitattributes` here disables git's own conversion; your editor is on you.
- **Do not "fix" a file because it looks wrong.** A lone `\r`, a BOM, a missing
  final newline and a 5,000-character line are all deliberate.
- Add a file per *property*, not per scenario, and keep it small.
- The matrix in `byteDomain.test.ts` picks up new files automatically. A new
  file with no property to assert is noise; give it one.
