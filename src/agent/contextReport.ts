import type { ChatMessage } from '../ollama/types.js';
import { getContentText, getContentLength } from '../ollama/types.js';
import { charsToTokens } from '../config/tokenEstimation.js';

export interface ContextSection {
  name: string;
  chars: number;
  tokens: number;
}

function estimateTokens(chars: number): number {
  return charsToTokens(chars);
}

/**
 * A section SideCar appends to the system prompt after the project
 * instructions (see webview/handlers/systemPrompt.ts). An instruction block
 * ends where the next one of these begins, not at its first blank line:
 * SIDECAR.md is Markdown with blank lines and `##` headings of its own, so
 * cutting at a blank line counted only its first paragraph (#227, from #116).
 */
const NEXT_PROMPT_SECTION =
  /\n\n(?:Project instructions \(from |Design system \(from |User instructions:|Visual verification mode:|## (?:Pinned Memory|Team Memory|Workspace Context|Workspace Structure|Session)\b)/;

/**
 * Every `Project instructions (from <source>):` block, named by its source:
 * SIDECAR.md, AGENTS.md, CLAUDE.md, or a sub-folder's SIDECAR.md. Only
 * SIDECAR.md was reported, so AGENTS.md and CLAUDE.md never showed up.
 */
function instructionBlocks(systemPrompt: string): { source: string; start: number; chars: number }[] {
  const blocks: { source: string; start: number; chars: number }[] = [];
  for (const m of systemPrompt.matchAll(/Project instructions \(from ([^)\n]+)\):\n/g)) {
    const start = m.index ?? 0;
    const bodyStart = start + m[0].length;
    const end = systemPrompt.slice(bodyStart).search(NEXT_PROMPT_SECTION);
    const stop = end < 0 ? systemPrompt.length : bodyStart + end;
    blocks.push({ source: m[1], start, chars: stop - start });
  }
  return blocks;
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
  const instructions = instructionBlocks(systemPrompt);
  const workspaceMatch = systemPrompt.match(/## Workspace Structure[\s\S]*/);
  // Base prompt (everything before the project instructions or workspace context)
  let baseEnd = systemPrompt.length;
  if (instructions.length > 0) baseEnd = Math.min(baseEnd, instructions[0].start);
  if (workspaceMatch && workspaceMatch.index !== undefined) baseEnd = Math.min(baseEnd, workspaceMatch.index);
  const basePrompt = systemPrompt.slice(0, baseEnd).trim();
  if (basePrompt) {
    sections.push({ name: 'Base system prompt', chars: basePrompt.length, tokens: estimateTokens(basePrompt.length) });
  }

  for (const block of instructions) {
    sections.push({ name: block.source, chars: block.chars, tokens: estimateTokens(block.chars) });
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
    if (msg.role === 'user') {
      // Check if it's a tool result (content block array with tool_result type)
      if (Array.isArray(msg.content) && msg.content.some((b) => b.type === 'tool_result')) {
        toolResultChars += getContentLength(msg.content);
      } else {
        userChars += getContentText(msg.content).length;
        userCount++;
      }
    } else {
      assistantChars += getContentText(msg.content).length;
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
