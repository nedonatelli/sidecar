/**
 * PDF tools (v0.75).
 *
 * read_pdf  — extract and return text from a PDF file (up to 8K chars).
 * index_pdf — chunk a PDF and persist chunks to .sidecar/literature/ for
 *             retrieval by PdfRetriever (Chunk 3).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { PdfSource } from '../../sources/pdfSource.js';
import { getRoot, type RegisteredTool } from './shared.js';
import type { SourceDocument } from '../../sources/types.js';

const MAX_READ_CHARS = 8_000;
const LITERATURE_DIR = '.sidecar/literature';

// ---------------------------------------------------------------------------
// read_pdf
// ---------------------------------------------------------------------------

async function readPdf(input: Record<string, unknown>): Promise<string> {
  const filePath = input.path as string;
  if (!filePath) return 'Error: path is required';

  const resolved = path.isAbsolute(filePath) ? filePath : path.join(getRoot(), filePath);
  const source = new PdfSource();
  if (!source.canHandle(resolved)) return `Error: ${filePath} is not a PDF file`;

  const chunks: SourceDocument[] = [];
  try {
    for await (const doc of source.extract(resolved)) {
      chunks.push(doc);
    }
  } catch (err) {
    return `Error: failed to parse PDF — ${String(err)}`;
  }

  if (chunks.length === 0) return `Error: no content extracted from ${filePath}`;

  const title = chunks[0].title;
  const numpages = (chunks[0].metadata.numpages as number | undefined) ?? '?';
  const fullText = chunks.map((c) => c.content).join('\n\n');
  const truncated = fullText.length > MAX_READ_CHARS;
  const preview = truncated ? fullText.slice(0, MAX_READ_CHARS) : fullText;

  return [
    `# ${title}`,
    `Pages: ${numpages}`,
    '',
    preview,
    ...(truncated
      ? [`\n[Truncated — ${fullText.length} total chars. Use index_pdf to search specific sections.]`]
      : []),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// index_pdf
// ---------------------------------------------------------------------------

async function indexPdf(input: Record<string, unknown>): Promise<string> {
  const filePath = input.path as string;
  if (!filePath) return 'Error: path is required';

  const resolved = path.isAbsolute(filePath) ? filePath : path.join(getRoot(), filePath);

  const source = new PdfSource();
  if (!source.canHandle(resolved)) return `Error: ${filePath} is not a PDF file`;

  const chunks: SourceDocument[] = [];
  try {
    for await (const doc of source.extract(resolved)) {
      chunks.push(doc);
    }
  } catch (err) {
    return `Error: failed to parse PDF — ${String(err)}`;
  }

  // Persist chunks to .sidecar/literature/<hash>.json
  const hash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 12);
  const outDir = path.join(getRoot(), LITERATURE_DIR);
  await fs.mkdir(outDir, { recursive: true });

  const outFile = path.join(outDir, `${hash}.json`);
  const record: LiteratureRecord = {
    uri: resolved,
    basename: path.basename(filePath),
    indexedAt: new Date().toISOString(),
    chunkCount: chunks.length,
    chunks,
  };
  await fs.writeFile(outFile, JSON.stringify(record, null, 2), 'utf8');

  return `Indexed ${chunks.length} chunks from "${path.basename(filePath)}" → .sidecar/literature/${hash}.json`;
}

// ---------------------------------------------------------------------------
// Shared type for the on-disk index format (used by PdfRetriever in Chunk 3)
// ---------------------------------------------------------------------------

export interface LiteratureRecord {
  uri: string;
  basename: string;
  indexedAt: string;
  chunkCount: number;
  chunks: SourceDocument[];
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const pdfTools: RegisteredTool[] = [
  {
    definition: {
      name: 'read_pdf',
      description:
        'Extract and return the text content of a PDF file. ' +
        'Returns up to 8,000 characters. For longer PDFs, use index_pdf first and then search with project_knowledge_search. ' +
        'Accepts a workspace-relative or absolute path ending in .pdf. ' +
        'Example: `read_pdf(path="papers/attention-is-all-you-need.pdf")`.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the PDF file (workspace-relative or absolute)' },
        },
        required: ['path'],
      },
    },
    executor: readPdf,
    requiresApproval: false,
  },
  {
    definition: {
      name: 'index_pdf',
      description:
        'Chunk and index a PDF file into .sidecar/literature/ so its contents can be searched with project_knowledge_search. ' +
        'Run this once per PDF before trying to search it. ' +
        'Accepts a workspace-relative or absolute path ending in .pdf. ' +
        'Example: `index_pdf(path="papers/attention-is-all-you-need.pdf")`.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the PDF file (workspace-relative or absolute)' },
        },
        required: ['path'],
      },
    },
    executor: indexPdf,
    requiresApproval: false,
  },
];
