/**
 * Zotero tools (v0.75).
 *
 * zotero_search    — search the user's Zotero library by keyword.
 * zotero_get_item  — retrieve full bibliographic details for one item by key.
 *
 * Both tools require sidecar.zotero.userId + sidecar.zotero.apiKey to be set.
 */

import { getConfig } from '../../config/settings.js';
import { ZoteroClient, formatCreators } from '../../sources/zoteroSource.js';
import type { ZoteroItem } from '../../sources/zoteroSource.js';
import type { RegisteredTool } from './shared.js';

// ---------------------------------------------------------------------------
// zotero_search
// ---------------------------------------------------------------------------

async function zoteroSearch(
  input: Record<string, unknown>,
  context?: import('./shared.js').ToolExecutorContext,
): Promise<string> {
  const query = input.query as string;
  if (!query) return 'Error: query is required';

  const config = context?.config ?? getConfig();
  if (!config.zoteroUserId || !config.zoteroApiKey) {
    return 'Error: Zotero not configured — set sidecar.zotero.userId and sidecar.zotero.apiKey in VS Code settings.';
  }

  const limit = typeof input.limit === 'number' ? Math.min(Math.max(1, input.limit), 25) : 10;
  const client = new ZoteroClient(config.zoteroUserId, config.zoteroApiKey, config.zoteroBaseUrl);

  let items: ZoteroItem[];
  try {
    items = await client.search(query, limit);
  } catch (err) {
    return `Error: failed to search Zotero — ${String(err)}`;
  }

  if (items.length === 0) return `No items found in Zotero for query: "${query}"`;

  const lines = items.map((item, i) => {
    const d = item.data;
    const authors = formatCreators(d.creators);
    const year = d.date ? d.date.slice(0, 4) : '';
    const snippet = d.abstractNote ? d.abstractNote.slice(0, 150).replace(/\n/g, ' ') + '…' : '(no abstract)';
    return `${i + 1}. **${d.title}** [key: ${item.key}]\n   ${authors}${year ? ` (${year})` : ''}\n   ${snippet}`;
  });

  return `Found ${items.length} item(s) for "${query}":\n\n${lines.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// zotero_get_item
// ---------------------------------------------------------------------------

async function zoteroGetItem(
  input: Record<string, unknown>,
  context?: import('./shared.js').ToolExecutorContext,
): Promise<string> {
  const key = input.key as string;
  if (!key) return 'Error: key is required';

  const config = context?.config ?? getConfig();
  if (!config.zoteroUserId || !config.zoteroApiKey) {
    return 'Error: Zotero not configured — set sidecar.zotero.userId and sidecar.zotero.apiKey in VS Code settings.';
  }

  const client = new ZoteroClient(config.zoteroUserId, config.zoteroApiKey, config.zoteroBaseUrl);

  let item: ZoteroItem | null;
  try {
    item = await client.getItem(key);
  } catch (err) {
    return `Error: failed to get Zotero item — ${String(err)}`;
  }

  if (!item) return `Error: item "${key}" not found in Zotero library`;

  const d = item.data;
  const authors = formatCreators(d.creators);
  const year = d.date ? d.date.slice(0, 4) : '';
  const tags = d.tags.map((t) => t.tag).join(', ');

  return [
    `# ${d.title || '(untitled)'}`,
    `**Key:** ${item.key}`,
    `**Type:** ${d.itemType}`,
    authors ? `**Authors:** ${authors}` : null,
    year ? `**Year:** ${year}` : null,
    d.publicationTitle ? `**Publication:** ${d.publicationTitle}` : null,
    d.volume || d.issue ? `**Volume/Issue:** ${[d.volume, d.issue].filter(Boolean).join('/')}` : null,
    d.pages ? `**Pages:** ${d.pages}` : null,
    d.DOI ? `**DOI:** ${d.DOI}` : null,
    d.url ? `**URL:** ${d.url}` : null,
    tags ? `**Tags:** ${tags}` : null,
    '',
    '## Abstract',
    d.abstractNote || '(no abstract)',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const zoteroTools: RegisteredTool[] = [
  {
    definition: {
      name: 'zotero_search',
      description:
        "Search the user's Zotero reference library by keyword. Returns a ranked list of matching items with " +
        'title, authors, year, and an abstract snippet. Use this to find papers on a topic before reading or ' +
        'citing them. Requires sidecar.zotero.userId and sidecar.zotero.apiKey to be set. ' +
        'Example: `zotero_search(query="attention mechanism transformer", limit=5)`.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword search query' },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (1–25, default 10)',
          },
        },
        required: ['query'],
      },
    },
    executor: zoteroSearch,
    requiresApproval: false,
  },
  {
    definition: {
      name: 'zotero_get_item',
      description:
        'Retrieve full bibliographic details for a single Zotero library item by its item key. Returns the ' +
        'title, authors, year, publication, DOI, URL, tags, and full abstract. Use after zotero_search to get ' +
        'the complete record for a specific item. Requires sidecar.zotero.userId and sidecar.zotero.apiKey. ' +
        'Example: `zotero_get_item(key="ABCD1234")`.',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Zotero item key (8-character alphanumeric, e.g. "ABCD1234")' },
        },
        required: ['key'],
      },
    },
    executor: zoteroGetItem,
    requiresApproval: false,
  },
];
