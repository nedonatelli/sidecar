import { workspace, Uri } from 'vscode';
import type { ToolDefinition } from '../../ollama/types.js';
import { searchWeb, formatSearchResults, checkInternetConnectivity } from '../webSearch.js';
import { validateFilePath, getRootUri, formatToolError, realPathRefusal, type RegisteredTool } from './shared.js';
import { getConfig } from '../../config/settings.js';

// Knowledge tools: web_search and display_diagram. Grouped because both
// surface "external knowledge" into the chat — one live from the web, the
// other from prebuilt diagrams in repo markdown — and both keep their own
// small state (connectivity-check flag for web_search, parsed-diagram
// index for display_diagram).

export const webSearchDef: ToolDefinition = {
  name: 'web_search',
  nondeterministicOutput: true,
  description:
    'Search the web and return titles, URLs, and snippets. ' +
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

  // Probe what the search will actually use: the configured provider's host,
  // or the user's override (sidecar.webSearch.connectivityCheckUrl).
  const probeCfg = getConfig();
  const probe = () => checkInternetConnectivity(probeCfg.webSearchProvider, probeCfg.webSearchConnectivityCheckUrl);

  // Check internet connectivity once per session
  if (!internetChecked) {
    internetChecked = true;
    internetAvailable = await probe();
    if (!internetAvailable) {
      return '⚠️ No internet connection detected. Web search is unavailable. Try resolving the issue using local files, documentation, or project context instead.';
    }
  } else if (!internetAvailable) {
    // Retry connectivity on subsequent calls in case connection was restored
    internetAvailable = await probe();
    if (!internetAvailable) {
      return '⚠️ Still offline. Web search is unavailable.';
    }
  }

  try {
    const cfg = getConfig();
    const results = await searchWeb(query, cfg.webSearchProvider, cfg.webSearchApiKey);
    if (results.length === 0) {
      return `No results found for: "${query}". Try rephrasing the query.`;
    }
    return `Web search results for "${query}":\n\n${formatSearchResults(results)}`;
  } catch (err) {
    // A provider that REFUSED (bot check, rate limit) used to surface as "No
    // results found... Try rephrasing", and the model rephrased into the block
    // until it gave up. Matched by name, not instanceof, so it survives the
    // module being mocked.
    if (err instanceof Error && err.name === 'SearchProviderBlockedError') {
      const provider = (err as Error & { provider?: string }).provider ?? 'the search provider';
      const alternative =
        provider === 'duckduckgo'
          ? ' The user can switch `sidecar.webSearch.provider` to tavily or brave (with an API key) to avoid this.'
          : '';
      return (
        `⚠️ Web search is blocked right now: ${err.message} This is NOT a lack of results, and rephrasing ` +
        `will not help -- do not call web_search again this turn. Answer from what you already know and tell ` +
        `the user you could not search.${alternative}`
      );
    }
    const msg = formatToolError(err);
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

  const pathError = validateFilePath(filePath) ?? realPathRefusal(getRootUri().fsPath, filePath, 'read');
  if (pathError) throw new Error(pathError);

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

export const knowledgeTools: RegisteredTool[] = [
  { definition: webSearchDef, executor: webSearch, requiresApproval: false },
  { definition: displayDiagramDef, executor: displayDiagram, requiresApproval: false },
];
