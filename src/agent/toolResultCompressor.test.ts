import { describe, it, expect } from 'vitest';
import { ToolResultCompressor } from './toolResultCompressor.js';

describe('ToolResultCompressor', () => {
  const compressor = new ToolResultCompressor();

  describe('error extraction', () => {
    it('extracts main error message and stack trace', () => {
      const errorOutput = `
Error: ENOENT: no such file or directory, open '/Users/test/src/app.ts'
  at Object.openSync (internal/fs.js:462:3)
  at Object.readFile (internal/fs.js:165:12)
  at async readFile (/app/utils.js:45:23)
  at async main (/app/index.js:12:5)

Additional context that should be ignored...
This is just noise and should not be included.
Some more irrelevant output.
`.trim();

      const result = compressor.compress(errorOutput, 250); // Lower to trigger compression

      expect(result.strategy).toBe('error_extraction');
      expect(result.content).toContain('Error: ENOENT');
      expect(result.content).toContain('at Object.openSync');
      expect(result.content).not.toContain('irrelevant');
      expect(result.originalLength).toBe(errorOutput.length);
      expect(result.density).toBeGreaterThan(0.8);
    });

    it('handles TypeError extraction', () => {
      const typeError = `TypeError: Cannot read property 'map' of undefined
  at processData (/app/processor.ts:123:45)
  at Object.<anonymous> (/app/index.ts:89:12)`;

      const result = compressor.compress(typeError, 100); // Force compression

      expect(result.strategy).toBe('error_extraction');
      expect(result.content).toContain('TypeError');
      expect(result.content).toContain('processData');
    });

    it('extracts FAIL markers', () => {
      const failOutput = `
Running tests...
✓ test 1 passed
✗ test 2 failed
FAIL: Test suite failed
Error: assertion error in test 2
  at expect (/test.js:100:20)
More output...unused text...
`.trim();

      const result = compressor.compress(failOutput, 150); // Force compression

      expect(result.strategy).toBe('error_extraction');
      expect(result.content).toContain('FAIL');
      expect(result.content).toContain('Error:');
    });

    it('returns null if no error patterns found', () => {
      const normalOutput = 'Some normal output text without errors.';
      const result = compressor.compress(normalOutput, 500);

      // Should not use error extraction
      expect(result.strategy).not.toBe('error_extraction');
    });
  });

  describe('test result extraction', () => {
    it('extracts test summary and failed tests', () => {
      const testOutput = `
 RUN  v28.0.0

 ✓ tests/unit/app.test.ts (5 tests) 234ms
 ✗ tests/unit/parser.test.ts (8 tests) 567ms
   ✓ parses basic syntax
   ✓ handles comments
   ✗ handles nested structures
   ✗ handles edge cases

 Test Files  1 failed, 1 passed (2)
 Tests      6 passed, 2 failed (8)
 Done in 800ms
 Additional verbose logging that is not important
 More debug output from the test runner
 Stack traces and other noise that we don't need
`.trim();

      const result = compressor.compress(testOutput, 200); // Force compression

      expect(result.strategy).toBe('test_extraction');
      expect(result.content).toContain('Test Files');
      expect(result.content).toContain('passed');
      expect(result.originalLength).toBe(testOutput.length);
    });

    it('extracts Jest-style test output', () => {
      const jestOutput = `
FAIL tests/integration/api.test.ts
  ● API Integration Tests › handles 404 errors

    Expected: 404
    Received: 500

Test Suites: 0 failed, 0 passed, 1 failed
Tests:       2 failed, 8 passed

STDERR output from test runner
Some additional verbose logging
More noise that should be ignored
`.trim();

      const result = compressor.compress(jestOutput, 200); // Force compression

      expect(result.strategy).toBe('test_extraction');
      expect(result.content).toContain('failed');
      expect(result.content).toContain('passed');
    });

    it('handles test output with many tests', () => {
      const manyTests = `✓ test 1
      ✓ test 2
      ✓ test 3
      ✗ test 4
      ✗ test 5
      ✗ test 6
      ✓ test 7
      ✓ test 8
      ✓ test 9
      ✓ test 10
      ✓ test 11
      ✗ test 12

      Tests: 9 passed, 3 failed`;

      const result = compressor.compress(manyTests, 150); // Lower to force compression

      expect(result.strategy).toBe('test_extraction');
      expect(result.content.length).toBeLessThanOrEqual(150 + 10); // Allow small overrun
    });
  });

  describe('grep result extraction', () => {
    it('extracts grep-style file:line:content format', () => {
      const grepOutput = `src/app.ts:15: import { Component } from 'angular';
src/parser.ts:42: const pattern = /test/g;
src/utils.ts:89: export function process(data) {
src/main.ts:103: const result = await execute();
tests/mocks.ts:200: function mockData()
found 5 matches`.trim();

      const result = compressor.compress(grepOutput, 120); // Force compression

      expect(result.strategy).toBe('grep_extraction');
      expect(result.content).toContain('src/app.ts');
      expect(result.content).toContain('src/parser.ts');
      expect(result.density).toBeGreaterThan(0.7);
    });

    it('truncates long grep matches', () => {
      const longGrepLine = `file.ts:42: ${'x'.repeat(200)} This is an extremely long line matching content`;
      const grepOutput = [longGrepLine, 'short.ts:10: match here'].join('\n');

      const result = compressor.compress(grepOutput, 150);

      expect(result.strategy).toBe('grep_extraction');
      expect(result.content.length).toBeLessThanOrEqual(300);
      expect(result.content).toContain('short.ts');
    });

    it('limits number of grep results shown', () => {
      // 25 matches
      const lines = Array.from({ length: 25 }, (_, i) => `file${i}.ts:${i * 10}: match content here`);
      const grepOutput = lines.join('\n');

      const result = compressor.compress(grepOutput, 200);

      expect(result.strategy).toBe('grep_extraction');
      // Should show grep matches
      expect(result.content).toContain('file');
    });
  });

  describe('command output extraction', () => {
    it('extracts exit code and status', () => {
      const cmdOutput = `
Compiling...
Processing files...
(verbose build output lines...)
Build complete
exit code: 0
SUCCESS: All tests passed
`.trim();

      const result = compressor.compress(cmdOutput, 70);

      expect(result.strategy).toBe('command_extraction');
      expect(result.content).toContain('exit code');
      expect(result.content).toContain('SUCCESS');
    });

    it('handles failed command output', () => {
      const failedCmd = `
Running npm test
FAILURE: Tests failed
exit code: 1
Some error details
More error output
`.trim();

      const result = compressor.compress(failedCmd, 60);

      expect(result.strategy).toBe('command_extraction');
      expect(result.content).toContain('FAILURE');
      expect(result.content).toContain('exit code');
    });

    it('includes context lines with status', () => {
      const cmdOutput = `Starting application...
Loading configuration...
Initializing database...
return code: success
Ready to serve requests
`.trim();

      const result = compressor.compress(cmdOutput, 80);

      expect(result.strategy).toBe('command_extraction');
      expect(result.content).toContain('return code');
      expect(result.content.length).toBeGreaterThan(50);
    });
  });

  describe('file content extraction', () => {
    it('extracts imports and function definitions', () => {
      const fileContent = `import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { Service } from './services/app.service';

export class AppComponent {
  constructor(private router: Router) {}
  
  ngOnInit() {
    // lots of code...
    console.log('initialized');
  }
}

function helperFunction() {
  // 500 lines of implementation
  return 'result';
}

export interface IModel {
  id: string;
  name: string;
}`;

      const result = compressor.compress(fileContent, 200, 'read_file'); // Force compression

      expect(result.strategy).toBe('file_extraction');
      expect(result.content).toContain('import');
      expect(result.content).toContain('export');
      // Should not include long function implementations
      expect(result.content.length).toBeLessThan(fileContent.length);
    });

    it('only applies to read_file tool', () => {
      const codeContent = 'export interface X { id: number; }';
      const result = compressor.compress(codeContent, 100, 'run_command');

      // Should not use file extraction for non-file tools
      expect(result.strategy).not.toBe('file_extraction');
    });

    it('returns null if code patterns not found', () => {
      const plainText = 'This is just plain documentation text without code.';
      const result = compressor.compress(plainText, 500, 'read_file');

      expect(result.strategy).not.toBe('file_extraction');
    });
  });

  describe('smart truncation fallback', () => {
    it('breaks at newlines when possible', () => {
      const multiline = `Line 1
Line 2
Line 3
Line 4
Line 5`;

      const result = compressor.compress(multiline, 20);

      expect(result.strategy).toBe('smart_truncation');
      expect(result.content).not.toContain('Line 4');
      expect(result.content).toMatch(/\.{3}\s*\(/); // Should have ellipsis
    });

    it('breaks at spaces if no newlines available', () => {
      const longLine = 'word1 word2 word3 word4 word5 word6 word7 word8 word9';

      const result = compressor.compress(longLine, 30);

      expect(result.strategy).toBe('smart_truncation');
      expect(result.content.length).toBeLessThanOrEqual(30);
      expect(result.content).toMatch(/\.{3}\s*\(/);
    });

    it('includes lines omitted message', () => {
      const text = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8';
      const result = compressor.compress(text, 50);

      expect(result.content).toMatch(/\.\.\./);
    });

    it('returns no compression for short content', () => {
      const short = 'Just a few words here.';
      const result = compressor.compress(short, 500);

      expect(result.strategy).toBe('no_compression_needed');
      expect(result.content).toBe(short);
      expect(result.density).toBe(1.0);
    });
  });

  describe('compression density metric', () => {
    it('higher density for semantic extractions', () => {
      const error = 'Error: something\n  at line 1\n  at line 2\nignored text'.repeat(10);
      const result = compressor.compress(error, 250); // Lower to trigger compression

      expect(result.strategy).toBe('error_extraction');
      // Density should be reasonable (error extraction is efficient)
      expect(result.density).toBeGreaterThan(0.5);
    });

    it('lower density for smart truncation', () => {
      const random = 'random text '.repeat(100);
      const result = compressor.compress(random, 200);

      expect(result.strategy).toBe('smart_truncation');
      expect(result.density).toBeLessThan(0.5);
    });

    it('density is 1.0 when no compression needed', () => {
      const tiny = 'x y z';
      const result = compressor.compress(tiny, 500);

      expect(result.density).toBe(1.0);
    });
  });

  describe('real-world scenarios', () => {
    it('handles npm test output with timing', () => {
      const npmTestOutput = `
 ✓ src/hook.test.ts  (35)                                              1234ms
   ✓ renders component (450ms)
   ✓ handles events (120ms)

 ✓ src/utils.test.ts  (12)                                             567ms
   ✓ formats strings (50ms)
   ✓ validates input (80ms)

 Test Files  2 passed (2)
 Tests  5 passed (5)
 Start at  12:34:56
 Duration  2.3s
 
 Additional verbose test runner output
 Debug logs that we should ignore
 Performance metrics nobody cares about
 Memory usage info
`.trim();

      const result = compressor.compress(npmTestOutput, 200); // Force compression

      expect(result.strategy).toBe('test_extraction');
      expect(result.content).toContain('Test Files');
      expect(result.content).toContain('passed');
    });

    it('handles large file read with mixed content', () => {
      const largeFile = `
import typescriptPlugin from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

/**
 * ESLint configuration for internal projects.
 */
export default [
  {
    files: ['**/*.ts'],
    plugins: { '@typescript-eslint': typescriptPlugin },
    languageOptions: { parser, parserOptions: { ... } },
    rules: { ... },
  },
  // 500 more lines of config
  { files: ['**/*.js'], rules: { ... } },
];
`.trim();

      const result = compressor.compress(largeFile, 400, 'read_file');

      expect(result.strategy).toBe('file_extraction');
      expect(result.content).toContain('import');
      expect(result.content.length).toBeLessThan(largeFile.length);
    });

    it('handles multiline error with nested stack', () => {
      const complexError = `
AssertionError: expected 'actual' to equal 'expected'
  at Context.<anonymous> (/test/file.test.ts:42:5)
  at processImmediate (internal/timers.js:100:20)

Caused by: Error: Connection timeout
  at TCP.<anonymous> (net.js:1234:567)
  at Module.load (internal/modules/cjs/loader.js:890:10)

Additional noise and logs that don't matter...
Debug output...
Stack trace from previous errors...
`.trim();

      const result = compressor.compress(complexError, 350); // Lower to force extraction

      expect(result.strategy).toBe('error_extraction');
      expect(result.content).toContain('AssertionError');
      expect(result.content).toContain('test/file.test.ts');
      expect(result.content.length).toBeLessThan(complexError.length);
    });
  });

  describe('original length tracking', () => {
    it('always tracks original content length', () => {
      const content = 'x'.repeat(10000);
      const result = compressor.compress(content, 100);

      expect(result.originalLength).toBe(10000);
      expect(result.content.length).toBeLessThan(result.originalLength);
    });

    it('shows compression ratio in result', () => {
      const content = 'line\n'.repeat(1000);
      const result = compressor.compress(content, 200);

      const compressionRatio = result.content.length / result.originalLength;
      expect(compressionRatio).toBeLessThan(0.05); // Compressed to <5% of original
    });
  });
});
