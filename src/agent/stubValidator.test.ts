import { describe, it, expect } from 'vitest';
import { detectStubs, buildStubReprompt } from './stubValidator.js';

describe('detectStubs', () => {
  it('detects TODO comments', () => {
    const stubs = detectStubs('app.ts', '// TODO: implement this later');
    expect(stubs).toHaveLength(1);
    expect(stubs[0].category).toBe('todo-comment');
  });

  it('detects FIXME comments', () => {
    const stubs = detectStubs('app.ts', '// FIXME: broken logic');
    expect(stubs).toHaveLength(1);
    expect(stubs[0].category).toBe('todo-comment');
  });

  it('detects Python TODO comments', () => {
    const stubs = detectStubs('app.py', '# TODO: finish this');
    expect(stubs).toHaveLength(1);
    expect(stubs[0].category).toBe('todo-comment');
  });

  it('detects placeholder comments', () => {
    const cases = [
      '// implement this function',
      '// placeholder logic',
      '// stub implementation',
      '// add logic here',
      '// fill in the details',
      '# your code goes here',
    ];
    for (const line of cases) {
      const stubs = detectStubs('file.ts', line);
      expect(stubs.length, `should detect: ${line}`).toBeGreaterThan(0);
      expect(stubs[0].category).toBe('placeholder-comment');
    }
  });

  it('does NOT flag comment-only "implementation" / "in a real app" hedges', () => {
    // Comment-only hedges removed — they match common legitimate explanatory
    // comments ("the full implementation lives in X", "in a real app you'd
    // cache this") and a comment-only check can't tell them from a stub.
    expect(detectStubs('file.ts', '// In a real implementation, this would check the database')).toHaveLength(0);
    expect(detectStubs('file.ts', '// The actual implementation lives in service.ts')).toHaveLength(0);
    expect(detectStubs('file.ts', '// in a real app you would cache this')).toHaveLength(0);
  });

  it('detects NotImplementedError throws', () => {
    const stubs = detectStubs('file.ts', "throw new Error('Not implemented');");
    expect(stubs).toHaveLength(1);
    expect(stubs[0].category).toBe('not-implemented');
  });

  it('detects Python NotImplementedError', () => {
    const stubs = detectStubs('file.py', 'raise NotImplementedError');
    expect(stubs).toHaveLength(1);
    expect(stubs[0].category).toBe('not-implemented');
  });

  it('detects dummy return with placeholder comment', () => {
    const stubs = detectStubs('file.ts', 'return null; // placeholder');
    expect(stubs).toHaveLength(1);
    // "// placeholder" matches the placeholder-comment pattern first
    expect(stubs[0].category).toBe('placeholder-comment');
  });

  it('detects dummy return with stub comment', () => {
    const stubs = detectStubs('file.ts', 'return 0; // stub value');
    expect(stubs).toHaveLength(1);
    expect(stubs[0].category).toBe('placeholder-comment');
  });

  it('does NOT flag a legitimate "for now" explanatory comment', () => {
    // "for now" is pervasive in real code as a current-state explanation; a
    // comment-only heuristic false-positives on it (dogfooding: a correct
    // `# For now, just display current value (no-op)` spiraled a strong model).
    expect(detectStubs('file.py', '# For now, display the current value (no-op)\n    pass')).toHaveLength(0);
  });

  it('does NOT flag "would need" limitation notes (removed future-deferral hedge)', () => {
    expect(detectStubs('file.ts', '// this would need a more sophisticated approach')).toHaveLength(0);
  });

  it('detects ellipsis-only body', () => {
    const stubs = detectStubs('file.py', '  ...');
    expect(stubs).toHaveLength(1);
    expect(stubs[0].category).toBe('ellipsis-body');
  });

  it('detects Python pass-only body when it is a function body', () => {
    const stubs = detectStubs('file.py', 'def do_work():\n    pass');
    expect(stubs).toHaveLength(1);
    expect(stubs[0].category).toBe('pass-body');
  });

  it('does NOT flag a legitimate `pass` in an except block', () => {
    const code = 'try:\n    value = int(x)\nexcept ValueError:\n    pass  # ignore bad input';
    expect(detectStubs('file.py', code)).toHaveLength(0);
  });

  it('does NOT flag `pass` in a control-flow block or empty exception class', () => {
    expect(detectStubs('a.py', 'for x in items:\n    pass')).toHaveLength(0);
    expect(detectStubs('b.py', 'class MyError(Exception):\n    pass')).toHaveLength(0);
  });

  it('detects inline empty typed body', () => {
    const stubs = detectStubs('file.ts', 'value(): number {}');
    expect(stubs).toHaveLength(1);
    expect(stubs[0].category).toBe('empty-typed-body');
  });

  it('detects multi-line empty typed body', () => {
    const code = ['size(): number {', '}'].join('\n');
    const stubs = detectStubs('file.ts', code);
    expect(stubs).toHaveLength(1);
    expect(stubs[0].category).toBe('empty-typed-body');
  });

  it('does not flag empty void body (void is intentionally empty)', () => {
    const stubs = detectStubs('file.ts', 'increment(): void {}');
    expect(stubs).toHaveLength(0);
  });

  it('does not flag constructor with empty body (no return type)', () => {
    const stubs = detectStubs('file.ts', 'constructor() {}');
    expect(stubs).toHaveLength(0);
  });

  it('does not flag typed body that has a real implementation', () => {
    const code = 'getValue(): number { return this.count; }';
    expect(detectStubs('file.ts', code)).toHaveLength(0);
  });

  it('returns empty for clean code', () => {
    const code = ['function add(a: number, b: number): number {', '  return a + b;', '}'].join('\n');
    expect(detectStubs('file.ts', code)).toHaveLength(0);
  });

  it('skips blank lines', () => {
    expect(detectStubs('file.ts', '\n\n\n')).toHaveLength(0);
  });

  it('skips TODOs that reference issue trackers', () => {
    const stubs = detectStubs('file.ts', '// TODO(https://github.com/org/repo/issues/123) fix later');
    expect(stubs).toHaveLength(0);
  });

  it('skips TODOs referencing ticket numbers', () => {
    const stubs = detectStubs('file.ts', '// TODO(#456) handle edge case');
    expect(stubs).toHaveLength(0);
  });

  it('reports one match per line even with multiple patterns', () => {
    // "implement" and "placeholder" both match, but should only get one
    const stubs = detectStubs('file.ts', '// implement placeholder logic here');
    expect(stubs).toHaveLength(1);
  });

  it('reports file path in matches', () => {
    const stubs = detectStubs('src/utils/helper.ts', '// TODO: wire up');
    expect(stubs[0].file).toBe('src/utils/helper.ts');
  });

  it('detects multiple stubs across lines', () => {
    const code = ['function process() {', '  // TODO: implement', '  return null; // placeholder', '}'].join('\n');
    const stubs = detectStubs('file.ts', code);
    expect(stubs).toHaveLength(2);
  });

  it('detects simulation console.log (gemma4-style placeholder)', () => {
    const code = 'console.log(`[Retriever] Simulating retrieval for file: ${path}`);';
    expect(detectStubs('retriever.ts', code)).toHaveLength(1);
    expect(detectStubs('retriever.ts', code)[0].category).toBe('simulation-stub');
  });

  it('does NOT flag a bare "// Simulating" comment (kept only the console.log code pattern)', () => {
    // The comment-only `// simulating` variant was removed — legitimate
    // simulation code uses it ("// simulating N Monte-Carlo trials"). The
    // strong signal is the CODE pattern (console.log("Simulating ...")) above.
    expect(detectStubs('embed.ts', '// Simulating embedding generation here')).toHaveLength(0);
  });

  it('detects magic-number Array fill (dummy embedding)', () => {
    const code = 'return Array(768).fill(0.1);';
    expect(detectStubs('embed.ts', code)).toHaveLength(1);
    expect(detectStubs('embed.ts', code)[0].category).toBe('dummy-fill');
  });

  it('detects new Array fill variant', () => {
    const code = 'const vec = new Array(1536).fill(0);';
    expect(detectStubs('embed.ts', code)).toHaveLength(1);
  });

  it('detects // dummy comment', () => {
    const code = '// dummy implementation for now';
    expect(detectStubs('util.ts', code)).toHaveLength(1);
    expect(detectStubs('util.ts', code)[0].category).toBe('placeholder-comment');
  });

  it('no longer flags a "REAL IMPLEMENTATION" comment banner (deferred-implementation hedge removed)', () => {
    // Trade-off of dropping the comment-only hedge class: an explicit
    // "REAL IMPLEMENTATION REQUIRED" banner is no longer caught. It's rare, and
    // a genuinely-stubbed body still trips the hard signals (TODO, pass-in-def,
    // NotImplementedError, empty body) + the completion gate's test run.
    expect(detectStubs('svc.ts', '// --- REAL IMPLEMENTATION REQUIRED ---')).toHaveLength(0);
  });

  it('detects [tool_name] bracket prefix in console.log (placeholder log)', () => {
    const code = 'console.log("[embedding] called with input");';
    expect(detectStubs('embed.ts', code)).toHaveLength(1);
    expect(detectStubs('embed.ts', code)[0].category).toBe('placeholder-log');
  });

  it('detects "placeholder" keyword in console.log', () => {
    const code = 'console.log("placeholder executed — replace with real impl");';
    expect(detectStubs('tool.ts', code)).toHaveLength(1);
    expect(detectStubs('tool.ts', code)[0].category).toBe('placeholder-log');
  });

  it('detects [tool_name] bracket prefix in Python print', () => {
    const code = 'print("[vector_search] stub")';
    expect(detectStubs('retriever.py', code)).toHaveLength(1);
    expect(detectStubs('retriever.py', code)[0].category).toBe('placeholder-log');
  });

  it('does not flag legitimate named log calls without placeholder language', () => {
    const code = 'console.log("processing complete, saved", count, "items");';
    expect(detectStubs('util.ts', code)).toHaveLength(0);
  });
});

describe('buildStubReprompt', () => {
  it('returns null when no file-writing tools are present', () => {
    const result = buildStubReprompt([{ name: 'read_file', input: { path: 'file.ts' } }]);
    expect(result).toBeNull();
  });

  it('returns null when written code is clean', () => {
    const result = buildStubReprompt([
      {
        name: 'write_file',
        input: {
          path: 'file.ts',
          content: 'export function add(a: number, b: number) { return a + b; }',
        },
      },
    ]);
    expect(result).toBeNull();
  });

  it('returns reprompt for write_file with stubs', () => {
    const result = buildStubReprompt([
      {
        name: 'write_file',
        input: {
          path: 'utils.ts',
          content: '// TODO: implement the sorting logic',
        },
      },
    ]);
    expect(result).not.toBeNull();
    expect(result).toContain('utils.ts');
    expect(result).toContain('placeholder');
  });

  it('returns reprompt for edit_file with stubs', () => {
    const result = buildStubReprompt([
      {
        name: 'edit_file',
        input: {
          path: 'handler.ts',
          search: 'old code',
          replace: '// placeholder implementation\nreturn null;',
        },
      },
    ]);
    expect(result).not.toBeNull();
    expect(result).toContain('handler.ts');
  });

  it('aggregates stubs across multiple file writes', () => {
    const result = buildStubReprompt([
      {
        name: 'write_file',
        input: { path: 'a.ts', content: '// TODO: finish' },
      },
      {
        name: 'edit_file',
        input: { path: 'b.ts', search: 'x', replace: '// stub logic' },
      },
    ]);
    expect(result).not.toBeNull();
    expect(result).toContain('a.ts');
    expect(result).toContain('b.ts');
  });

  it('ignores non-file-writing tools', () => {
    const result = buildStubReprompt([
      { name: 'grep', input: { pattern: '// TODO' } },
      {
        name: 'write_file',
        input: { path: 'clean.ts', content: 'const x = 42;' },
      },
    ]);
    expect(result).toBeNull();
  });

  it('handles file_path alias in input', () => {
    const result = buildStubReprompt([
      {
        name: 'write_file',
        input: { file_path: 'app.ts', content: '// TODO: add routes' },
      },
    ]);
    expect(result).not.toBeNull();
    expect(result).toContain('app.ts');
  });
});
