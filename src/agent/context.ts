import type { ChatMessage, ContentBlock, ToolResultContentBlock, ToolUseContentBlock } from '../ollama/types.js';
import { getContentLength } from '../ollama/types.js';
import { SimpleCodeAnalyzer } from '../astContext.js';

/**
 * Prune conversation history between user turns to keep context manageable.
 *
 * Strategy:
 *  1. Always keep the system-level structure (first user message) and the
 *     most recent turn (last user message + trailing assistant/tool messages) intact.
 *  2. For older turns, aggressively compress tool results — these are the
 *     biggest context consumers (file contents, command output, etc.).
 *  3. Strip thinking blocks from older turns — they helped the model reason
 *     but aren't needed for future context.
 *  4. Collapse assistant text in very old turns to a short summary.
 *  5. If still over budget, drop the oldest turn pairs entirely.
 *
 * @param messages  Full conversation history
 * @param maxChars  Target character budget (~4 chars/token). Pass 0 to skip.
 * @returns A new (possibly shorter) message array.
 */
export function pruneHistory(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  if (messages.length <= 2 || maxChars <= 0) return messages;

  // Split conversation into turns.  A "turn" is a user message followed
  // by all assistant/tool-result messages until the next user message.
  const turns = splitIntoTurns(messages);
  if (turns.length <= 1) return messages;

  // Always preserve the last turn fully (the new user prompt).
  // Work backwards from the second-to-last turn applying increasing compression.
  const result = turns.map((turn, i) => {
    if (i === turns.length - 1) return turn; // latest turn — keep intact
    if (i === turns.length - 2) return compressTurn(turn, 'light'); // previous turn — light compression
    if (i === turns.length - 3) return compressTurn(turn, 'medium'); // two turns ago — medium
    return compressTurn(turn, 'heavy'); // older — heavy compression
  });

  // Compute total chars incrementally instead of re-flattening on each drop.
  let totalChars = 0;
  for (const turn of result) {
    for (const m of turn) {
      totalChars += getContentLength(m.content);
    }
  }

  // Drop oldest turns until under budget (skip re-flattening each iteration)
  while (totalChars > maxChars && result.length > 2) {
    const dropped = result.shift()!;
    for (const m of dropped) {
      totalChars -= getContentLength(m.content);
    }
  }

  // Flatten once at the end
  return result.flat();
}

/** A turn is a sequence of messages starting with a user message. */
type Turn = ChatMessage[];

function splitIntoTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn = [];

  for (const msg of messages) {
    // A user message with string content starts a new turn.
    // User messages with tool_result arrays are continuations of the current turn.
    const isNewUserTurn = msg.role === 'user' && typeof msg.content === 'string';
    if (isNewUserTurn && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(msg);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

type CompressionLevel = 'light' | 'medium' | 'heavy';

function compressTurn(turn: Turn, level: CompressionLevel): Turn {
  return turn.map((msg) => compressMessage(msg, level));
}

function compressMessage(msg: ChatMessage, level: CompressionLevel): ChatMessage {
  if (typeof msg.content === 'string') {
    // Plain text user messages — truncate only at heavy level
    if (level === 'heavy' && msg.content.length > 500) {
      return { ...msg, content: msg.content.slice(0, 400) + '\n... (earlier message truncated)' };
    }
    return msg;
  }

  // Content block arrays — compress individual blocks
  const newContent: ContentBlock[] = [];
  for (const block of msg.content) {
    switch (block.type) {
      case 'tool_result':
        newContent.push(compressToolResult(block, level));
        break;
      case 'tool_use':
        newContent.push(compressToolUse(block, level));
        break;
      case 'thinking':
        // Light: keep full thinking. Medium: truncate. Heavy: drop.
        if (level === 'light') {
          newContent.push(block);
        } else if (level === 'medium' && block.thinking.length > 200) {
          newContent.push({ ...block, thinking: block.thinking.slice(0, 150) + '...' });
        }
        // Heavy: omit entirely
        break;
      case 'text':
        newContent.push(compressText(block, level));
        break;
      default:
        newContent.push(block);
    }
  }

  return { ...msg, content: newContent };
}

function compressToolResult(block: ToolResultContentBlock, level: CompressionLevel): ToolResultContentBlock {
  const len = block.content.length;
  switch (level) {
    case 'light':
      // Keep up to 2000 chars — enough for most file reads to be useful
      if (len > 2000) {
        return { ...block, content: block.content.slice(0, 1500) + '\n... (truncated, ' + len + ' chars total)' };
      }
      return block;
    case 'medium':
      // Keep up to 500 chars — just enough for context
      if (len > 500) {
        return { ...block, content: block.content.slice(0, 400) + '\n... (truncated, ' + len + ' chars total)' };
      }
      return block;
    case 'heavy':
      // Keep only a brief summary
      if (len > 150) {
        return { ...block, content: block.content.slice(0, 100) + '... (' + len + ' chars)' };
      }
      return block;
  }
}

function compressToolUse(block: ToolUseContentBlock, level: CompressionLevel): ToolUseContentBlock {
  if (level === 'heavy') {
    // Slim down large inputs (e.g., file write content)
    const inputStr = JSON.stringify(block.input);
    if (inputStr.length > 300) {
      const slim: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(block.input)) {
        if (typeof v === 'string' && v.length > 100) {
          slim[k] = v.slice(0, 80) + '...';
        } else {
          slim[k] = v;
        }
      }
      return { ...block, input: slim };
    }
  }
  return block;
}

function compressText(block: { type: 'text'; text: string }, level: CompressionLevel): { type: 'text'; text: string } {
  if (level === 'heavy' && block.text.length > 800) {
    return { type: 'text', text: block.text.slice(0, 600) + '\n... (earlier response truncated)' };
  }
  if (level === 'medium' && block.text.length > 2000) {
    return { type: 'text', text: block.text.slice(0, 1500) + '\n... (truncated)' };
  }
  return block;
}

/**
 * Enhance context with smart code element selection for better relevance
 */
export function enhanceContextWithSmartElements(context: string, query: string): string {
  // Parse the context to identify code files and their content
  // Extract relevant code elements based on the query using AST analysis
  const fileSections = context.match(/### (.*?)(?=\n### |$)/gs);
  if (!fileSections || fileSections.length === 0) {
    return context;
  }

  const enhancedSections = [];

  for (const section of fileSections) {
    // Extract file path from section header
    const match = section.match(/### (.*?)(?:\s*\(.*?\))?/);
    if (!match) {
      enhancedSections.push(section);
      continue;
    }

    const filePath = match[1];
    const fileContent = section.substring(match[0].length).trim();

    // Skip if it's not a code file
    const codeExtensions = [
      '.js',
      '.ts',
      '.jsx',
      '.tsx',
      '.py',
      '.rs',
      '.go',
      '.java',
      '.cpp',
      '.c',
      '.cs',
      '.kt',
      '.swift',
    ];
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    if (!codeExtensions.includes(ext)) {
      enhancedSections.push(section);
      continue;
    }

    // Strip code fence markers so the parser sees raw source
    const rawContent = fileContent.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '');

    // Try to extract relevant code elements using AST analysis
    let enhancedContent = rawContent;

    try {
      const parsedFile = SimpleCodeAnalyzer.parseFileContent(filePath, rawContent);
      const relevantElements = SimpleCodeAnalyzer.findRelevantElements(parsedFile, query);

      if (relevantElements.length > 0) {
        enhancedContent = SimpleCodeAnalyzer.extractRelevantContent(parsedFile, relevantElements);
      }
    } catch (error) {
      // If AST parsing fails, keep the original content
      console.warn(`Failed to parse ${filePath} for smart context enhancement:`, error);
    }

    // Create enhanced section
    enhancedSections.push(`### ${filePath}\n\`\`\`\n${enhancedContent}\n\`\`\`\n`);
  }

  return enhancedSections.join('');
}
