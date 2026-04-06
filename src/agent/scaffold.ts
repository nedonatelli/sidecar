import { SideCarClient } from '../ollama/client.js';
import type { ChatMessage } from '../ollama/types.js';

const SCAFFOLD_SYSTEM_PROMPT = `You are a code scaffolding generator. Given a template type and project context, generate production-ready boilerplate code.
- Follow the conventions of the project's language and framework
- Include necessary imports, types, and exports
- Add placeholder comments where the user should fill in logic
- Output ONLY the code. No explanations.`;

const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  component: 'React/Vue/Svelte component with props, state, and basic structure',
  api: 'REST API endpoint with request validation, handler, and error handling',
  test: 'Test suite with setup, teardown, and common test cases',
  model: 'Database model/schema with fields, validation, and common methods',
  cli: 'CLI command with argument parsing, help text, and execution logic',
  hook: 'React custom hook with state management and side effects',
  middleware: 'Express/Koa middleware with request/response handling',
  service: 'Service class with dependency injection and business logic methods',
};

export function getTemplateList(): string {
  const lines = ['Available templates:', ''];
  for (const [name, desc] of Object.entries(TEMPLATE_DESCRIPTIONS)) {
    lines.push(`- **${name}**: ${desc}`);
  }
  return lines.join('\n');
}

export async function generateScaffold(
  client: SideCarClient,
  templateType: string,
  description: string,
  language: string,
): Promise<string | null> {
  const templateDesc = TEMPLATE_DESCRIPTIONS[templateType];
  const prompt = templateDesc
    ? `Generate a ${templateType} (${templateDesc}) in ${language}.\n\nAdditional context: ${description || 'standard implementation'}`
    : `Generate a ${templateType} in ${language}.\n\nDescription: ${description || 'standard implementation'}`;

  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
  client.updateSystemPrompt(SCAFFOLD_SYSTEM_PROMPT);

  try {
    let result = await client.complete(messages, 4096);
    result = result.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
    return result;
  } catch {
    return null;
  }
}
