import { describe, it, expect } from 'vitest';
import { findPythonIndentErrors, scanPythonIndent, PYTHON_INDENT_ERROR_CAP } from './pythonIndent.js';

const errs = (src: string) => findPythonIndentErrors(src);
const clean = (src: string) => expect(errs(src)).toEqual([]);

// #157 ML-09: tree-sitter-python reads an out-of-place `else` as an
// identifier, so an edit that orphaned one was written and CPython refused
// the file. Validated quiet on 11,637 CPython-compiled files (3.14 stdlib and
// site-packages, astropy, django).
describe('continuation clauses must follow a statement they can continue', () => {
  it('flags the orphaned else left by replacing an if header (the ML-09 case)', () => {
    const sign = ['def sign(x):', '    if x >= 0:', '        return 1', '    else:', '        return -1', ''].join(
      '\n',
    );
    const edited = sign.replace('    if x >= 0:\n        return 1', '    return 1');
    clean(sign);
    const e = errs(edited);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ line: 3 });
    expect(e[0].message).toMatch(/'else' on line 3 does not follow/);
  });

  it('flags elif after a for, except without a try, finally at the wrong level', () => {
    expect(errs('for i in x:\n    pass\nelif y:\n    pass\n')).toHaveLength(1);
    expect(errs('x = 1\nexcept ValueError:\n    pass\n')).toHaveLength(1);
    expect(errs('try:\n    a()\nexcept E:\n    b()\n    finally:\n        c()\n').length).toBeGreaterThan(0);
  });

  it('accepts every valid chain', () => {
    clean('if a:\n    x()\nelif b:\n    y()\nelse:\n    z()\n');
    clean('for i in r:\n    x()\nelse:\n    y()\n');
    clean('while c:\n    x()\nelse:\n    y()\n');
    clean('try:\n    x()\nexcept A:\n    y()\nexcept (B, C) as e:\n    z()\nelse:\n    w()\nfinally:\n    v()\n');
    clean('try:\n    x()\nfinally:\n    y()\n');
    clean('async def f():\n    async for i in g():\n        x()\n    else:\n        y()\n');
    clean('if a: x = 1\nelse: x = 2\n');
    clean('if a:\n    if b:\n        x()\n    else:\n        y()\nelse:\n    z()\n');
    clean('def f():\n    try:\n        return 1\n    except Exception:  # comment\n        return 2\n');
  });
});

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

  it('tab-only indentation is fine', () => {
    clean('def f():\n\tif True:\n\t\treturn 1\n');
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

// #157 ML-51: mixed tabs and spaces used to switch the whole check off. Each
// case's verdict below is CPython's own (`compile()` on 3.14).
describe('findPythonIndentErrors — mixed tabs and spaces, judged as CPython does (ML-51)', () => {
  it('flags indentation whose structure depends on tab width (CPython: TabError)', () => {
    // 4 spaces, then 2 tabs: deeper at tab width 8, but shallower at tab width 1.
    const e = errs('def f():\n    if True:\n\t\treturn 1\n');
    expect(e.length).toBeGreaterThan(0);
    expect(e[0]).toMatchObject({ line: 3 });
    expect(e[0].message).toContain('inconsistent use of tabs and spaces');
  });

  it('accepts mixing that means the same at any tab width (CPython: OK)', () => {
    // A tab-indented function and a space-indented one: each block is internally consistent.
    clean('def f():\n\treturn 1\n\ndef g():\n    return 2\n');
    // A tab, then a tab plus 4 spaces: deeper at both widths.
    clean('class A:\n\tdef f(self):\n\t    return 1\n');
  });

  it('checks a space-indented file that an edit gave one tab-indented line', () => {
    // The edit's line is a TabError; the old check skipped the whole file.
    const e = errs('def f():\n        x = 1\n\ty = 2\n');
    expect(e.map((x) => x.message).join(' ')).toContain('inconsistent use of tabs and spaces');
  });
});

// #157 ML-50: the count stopped at the cap with nothing saying so.
describe('scanPythonIndent saturation (ML-50)', () => {
  const broken = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? '    x = 1' : 'y = 2')).join('\n');

  it('says the list was cut short when there are more errors than the cap', () => {
    const r = scanPythonIndent(broken(60));
    expect(r.errors).toHaveLength(PYTHON_INDENT_ERROR_CAP);
    expect(r.saturated).toBe(true);
  });

  it('is not saturated when every error fits', () => {
    const r = scanPythonIndent('def f():\n    x = 1\n      y = 2\n');
    expect(r.errors.length).toBeLessThan(PYTHON_INDENT_ERROR_CAP);
    expect(r.saturated).toBe(false);
  });
});
