import { window } from 'vscode';
import { SideCarClient } from '../ollama/client.js';
import type { ChatMessage } from '../ollama/types.js';

const DOC_SYSTEM_PROMPT = `You are a documentation generator. Given code, generate clear documentation:
- For functions/methods: JSDoc/docstring with @param, @returns, @throws, description
- For classes: class-level doc + method docs
- For modules/files: module overview + exports summary
Output ONLY the documented code (original code with docs added). No explanations.`;

export async function generateDocumentation(
  client: SideCarClient,
  code: string,
  language: string,
  fileName: string,
): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: `Add documentation to this ${language} code from ${fileName}:\n\n\`\`\`${language}\n${code}\n\`\`\``,
    },
  ];

  client.updateSystemPrompt(DOC_SYSTEM_PROMPT);

  try {
    let result = await client.complete(messages, 4096);
    // Strip code fence wrapper if present
    result = result.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
    return result;
  } catch (err) {
    window.showErrorMessage(`Documentation generation failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
