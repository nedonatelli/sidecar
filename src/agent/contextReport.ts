import type { ChatMessage } from '../ollama/types.js';
import { getContentText } from '../ollama/types.js';
import { CHARS_PER_TOKEN } from '../config/constants.js';

export interface ContextSection {
  name: string;
  chars: number;
  tokens: number;
}

/**
 * Estimate tokens from character count (~4 chars per token).
 */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Generate a context window visualization report.
 */
export function generateContextReport(
  systemPrompt: string,
  messages: ChatMessage[],
  model: string,
  maxTokens: number,
): string {
  const sections: ContextSection[] = [];

  // Parse system prompt sections
  const sidecarMdMatch = systemPrompt.match(/Project instructions \(from SIDECAR\.md\):\n([\s\S]*?)(?=\n\n|$)/);
  const workspaceMatch = systemPrompt.match(/## Workspace Structure[\s\S]*/);
  // Base prompt (everything before SIDECAR.md or workspace context)
  let baseEnd = systemPrompt.length;
  if (sidecarMdMatch && sidecarMdMatch.index !== undefined) baseEnd = Math.min(baseEnd, sidecarMdMatch.index);
  if (workspaceMatch && workspaceMatch.index !== undefined) baseEnd = Math.min(baseEnd, workspaceMatch.index);
  const basePrompt = systemPrompt.slice(0, baseEnd).trim();
  if (basePrompt) {
    sections.push({ name: 'Base system prompt', chars: basePrompt.length, tokens: estimateTokens(basePrompt.length) });
  }

  if (sidecarMdMatch) {
    const content = sidecarMdMatch[0];
    sections.push({ name: 'SIDECAR.md', chars: content.length, tokens: estimateTokens(content.length) });
  }

  if (workspaceMatch) {
    const content = workspaceMatch[0];
    // Split into tree and files
    const treeEnd = content.indexOf('## Relevant Files');
    if (treeEnd > 0) {
      const tree = content.slice(0, treeEnd);
      const files = content.slice(treeEnd);
      sections.push({ name: 'Workspace tree', chars: tree.length, tokens: estimateTokens(tree.length) });
      sections.push({ name: 'Workspace files', chars: files.length, tokens: estimateTokens(files.length) });
    } else {
      sections.push({ name: 'Workspace context', chars: content.length, tokens: estimateTokens(content.length) });
    }
  }

  // Message history
  let userChars = 0;
  let assistantChars = 0;
  let toolResultChars = 0;
  let userCount = 0;
  let assistantCount = 0;

  for (const msg of messages) {
    const text = getContentText(msg.content);
    if (msg.role === 'user') {
      // Check if it's a tool result (content block array with tool_result type)
      if (Array.isArray(msg.content) && msg.content.some((b) => b.type === 'tool_result')) {
        toolResultChars += text.length;
      } else {
        userChars += text.length;
        userCount++;
      }
    } else {
      assistantChars += text.length;
      assistantCount++;
    }
  }

  if (userChars > 0) {
    sections.push({ name: `User messages (${userCount})`, chars: userChars, tokens: estimateTokens(userChars) });
  }
  if (assistantChars > 0) {
    sections.push({
      name: `Assistant messages (${assistantCount})`,
      chars: assistantChars,
      tokens: estimateTokens(assistantChars),
    });
  }
  if (toolResultChars > 0) {
    sections.push({ name: 'Tool results', chars: toolResultChars, tokens: estimateTokens(toolResultChars) });
  }

  // Totals
  const totalChars = sections.reduce((s, sec) => s + sec.chars, 0);
  const totalTokens = sections.reduce((s, sec) => s + sec.tokens, 0);
  const pctUsed = maxTokens > 0 ? ((totalTokens / maxTokens) * 100).toFixed(1) : '?';

  // Build report
  const lines = [
    '# SideCar Context Window',
    '',
    `**Model:** ${model}`,
    `**Budget:** ~${maxTokens.toLocaleString()} tokens`,
    `**Used:** ~${totalTokens.toLocaleString()} tokens (${pctUsed}%)`,
    '',
    '## Breakdown',
    '',
    '| Section | Chars | Est. Tokens | % of Total |',
    '|---------|-------|-------------|------------|',
  ];

  for (const sec of sections) {
    const pct = totalTokens > 0 ? ((sec.tokens / totalTokens) * 100).toFixed(1) : '0';
    lines.push(`| ${sec.name} | ${sec.chars.toLocaleString()} | ${sec.tokens.toLocaleString()} | ${pct}% |`);
  }

  lines.push(`| **Total** | **${totalChars.toLocaleString()}** | **${totalTokens.toLocaleString()}** | **100%** |`);

  // Visual bar
  lines.push('', '## Usage Bar', '', '```');
  const barWidth = 50;
  const filled = Math.round((totalTokens / maxTokens) * barWidth);
  const bar = '█'.repeat(Math.min(filled, barWidth)) + '░'.repeat(Math.max(0, barWidth - filled));
  lines.push(`[${bar}] ${pctUsed}%`);
  lines.push('```');

  return lines.join('\n');
}
