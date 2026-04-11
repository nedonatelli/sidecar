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

  it('detects "real implementation" deferrals', () => {
    const stubs = detectStubs('file.ts', '// In a real implementation, this would check the database');
    expect(stubs).toHaveLength(1);
    expect(stubs[0].category).toBe('deferred-implementation');
  });

  it('detects "actual implementation" deferrals', () => {
    const stubs = detectStubs('file.ts', '// The actual implementation would handle edge cases');
    expect(stubs).toHaveLength(1);
    expect(stubs[0].category).toBe('deferred-implementation');
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

  it('detects "for now" hedging', () => {
    const stubs = detectStubs('file.ts', '// for now, just return empty');
    expect(stubs).toHaveLength(1);
    expect(stubs[0].category).toBe('for-now-hedge');
  });

  it('detects "would be" future deferral', () => {
    const stubs = detectStubs('file.ts', '// this would need a more sophisticated approach');
    expect(stubs).toHaveLength(1);
    expect(stubs[0].category).toBe('future-deferral');
  });

  it('detects ellipsis-only body', () => {
    const stubs = detectStubs('file.py', '  ...');
    expect(stubs).toHaveLength(1);
    expect(stubs[0].category).toBe('ellipsis-body');
  });

  it('detects Python pass-only body', () => {
    const stubs = detectStubs('file.py', '    pass');
    expect(stubs).toHaveLength(1);
    expect(stubs[0].category).toBe('pass-body');
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
    // "for now" and "placeholder" both match, but should only get one
    const stubs = detectStubs('file.ts', '// for now, placeholder logic');
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
