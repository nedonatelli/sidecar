import { workspace, Uri } from 'vscode';
import { SideCarClient } from '../ollama/client.js';
import type { ChatMessage } from '../ollama/types.js';

const TEST_SYSTEM_PROMPT = `You are a test generation expert. Given source code, generate comprehensive tests:
- Detect the language and appropriate test framework (Vitest/Jest for TS/JS, pytest for Python, Go test for Go, etc.)
- Generate tests that cover: happy paths, edge cases, error handling, boundary conditions
- Use descriptive test names that explain what is being tested
- Include setup/teardown where appropriate
- Mock external dependencies
- Output ONLY the test code. No explanations.`;

/**
 * Detect the test framework and file naming convention for a given language.
 */
async function detectTestFramework(language: string): Promise<{ framework: string; suffix: string }> {
  if (['typescript', 'typescriptreact'].includes(language)) {
    // Check for vitest vs jest
    try {
      const pkgBytes = await workspace.fs.readFile(Uri.joinPath(workspace.workspaceFolders![0].uri, 'package.json'));
      const pkg = JSON.parse(Buffer.from(pkgBytes).toString('utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.vitest) return { framework: 'vitest', suffix: '.test.ts' };
      if (deps.jest) return { framework: 'jest', suffix: '.test.ts' };
    } catch {
      // no package.json
    }
    return { framework: 'vitest', suffix: '.test.ts' };
  }
  if (['javascript', 'javascriptreact'].includes(language)) {
    return { framework: 'jest', suffix: '.test.js' };
  }
  if (language === 'python') return { framework: 'pytest', suffix: '_test.py' };
  if (language === 'go') return { framework: 'go test', suffix: '_test.go' };
  if (language === 'rust') return { framework: 'cargo test', suffix: '.rs' };
  if (language === 'java') return { framework: 'junit', suffix: 'Test.java' };
  return { framework: 'unknown', suffix: '.test.txt' };
}

export async function generateTests(
  client: SideCarClient,
  code: string,
  language: string,
  fileName: string,
): Promise<{ content: string; testFileName: string } | null> {
  const { framework, suffix } = await detectTestFramework(language);

  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: `Generate ${framework} tests for this ${language} code from ${fileName}:\n\n\`\`\`${language}\n${code}\n\`\`\`\n\nUse the ${framework} framework. Import from the source file using relative paths.`,
    },
  ];

  client.updateSystemPrompt(TEST_SYSTEM_PROMPT);

  try {
    let result = await client.complete(messages, 4096);
    result = result.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');

    // Compute test file name
    const baseName = fileName.replace(/\.\w+$/, '');
    const testFileName = baseName + suffix;

    return { content: result, testFileName };
  } catch {
    return null;
  }
}
