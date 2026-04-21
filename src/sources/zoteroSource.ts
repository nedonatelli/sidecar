/**
 * ZoteroSource (v0.75).
 *
 * Extracts abstract + bibliographic metadata from Zotero library items via
 * the Zotero Web API (api.zotero.org). Handles `zotero://<itemKey>` URIs and
 * emits one `SourceDocument` per item (abstracts don't chunk — they're short).
 *
 * Auth: Zotero-API-Key header. Credentials come from SideCarConfig.
 * No VS Code imports — keeps this testable without the extension host.
 */

import type { Source, SourceDocument } from './types.js';

// ---------------------------------------------------------------------------
// Zotero API types
// ---------------------------------------------------------------------------

export interface ZoteroCreator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  /** Institutional authors use `name` instead of first/last. */
  name?: string;
}

export interface ZoteroItemData {
  key: string;
  itemType: string;
  title: string;
  creators: ZoteroCreator[];
  abstractNote: string;
  publicationTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  date?: string;
  DOI?: string;
  url?: string;
  tags: Array<{ tag: string }>;
}

export interface ZoteroItem {
  key: string;
  data: ZoteroItemData;
}

// ---------------------------------------------------------------------------
// ZoteroClient
// ---------------------------------------------------------------------------

export class ZoteroClient {
  constructor(
    private userId: string,
    private apiKey: string,
    private baseUrl: string = 'https://api.zotero.org',
  ) {}

  async search(query: string, limit = 10, signal?: AbortSignal): Promise<ZoteroItem[]> {
    const url = `${this.baseUrl}/users/${this.userId}/items?q=${encodeURIComponent(query)}&limit=${limit}&format=json`;
    const resp = await fetch(url, { headers: this._headers(), signal });
    if (!resp.ok) throw new Error(`Zotero API ${resp.status}: ${resp.statusText}`);
    return (await resp.json()) as ZoteroItem[];
  }

  async getItem(key: string, signal?: AbortSignal): Promise<ZoteroItem | null> {
    const url = `${this.baseUrl}/users/${this.userId}/items/${key}?format=json`;
    const resp = await fetch(url, { headers: this._headers(), signal });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`Zotero API ${resp.status}: ${resp.statusText}`);
    return (await resp.json()) as ZoteroItem;
  }

  private _headers(): Record<string, string> {
    return { 'Zotero-API-Key': this.apiKey, 'Zotero-API-Version': '3' };
  }
}

// ---------------------------------------------------------------------------
// Helpers shared by Source + tool formatters
// ---------------------------------------------------------------------------

export function formatCreators(creators: ZoteroCreator[]): string {
  return creators
    .filter((c) => c.creatorType === 'author')
    .map((c) => {
      if (c.name) return c.name;
      const parts = [c.lastName, c.firstName].filter(Boolean);
      return parts.length === 2 ? `${parts[0]}, ${parts[1]}` : (parts[0] ?? '');
    })
    .filter(Boolean)
    .join('; ');
}

export function itemToDocument(item: ZoteroItem): SourceDocument {
  const d = item.data;
  const authors = formatCreators(d.creators);
  const year = d.date ? d.date.slice(0, 4) : '';
  const citation = [authors, year, d.publicationTitle].filter(Boolean).join('. ');
  const content = [d.abstractNote || '(no abstract)', citation ? `\n_Citation: ${citation}_` : ''].join('').trim();

  return {
    id: `zotero:${item.key}`,
    title: d.title || '(untitled)',
    content,
    metadata: {
      itemType: d.itemType,
      authors,
      year,
      publicationTitle: d.publicationTitle ?? '',
      doi: d.DOI ?? '',
      url: d.url ?? '',
      tags: d.tags.map((t) => t.tag),
      key: item.key,
    },
    sourceType: 'zotero',
    uri: `zotero://${item.key}`,
    chunkIndex: 0,
  };
}

// ---------------------------------------------------------------------------
// ZoteroSource
// ---------------------------------------------------------------------------

export class ZoteroSource implements Source {
  readonly sourceType = 'zotero' as const;

  constructor(private client: ZoteroClient) {}

  canHandle(uri: string): boolean {
    return uri.startsWith('zotero://');
  }

  async *extract(uri: string, signal?: AbortSignal): AsyncGenerator<SourceDocument> {
    const key = uri.slice('zotero://'.length);
    if (!key) return;
    const item = await this.client.getItem(key, signal);
    if (signal?.aborted) return;
    if (item) yield itemToDocument(item);
  }
}
