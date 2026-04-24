/**
 * Citation tools (v0.75).
 *
 * insert_citation — fetch a Zotero item by key and return it formatted as
 * APA, MLA, Chicago, BibTeX, or LaTeX. Style is auto-detected from the
 * target file extension when not specified, defaulting to APA.
 *
 * No VS Code imports — keeps this testable without the extension host.
 */

import * as path from 'node:path';
import { getConfig } from '../../config/settings.js';
import { ZoteroClient } from '../../sources/zoteroSource.js';
import type { ZoteroItem, ZoteroCreator } from '../../sources/zoteroSource.js';
import type { RegisteredTool } from './shared.js';

export type CitationStyle = 'apa' | 'mla' | 'chicago' | 'bibtex' | 'latex';

// ---------------------------------------------------------------------------
// Style detection
// ---------------------------------------------------------------------------

export function detectStyle(filePath?: string): CitationStyle {
  if (!filePath) return 'apa';
  switch (path.extname(filePath).toLowerCase()) {
    case '.bib':
      return 'bibtex';
    case '.tex':
    case '.ltx':
      return 'latex';
    default:
      return 'apa';
  }
}

// ---------------------------------------------------------------------------
// Author formatting helpers
// ---------------------------------------------------------------------------

function authorsOnly(creators: ZoteroCreator[]): ZoteroCreator[] {
  return creators.filter((c) => c.creatorType === 'author');
}

function fullName(c: ZoteroCreator): string {
  if (c.name) return c.name;
  return [c.firstName, c.lastName].filter(Boolean).join(' ');
}

/** Last, F. M. — used for APA */
function apaName(c: ZoteroCreator): string {
  if (c.name) return c.name;
  const last = c.lastName ?? '';
  const initials = (c.firstName ?? '')
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + '.')
    .join(' ');
  return initials ? `${last}, ${initials}` : last;
}

/** Last, First — used for MLA/Chicago first author; First Last for subsequent */
function mlaFirstAuthor(c: ZoteroCreator): string {
  if (c.name) return c.name;
  const parts = [c.lastName, c.firstName].filter(Boolean);
  return parts.length === 2 ? `${parts[0]}, ${parts[1]}` : (parts[0] ?? '');
}

/** Generates a BibTeX cite key: FirstAuthorLastnameYear */
export function bibtexKey(item: ZoteroItem): string {
  const authors = authorsOnly(item.data.creators);
  const lastName = authors[0]?.lastName ?? authors[0]?.name?.split(' ').pop() ?? 'Unknown';
  const year = item.data.date ? item.data.date.slice(0, 4) : 'n.d.';
  return `${lastName}${year}`.replace(/[^A-Za-z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatApa(item: ZoteroItem): string {
  const d = item.data;
  const authors = authorsOnly(d.creators);
  const year = d.date ? d.date.slice(0, 4) : 'n.d.';

  let authorStr: string;
  if (authors.length === 0) {
    authorStr = 'Unknown author';
  } else if (authors.length <= 20) {
    const names = authors.map(apaName);
    authorStr = names.length > 1 ? names.slice(0, -1).join(', ') + ', & ' + names[names.length - 1] : names[0];
  } else {
    authorStr = authors.slice(0, 19).map(apaName).join(', ') + ', ... ' + apaName(authors[authors.length - 1]);
  }

  const parts = [`${authorStr} (${year}). ${d.title}.`];
  if (d.publicationTitle) {
    const vol = d.volume ? `, *${d.volume}*` : '';
    const issue = d.issue ? `(${d.issue})` : '';
    const pages = d.pages ? `, ${d.pages}` : '';
    parts.push(`*${d.publicationTitle}*${vol}${issue}${pages}.`);
  }
  if (d.DOI) parts.push(`https://doi.org/${d.DOI}`);
  else if (d.url) parts.push(d.url);

  return parts.join(' ');
}

export function formatMla(item: ZoteroItem): string {
  const d = item.data;
  const authors = authorsOnly(d.creators);
  const year = d.date ? d.date.slice(0, 4) : 'n.d.';

  let authorStr: string;
  if (authors.length === 0) {
    authorStr = '';
  } else if (authors.length === 1) {
    authorStr = mlaFirstAuthor(authors[0]) + '. ';
  } else if (authors.length === 2) {
    authorStr = `${mlaFirstAuthor(authors[0])}, and ${fullName(authors[1])}. `;
  } else {
    authorStr = `${mlaFirstAuthor(authors[0])}, et al. `;
  }

  const parts = [`${authorStr}"${d.title}."`];
  if (d.publicationTitle) {
    const volIssue = [d.volume ? `vol. ${d.volume}` : '', d.issue ? `no. ${d.issue}` : ''].filter(Boolean).join(', ');
    const pages = d.pages ? `pp. ${d.pages}` : '';
    const pubParts = [`*${d.publicationTitle}*`, volIssue, year, pages].filter(Boolean);
    parts.push(pubParts.join(', ') + '.');
  }
  if (d.DOI) parts.push(`doi:${d.DOI}.`);
  else if (d.url) parts.push(d.url + '.');

  return parts.join(' ');
}

export function formatChicago(item: ZoteroItem): string {
  const d = item.data;
  const authors = authorsOnly(d.creators);
  const year = d.date ? d.date.slice(0, 4) : 'n.d.';

  let authorStr: string;
  if (authors.length === 0) {
    authorStr = '';
  } else if (authors.length === 1) {
    authorStr = mlaFirstAuthor(authors[0]) + '. ';
  } else {
    const rest = authors.slice(1).map(fullName).join(', ');
    authorStr = `${mlaFirstAuthor(authors[0])}, and ${rest}. `;
  }

  const parts = [`${authorStr}"${d.title}."`];
  if (d.publicationTitle) {
    const vol = d.volume ?? '';
    const issue = d.issue ? `, no. ${d.issue}` : '';
    const pages = d.pages ? `: ${d.pages}` : '';
    parts.push(`*${d.publicationTitle}* ${vol}${issue} (${year})${pages}.`);
  }
  if (d.DOI) parts.push(`https://doi.org/${d.DOI}.`);
  else if (d.url) parts.push(d.url + '.');

  return parts.join(' ');
}

export function formatBibtex(item: ZoteroItem): string {
  const d = item.data;
  const key = bibtexKey(item);
  const authors = authorsOnly(d.creators)
    .map((c) => {
      if (c.name) return c.name;
      return [c.lastName, c.firstName].filter(Boolean).join(', ');
    })
    .join(' and ');
  const year = d.date ? d.date.slice(0, 4) : '';

  const fields: [string, string | undefined][] = [
    ['author', authors || undefined],
    ['title', d.title || undefined],
    ['journal', d.publicationTitle],
    ['year', year || undefined],
    ['volume', d.volume],
    ['number', d.issue],
    ['pages', d.pages?.replace(/[-–—]+/, '--')],
    ['doi', d.DOI],
    ['url', d.url],
  ];

  const type = d.itemType === 'book' ? 'book' : d.itemType === 'thesis' ? 'phdthesis' : 'article';
  const body = fields
    .filter(([, v]) => v)
    .map(([k, v]) => `  ${k}    = {${v}}`)
    .join(',\n');

  return `@${type}{${key},\n${body}\n}`;
}

export function formatLatex(item: ZoteroItem): string {
  return `\\cite{${bibtexKey(item)}}`;
}

export function formatCitation(item: ZoteroItem, style: CitationStyle): string {
  switch (style) {
    case 'apa':
      return formatApa(item);
    case 'mla':
      return formatMla(item);
    case 'chicago':
      return formatChicago(item);
    case 'bibtex':
      return formatBibtex(item);
    case 'latex':
      return formatLatex(item);
  }
}

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

async function insertCitation(
  input: Record<string, unknown>,
  context?: import('./shared.js').ToolExecutorContext,
): Promise<string> {
  const key = input.key as string;
  if (!key) return 'Error: key is required';

  const rawStyle = (input.style as string | undefined)?.toLowerCase();
  const validStyles: CitationStyle[] = ['apa', 'mla', 'chicago', 'bibtex', 'latex'];
  if (rawStyle && !validStyles.includes(rawStyle as CitationStyle)) {
    return `Error: unknown style "${rawStyle}" — valid values: ${validStyles.join(', ')}`;
  }

  const style: CitationStyle = rawStyle ? (rawStyle as CitationStyle) : detectStyle(input.file as string | undefined);

  const config = context?.config ?? getConfig();
  if (!config.zoteroUserId || !config.zoteroApiKey) {
    return 'Error: Zotero not configured — set sidecar.zotero.userId and sidecar.zotero.apiKey in VS Code settings.';
  }

  const client = new ZoteroClient(config.zoteroUserId, config.zoteroApiKey, config.zoteroBaseUrl);

  let item: ZoteroItem | null;
  try {
    item = await client.getItem(key);
  } catch (err) {
    return `Error: failed to fetch Zotero item — ${String(err)}`;
  }

  if (!item) return `Error: item "${key}" not found in Zotero library`;

  return formatCitation(item, style);
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const citationTools: RegisteredTool[] = [
  {
    definition: {
      name: 'insert_citation',
      description:
        'Format a Zotero library item as a citation in APA, MLA, Chicago, BibTeX, or LaTeX style. ' +
        'Auto-detects style from the target file extension (.bib → BibTeX, .tex → LaTeX, all others → APA). ' +
        'Use after zotero_search to cite a paper. Requires sidecar.zotero.userId and sidecar.zotero.apiKey. ' +
        'Example: `insert_citation(key="ABCD1234", style="apa", file="references.md")`.',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Zotero item key (8-character alphanumeric)' },
          style: {
            type: 'string',
            enum: ['apa', 'mla', 'chicago', 'bibtex', 'latex'],
            description: 'Citation style. Auto-detected from file extension when omitted.',
          },
          file: {
            type: 'string',
            description: 'Target file path — used to auto-detect style from extension when style is not given.',
          },
        },
        required: ['key'],
      },
    },
    executor: insertCitation,
    requiresApproval: false,
  },
];
