/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateTests } from './testGenerator.js';
import * as vscode from 'vscode';

vi.mock('vscode');
vi.mock('../ollama/client.js');

import { SideCarClient } from '../ollama/client.js';

const mockWorkspace = vscode.workspace as any;
const mockClient = {
  updateSystemPrompt: vi.fn(),
  complete: vi.fn(),
} as any;

describe('testGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateTests', () => {
    it('generates test code using LLM for TypeScript', async () => {
      mockClient.complete.mockResolvedValue(
        `import { describe, it, expect } from 'vitest';
import { add } from './math';

describe('add', () => {
  it('should sum two numbers', () => {
    expect(add(2, 3)).toBe(5);
  });
});`,
      );

      const result = await generateTests(
        mockClient,
        'export function add(a: number, b: number) { return a + b; }',
        'typescript',
        'math.ts',
      );

      expect(result).not.toBeNull();
      expect(result?.content).toContain('describe');
    });

    it('strips code fences from LLM output', async () => {
      mockClient.complete.mockResolvedValue(
        `\`\`\`typescript
describe('test', () => {
  it('works', () => {
    expect(true).toBe(true);
  });
});
\`\`\``,
      );

      const result = await generateTests(mockClient, 'code', 'typescript', 'file.ts');

      expect(result?.content).not.toContain('```');
      expect(result?.content).toContain('describe');
    });

    it('generates test file name with .test.ts suffix for TypeScript', async () => {
      mockClient.complete.mockResolvedValue('describe("test", () => {});');

      const result = await generateTests(mockClient, 'code', 'typescript', 'utils.ts');

      expect(result?.testFileName).toBe('utils.test.ts');
    });

    it('generates test file name with .test.js suffix for JavaScript', async () => {
      mockClient.complete.mockResolvedValue('describe("test", () => {});');

      const result = await generateTests(mockClient, 'code', 'javascript', 'helpers.js');

      expect(result?.testFileName).toBe('helpers.test.js');
    });

    it('generates test file name with _test.py suffix for Python', async () => {
      mockClient.complete.mockResolvedValue('def test_function():\n    assert True');

      const result = await generateTests(mockClient, 'code', 'python', 'module.py');

      expect(result?.testFileName).toBe('module_test.py');
    });

    it('generates test file name with _test.go suffix for Go', async () => {
      mockClient.complete.mockResolvedValue('func TestFunction(t *testing.T) {}');

      const result = await generateTests(mockClient, 'code', 'go', 'package.go');

      expect(result?.testFileName).toBe('package_test.go');
    });

    it('generates test file name with Test.java suffix for Java', async () => {
      mockClient.complete.mockResolvedValue('@Test public void testFunction() {}');

      const result = await generateTests(mockClient, 'code', 'java', 'MyClass.java');

      expect(result?.testFileName).toBe('MyClassTest.java');
    });

    it('uses TEST_SYSTEM_PROMPT for generation', async () => {
      mockClient.complete.mockResolvedValue('describe("test", () => {});');

      await generateTests(mockClient, 'code', 'typescript', 'file.ts');

      expect(mockClient.updateSystemPrompt).toHaveBeenCalled();
      const prompt = mockClient.updateSystemPrompt.mock.calls[0][0];
      expect(prompt).toContain('test generation');
    });

    it('includes source code in chat message', async () => {
      mockClient.complete.mockResolvedValue('describe("test", () => {});');
      const sourceCode = 'export function myFunc() {}';

      await generateTests(mockClient, sourceCode, 'typescript', 'file.ts');

      expect(mockClient.complete).toHaveBeenCalled();
      const messages = mockClient.complete.mock.calls[0][0];
      expect(messages[0].content).toContain(sourceCode);
    });

    it('includes framework type in message', async () => {
      mockClient.complete.mockResolvedValue('describe("test", () => {});');

      await generateTests(mockClient, 'code', 'typescript', 'file.ts');

      const messages = mockClient.complete.mock.calls[0][0];
      expect(messages[0].content).toContain('vitest');
    });

    it('requests 4096 token budget', async () => {
      mockClient.complete.mockResolvedValue('describe("test", () => {});');

      await generateTests(mockClient, 'code', 'typescript', 'file.ts');

      expect(mockClient.complete).toHaveBeenCalled();
      const tokenBudget = mockClient.complete.mock.calls[0][1];
      expect(tokenBudget).toBe(4096);
    });

    it('returns null on LLM error', async () => {
      mockClient.complete.mockRejectedValue(new Error('LLM failed'));

      const result = await generateTests(mockClient, 'code', 'typescript', 'file.ts');

      expect(result).toBeNull();
    });

    it('handles JavaScript framework detection', async () => {
      mockClient.complete.mockResolvedValue('describe("test", () => {});');

      await generateTests(mockClient, 'code', 'javascript', 'file.js');

      const messages = mockClient.complete.mock.calls[0][0];
      expect(messages[0].content).toContain('jest');
    });

    it('handles Python framework detection', async () => {
      mockClient.complete.mockResolvedValue('def test_x(): pass');

      await generateTests(mockClient, 'code', 'python', 'module.py');

      const messages = mockClient.complete.mock.calls[0][0];
      expect(messages[0].content).toContain('pytest');
    });

    it('preserves file extension information in message', async () => {
      mockClient.complete.mockResolvedValue('describe("test", () => {});');

      await generateTests(mockClient, 'code', 'typescript', 'helpers.ts');

      const messages = mockClient.complete.mock.calls[0][0];
      expect(messages[0].content).toContain('helpers.ts');
    });

    it('returns structured result with content and filename', async () => {
      mockClient.complete.mockResolvedValue('describe("test", () => {});');

      const result = await generateTests(mockClient, 'code', 'typescript', 'file.ts');

      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('testFileName');
      expect(typeof result?.content).toBe('string');
      expect(typeof result?.testFileName).toBe('string');
    });

    it('handles Rust framework', async () => {
      mockClient.complete.mockResolvedValue('#[test] fn test_function() {}');

      const result = await generateTests(mockClient, 'code', 'rust', 'lib.rs');

      expect(result?.testFileName).toBe('lib.rs');
    });

    it('replaces code fence markers correctly', async () => {
      mockClient.complete.mockResolvedValue('```\ndescribe("test", () => {});\n```');

      const result = await generateTests(mockClient, 'code', 'typescript', 'file.ts');

      expect(result?.content).toBe('describe("test", () => {});');
    });
  });
});
