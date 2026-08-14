import { describe, it, expect } from 'vitest';
import { findPythonIndentErrors } from './pythonIndent.js';

const errs = (src: string) => findPythonIndentErrors(src);
const clean = (src: string) => expect(errs(src)).toEqual([]);

// A false positive REFUSES A LEGITIMATE EDIT, which is worse than the
// corruption this prevents. So the no-false-positive suite comes first and is
// deliberately the larger one.
describe('findPythonIndentErrors — must NOT fire on valid Python', () => {
  it('plain functions, classes, nesting', () => {
    clean('def f():\n    return 1\n');
    clean('class A:\n    def m(self):\n        if True:\n            return 2\n        return 3\n');
    clean('def f():\n    pass\n\n\ndef g():\n    pass\n');
  });

  it('blank lines, comments, and comment-only lines at any indent', () => {
    clean('def f():\n\n    # a comment\n        # deeper comment, meaningless\n    return 1\n');
    clean('# leading\ndef f():\n    return 1\n# trailing\n');
  });

  it('multi-line bracket continuations at arbitrary indentation', () => {
    clean('x = foo(\n  1,\n        2,\n)\n');
    clean('d = {\n    "a": 1,\n        "b": 2,\n}\n');
    clean('def f(\n    a,\n    b,\n):\n    return a + b\n');
  });

  it('backslash continuations', () => {
    clean('x = 1 + \\\n        2\ny = 3\n');
  });

  it('triple-quoted strings whose CONTENT is arbitrarily indented', () => {
    clean('def f():\n    """Doc.\n\nNot indented at all.\n        Wildly indented.\n    """\n    return 1\n');
    clean("SQL = '''\nSELECT *\n  FROM t\n'''\nx = 1\n");
  });

  it('a docstring followed by dedented code', () => {
    clean('def f():\n    """Doc."""\n    return 1\n\n\nx = f()\n');
  });

  it('one-liner bodies (legal: no indented block needed)', () => {
    clean('def f(): return 1\n');
    clean('if True: x = 1\nelse: x = 2\n');
  });

  it('strings containing colons and brackets do not confuse the scanner', () => {
    clean('x = "def g():"\ny = 2\n');
    clean('x = "unclosed ( bracket"\ny = 2\n');
    clean('x = "# not a comment"\ny = 2\n');
  });

  it('mixed tabs and spaces are skipped entirely rather than adjudicated', () => {
    clean('def f():\n\tif True:\n\t\treturn 1\n');
    clean('def f():\n    if True:\n\t\treturn 1\n'); // ambiguous → no opinion
  });
});

describe('findPythonIndentErrors — must fire on real IndentationErrors', () => {
  it('the ORPHANED BODY — the corruption class that cost the dogfood session', () => {
    // Replace a block header with a self-contained one-liner and the old body is
    // left dangling. In TypeScript this breaks the braces (tree-sitter catches
    // it); in Python it is purely an indentation error, which tree-sitter parses
    // as clean. This is the case that made an edit-time Python check necessary.
    const orphaned = 'def welcome(name): return name\n    return name\n';
    const found = errs(orphaned);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(2);
    expect(found[0].message).toMatch(/unexpected indent/i);
  });

  it('unindent that matches no enclosing level', () => {
    const bad = 'def f():\n    x = 1\n  y = 2\n';
    const found = errs(bad);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(3);
    expect(found[0].message).toMatch(/unindent does not match/i);
  });

  it('a block opener with no indented body', () => {
    const bad = 'def f():\nreturn 1\n';
    // Dedent-to-0 after `:` is "expected an indented block" in CPython; our
    // scanner reports it as the same class of error at the offending line.
    expect(errs(bad).length).toBeGreaterThanOrEqual(1);

    const sameIndent = 'if True:\nx = 1\n';
    expect(errs(sameIndent).length).toBeGreaterThanOrEqual(1);
  });

  it('an opener whose body dedents to a VALID OUTER level (the django-10914 shape)', () => {
    // gemma removed the `break` under an `else:`, leaving the `else:` (indent 12)
    // immediately followed by a line at indent 8 — a real IndentationError
    // ("expected an indented block after 'else'"). The dedent lands on a VALID
    // enclosing level, so the old dedent branch found a stack match and shipped a
    // file py_compile rejects. A block opener MUST be followed by a deeper line.
    const bad =
      'def _save(self):\n' +
      '    while True:\n' +
      '        try:\n' +
      '            pass\n' +
      '        except FileExistsError:\n' +
      '            full_path = self.path(name)\n' +
      '        else:\n' +
      '    if self.file_permissions_mode is not None:\n' +
      '        os.chmod(full_path, self.file_permissions_mode)\n';
    const found = errs(bad);
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0].message).toMatch(/expected an indented block/i);
  });

  it('indent after a non-opening line', () => {
    const bad = 'x = 1\n    y = 2\n';
    const found = errs(bad);
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/does not open a block/i);
  });

  it('bounds the error list rather than cascading', () => {
    const messy = Array.from({ length: 50 }, (_, i) => (i % 2 ? '    x = 1' : 'y = 2')).join('\n');
    expect(errs(messy).length).toBeLessThanOrEqual(10);
  });
});
