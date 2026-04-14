import { workspace, Uri } from 'vscode';
import type { ToolDefinition } from '../../ollama/types.js';
import { searchWeb, formatSearchResults, checkInternetConnectivity } from '../webSearch.js';
import { validateFilePath, getRootUri } from './shared.js';

// Knowledge tools: web_search and display_diagram. Grouped because both
// surface "external knowledge" into the chat — one live from the web, the
// other from prebuilt diagrams in repo markdown — and both keep their own
// small state (connectivity-check flag for web_search, parsed-diagram
// index for display_diagram).

export const webSearchDef: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the web via DuckDuckGo and return titles, URLs, and snippets. ' +
    'Use to find current documentation, solutions to error messages, library API references, or any information not in the local codebase. ' +
    'Not for looking things up inside the workspace (use `grep` / `search_files` / `read_file`). ' +
    'Not for exfiltrating secrets: queries that contain credential-shaped substrings (API keys, JWTs, private-key headers) are blocked with an error, because the query becomes part of the URL logged by the search engine. ' +
    'Example: `web_search(query="typescript satisfies operator vs type assertion")`, `web_search(query="node.js AggregateError example")`.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Search query. Keep it specific — a few technical terms works better than a full sentence. Example: "react useEffect cleanup function", "python asyncio timeout".',
      },
    },
    required: ['query'],
  },
};

let internetChecked = false;
let internetAvailable = true;

export async function webSearch(input: Record<string, unknown>): Promise<string> {
  const query = (input.query as string) || '';
  if (!query) return 'Error: search query is required.';

  // Check internet connectivity once per session
  if (!internetChecked) {
    internetChecked = true;
    internetAvailable = await checkInternetConnectivity();
    if (!internetAvailable) {
      return '⚠️ No internet connection detected. Web search is unavailable. Try resolving the issue using local files, documentation, or project context instead.';
    }
  } else if (!internetAvailable) {
    // Retry connectivity on subsequent calls in case connection was restored
    internetAvailable = await checkInternetConnectivity();
    if (!internetAvailable) {
      return '⚠️ Still offline. Web search is unavailable.';
    }
  }

  try {
    const results = await searchWeb(query);
    if (results.length === 0) {
      return `No results found for: "${query}". Try rephrasing the query.`;
    }
    return `Web search results for "${query}":\n\n${formatSearchResults(results)}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
      return '⚠️ Search timed out. The internet connection may be slow or unavailable.';
    }
    return `Search failed: ${msg}`;
  }
}

export const displayDiagramDef: ToolDefinition = {
  name: 'display_diagram',
  description:
    'Extract a diagram code block (mermaid, graphviz, plantuml, dot) from a markdown file and return it for rendering in chat. ' +
    'Use when the user asks "show me the diagram in docs/architecture.md" or when you want to reference an existing diagram while explaining code. ' +
    'Not for generating new diagrams — to draw something new, emit a ```mermaid code block directly in your chat response (SideCar renders it inline). ' +
    'Use `index` to select a specific diagram when a file contains more than one. ' +
    'Example: `display_diagram(path="docs/agent-loop-diagram.md", index=0)`.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative file path to the markdown file containing diagrams',
      },
      index: {
        type: 'number',
        description:
          'Zero-based index of the diagram block when the file contains multiple. Default: 0 (first diagram).',
      },
    },
    required: ['path'],
  },
};

export async function displayDiagram(input: Record<string, unknown>): Promise<string> {
  const filePath = input.path as string;
  const diagramIndex = input.index as number;
  const effectiveIndex = diagramIndex ?? 0;

  const pathError = validateFilePath(filePath);
  if (pathError) return pathError;

  try {
    const fileUri = Uri.joinPath(getRootUri(), filePath);
    const bytes = await workspace.fs.readFile(fileUri);
    const content = Buffer.from(bytes).toString('utf-8');

    // Parse markdown to find diagram blocks
    // This regex looks for code blocks with diagram content (mermaid, graphviz, plantuml, etc)
    const diagramRegex = /```(mermaid|graphviz|plantuml|dot)\n([\s\S]*?)\n```/g;
    const diagrams: { type: string; content: string }[] = [];
    let match;

    while ((match = diagramRegex.exec(content)) !== null) {
      diagrams.push({ type: match[1], content: match[2] });
    }

    if (diagrams.length === 0) {
      return `No diagrams found in ${filePath}`;
    }

    if (effectiveIndex >= diagrams.length) {
      return `Diagram index ${effectiveIndex} out of range. Only ${diagrams.length} diagrams found.`;
    }

    const selectedDiagram = diagrams[effectiveIndex];
    return `Diagram ${effectiveIndex} from ${filePath}:\n\n\`\`\`${selectedDiagram.type}\n${selectedDiagram.content}\n\`\`\``;
  } catch (err) {
    return `Error reading diagram from ${filePath}: ${err instanceof Error ? err.message : 'Unknown error'}`;
  }
}
