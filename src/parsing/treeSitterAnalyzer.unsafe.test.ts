import { describe, it, expect, vi } from 'vitest';
import { grammarsDir, hasGrammars } from './grammarsTestSupport.js';
import { createTreeSitterAnalyzer, TreeSitterCodeAnalyzer } from './treeSitterAnalyzer.js';
import { loadLanguage } from './treeSitterLoader.js';
import type { Parser } from './treeSitterLoader.js';
import { logger } from '../system/logger.js';

// bash's scanner imports isalpha, which web-tree-sitter's runtime (0.24 and 0.25) does not
// export: a `case` statement threw "resolved is not a function" mid-parse, the
// runtime was left corrupt, and in the extension host every later parse in
// every language failed -- 102 of this repo's 3,449 files silently dropped out
// of the symbol graph.

const SHELL_WITH_CASE = 'usage() { echo usage; }\ncase "$1" in\n  -h) usage ;;\nesac\n';

describe.skipIf(!hasGrammars)('tree-sitter grammars that cannot run safely', () => {
  it('never loads the bash grammar', async () => {
    await expect(loadLanguage(grammarsDir, 'bash')).rejects.toThrow(/disabled.*isalpha/);
  });

  it('loads the dart grammar on web-tree-sitter 0.25, and reports no load failure (#400)', async () => {
    await expect(loadLanguage(grammarsDir, 'dart')).resolves.toBeDefined();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const analyzer = await createTreeSitterAnalyzer(grammarsDir);
      expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes("grammar 'dart'"))).toEqual([]);
      const dart = analyzer.parseFileContent('lib/a.dart', 'class Greeter {\n  void greet() {}\n}\n');
      expect(dart.elements.map((e) => e.name)).toContain('Greeter');
    } finally {
      warn.mockRestore();
    }
  });

  it('parses a shell script with the regex analyzer, and python still parses afterwards', async () => {
    const analyzer = await createTreeSitterAnalyzer(grammarsDir);
    const sh = analyzer.parseFileContent('scripts/run.sh', SHELL_WITH_CASE);
    expect(sh.filePath).toBe('scripts/run.sh');

    const py = analyzer.parseFileContent('k.py', 'def f(v: np.ndarray) -> None:\n    return None\n');
    expect((py.typeUses ?? []).map((u) => u.typeName)).toContain('ndarray');
  });
});

describe('TreeSitterCodeAnalyzer — a parse that throws', () => {
  it('falls back to the regex analyzer and stops using that language', () => {
    const parse = vi.fn(() => {
      throw new Error('resolved is not a function');
    });
    const analyzer = new TreeSitterCodeAnalyzer(new Map([['python', { parse } as unknown as Parser]]));

    const first = analyzer.parseFileContent('a.py', 'def first():\n    pass\n');
    expect(first.elements.map((e) => e.name)).toContain('first'); // regex result, not a throw
    analyzer.parseFileContent('b.py', 'def second():\n    pass\n');
    expect(parse).toHaveBeenCalledTimes(1); // the language was dropped after the throw
  });
});
