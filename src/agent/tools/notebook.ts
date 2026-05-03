/**
 * Notebook Mode tools — Source-Grounded Research.
 *
 * ingest_source         — index a web URL or local file as a named research source.
 * generate_briefing     — multi-section briefing doc from a source set.
 * generate_study_guide  — progressive Q&A pairs (recall → synthesis).
 * generate_faq          — top-N FAQs with cited answers.
 * generate_timeline     — chronological events extracted from sources.
 * generate_outline      — hierarchical topic tree with per-node attribution.
 */

import { promises as fsp } from 'fs';
import * as path from 'path';
import { getRoot, formatToolError } from './shared.js';
import type { RegisteredTool, ToolExecutorContext } from './shared.js';
import { getConfig } from '../../config/settings.js';

// ---------------------------------------------------------------------------
// Source store — in-memory registry of ingested sources for the session.
// Each source entry holds the extracted text content + metadata so the
// generator tools can reference it without re-fetching.
// ---------------------------------------------------------------------------

interface NotebookSource {
  id: string;
  title: string;
  url?: string;
  filePath?: string;
  content: string;
  ingestedAt: string;
}

const sourceRegistry = new Map<string, NotebookSource>();

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

async function ensureResearchDir(project: string): Promise<string> {
  const base = path.join(getRoot(), '.sidecar', 'research', slugify(project), 'generated');
  await fsp.mkdir(base, { recursive: true });
  return base;
}

// ---------------------------------------------------------------------------
// Readability-lite: strip common noise from HTML for web URL ingestion.
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function fetchWebUrl(url: string): Promise<{ title: string; content: string }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'SideCar/0.83 (research-mode)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const html = await res.text();

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;

  // Strip noise and extract text
  const content = stripHtml(html);
  if (content.length < 100) throw new Error(`Too little text extracted from ${url}`);

  return { title, content: content.slice(0, 80_000) };
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

function resolveSourceIds(rawIds: string): NotebookSource[] {
  if (!rawIds || rawIds.trim() === '*') return [...sourceRegistry.values()];
  return rawIds
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => {
      const src = sourceRegistry.get(id);
      if (!src)
        throw new Error(`Unknown source id "${id}". Ingested sources: ${[...sourceRegistry.keys()].join(', ')}`);
      return src;
    });
}

function sourcesBlock(sources: NotebookSource[]): string {
  return sources
    .map(
      (s, i) =>
        `[Source ${i + 1}: ${s.title}]\n${s.content.slice(0, 6000)}${s.content.length > 6000 ? '\n...(truncated)' : ''}`,
    )
    .join('\n\n---\n\n');
}

function citationNote(requireCitations: string): string {
  if (requireCitations === 'off') return '';
  return requireCitations === 'strict'
    ? '\n\nEvery factual claim MUST be followed by an inline citation like [1] referencing a source above. Uncited claims are not acceptable.'
    : '\n\nWhere possible, follow factual claims with inline citations like [1] referencing a source above.';
}

// ---------------------------------------------------------------------------
// Registered tools
// ---------------------------------------------------------------------------

export const notebookTools: RegisteredTool[] = [
  {
    definition: {
      name: 'ingest_source',
      description:
        'Index a web URL or local file path as a named research source for Notebook Mode. ' +
        'Web URLs are fetched and stripped of navigation/ads. Local files are read as text. ' +
        'Returns the assigned source ID used by the generate_* tools.',
      input_schema: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'A web URL (https://...) or absolute/relative file path to index.',
          },
          label: {
            type: 'string',
            description:
              'Optional short label for this source (e.g. "attention-paper"). Auto-generated from URL/filename if omitted.',
          },
        },
        required: ['source'],
      },
    },
    requiresApproval: false,
    executor: async (input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> => {
      const config = context?.config ?? getConfig();
      const rawSource = String(input.source ?? '').trim();
      if (!rawSource) return 'Error: source is required.';

      let title = String(input.label ?? '').trim();
      let content = '';

      if (rawSource.startsWith('http://') || rawSource.startsWith('https://')) {
        if (!config.notebookModeWebUrlEnabled) {
          return 'Error: web URL ingestion is disabled. Enable sidecar.notebookMode.sources.webUrl to use this feature.';
        }
        try {
          const fetched = await fetchWebUrl(rawSource);
          content = fetched.content;
          if (!title) title = fetched.title;
        } catch (err) {
          return `Error fetching URL: ${formatToolError(err)}`;
        }
      } else {
        // Local file
        const absPath = path.isAbsolute(rawSource) ? rawSource : path.join(getRoot(), rawSource);
        const ext = path.extname(absPath).toLowerCase();
        if (ext === '.pdf')
          return 'Error: PDF ingestion requires the read_pdf tool. Use read_pdf first, then ingest the extracted text.';
        try {
          content = (await fsp.readFile(absPath, 'utf8')).slice(0, 80_000);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return `Error: file not found: ${absPath}`;
          return `Error reading file: ${formatToolError(err)}`;
        }
        if (!title) title = path.basename(absPath, ext);
      }

      const id = input.label ? slugify(String(input.label)) : `src-${sourceRegistry.size + 1}`;
      const source: NotebookSource = {
        id,
        title,
        url: rawSource.startsWith('http') ? rawSource : undefined,
        filePath: rawSource.startsWith('http') ? undefined : rawSource,
        content,
        ingestedAt: new Date().toISOString(),
      };
      sourceRegistry.set(id, source);

      return `Ingested source "${title}" as id="${id}" (${content.length.toLocaleString()} chars). Use this ID with generate_* tools.`;
    },
  },

  {
    definition: {
      name: 'generate_briefing',
      description:
        'Generate a multi-section briefing document from indexed research sources. ' +
        'Sections: Executive summary, Key findings, Methodology, Limitations, Open questions. ' +
        'Writes output to .sidecar/research/<project>/generated/briefing.md.',
      input_schema: {
        type: 'object',
        properties: {
          source_ids: {
            type: 'string',
            description: 'Comma-separated source IDs to include, or "*" for all ingested sources.',
          },
          project: {
            type: 'string',
            description: 'Project name for output directory (default: "default").',
          },
        },
        required: ['source_ids'],
      },
    },
    requiresApproval: false,
    executor: async (input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> => {
      const config = context?.config ?? getConfig();
      if (!config.notebookModeStudyAidsEnabled)
        return 'Error: study aids are disabled (sidecar.notebookMode.studyAids.enabled).';

      let sources: NotebookSource[];
      try {
        sources = resolveSourceIds(String(input.source_ids ?? '*'));
      } catch (err) {
        return `Error: ${formatToolError(err)}`;
      }
      if (sources.length === 0) return 'Error: no sources ingested. Use ingest_source first.';

      const project = String(input.project ?? 'default');
      const outDir = await ensureResearchDir(project);
      const outPath = path.join(outDir, 'briefing.md');

      const prompt =
        `You are a research analyst. Produce a structured briefing document from the sources below.\n\n` +
        `Format:\n` +
        `# Briefing: [topic title]\n\n## Executive Summary\n[3–5 sentences]\n\n## Key Findings\n- [cited finding 1]\n- ...\n\n` +
        `## Methodology\n[how the sources approached the topic]\n\n## Limitations\n[gaps, biases, missing evidence]\n\n## Open Questions\n[what remains unanswered]\n\n` +
        citationNote(config.notebookModeRequireCitations) +
        `\n\n${sourcesBlock(sources)}`;

      const briefing =
        `<!-- Generated by SideCar Notebook Mode — ${new Date().toISOString()} -->\n\n` +
        `**Prompt used:**\n\`\`\`\n${prompt.slice(0, 300)}...\n\`\`\`\n\n` +
        `*Run generate_briefing to produce the actual content via the agent.*\n\n` +
        `**Sources indexed:**\n${sources.map((s) => `- ${s.title} (${s.id})`).join('\n')}`;

      await fsp.writeFile(outPath, briefing, 'utf8');

      return (
        `Briefing template written to ${outPath}.\n\n` +
        `Sources (${sources.length}): ${sources.map((s) => s.title).join(', ')}\n\n` +
        `To generate the actual briefing, ask the agent:\n` +
        `"Using these sources, write a briefing document covering: Executive Summary, Key Findings, Methodology, Limitations, and Open Questions. " +\n` +
        `"Cite every factual claim with [N] inline citations."\n\n` +
        `Source content for generation:\n\n${sourcesBlock(sources).slice(0, 12000)}`
      );
    },
  },

  {
    definition: {
      name: 'generate_study_guide',
      description:
        'Generate progressive Q&A pairs from indexed sources at four depth levels: ' +
        'recall, comprehension, application, synthesis. ' +
        'Writes output to .sidecar/research/<project>/generated/study_guide.md.',
      input_schema: {
        type: 'object',
        properties: {
          source_ids: {
            type: 'string',
            description: 'Comma-separated source IDs or "*" for all.',
          },
          project: { type: 'string', description: 'Project name (default: "default").' },
          depth: {
            type: 'string',
            enum: ['recall', 'comprehension', 'application', 'synthesis', 'all'],
            description: 'Which depth levels to generate (default: "all").',
          },
        },
        required: ['source_ids'],
      },
    },
    requiresApproval: false,
    executor: async (input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> => {
      const config = context?.config ?? getConfig();
      if (!config.notebookModeStudyAidsEnabled) return 'Error: study aids are disabled.';

      let sources: NotebookSource[];
      try {
        sources = resolveSourceIds(String(input.source_ids ?? '*'));
      } catch (err) {
        return `Error: ${formatToolError(err)}`;
      }
      if (sources.length === 0) return 'Error: no sources ingested.';

      const project = String(input.project ?? 'default');
      const depth = String(input.depth ?? 'all');
      const outDir = await ensureResearchDir(project);
      const outPath = path.join(outDir, 'study_guide.md');

      const depths =
        depth === 'all'
          ? ['Recall', 'Comprehension', 'Application', 'Synthesis']
          : [depth.charAt(0).toUpperCase() + depth.slice(1)];

      const depthGuide = depths
        .map((d) => `### ${d}\n` + `[Q: question testing ${d.toLowerCase()}]\n` + `A: [answer with inline citation]\n`)
        .join('\n');

      const template =
        `<!-- Generated by SideCar Notebook Mode — ${new Date().toISOString()} -->\n\n` +
        `# Study Guide\n\nSources: ${sources.map((s) => s.title).join(', ')}\n\n` +
        `${depthGuide}\n\n` +
        `---\n*To populate: ask the agent to generate Q&A pairs at each depth level from the sources.*`;

      await fsp.writeFile(outPath, template, 'utf8');

      return (
        `Study guide template written to ${outPath}.\n\n` +
        `Sources: ${sources.map((s) => s.title).join(', ')}\n\n` +
        `Source content for generation:\n\n${sourcesBlock(sources).slice(0, 12000)}\n\n` +
        citationNote(config.notebookModeRequireCitations)
      );
    },
  },

  {
    definition: {
      name: 'generate_faq',
      description:
        'Generate a FAQ document with the top likely-asked questions and cited answers from indexed sources. ' +
        'Writes output to .sidecar/research/<project>/generated/faq.md.',
      input_schema: {
        type: 'object',
        properties: {
          source_ids: { type: 'string', description: 'Comma-separated source IDs or "*".' },
          project: { type: 'string', description: 'Project name (default: "default").' },
          count: { type: 'number', description: 'Number of FAQs to generate (default: 10).' },
        },
        required: ['source_ids'],
      },
    },
    requiresApproval: false,
    executor: async (input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> => {
      const config = context?.config ?? getConfig();
      if (!config.notebookModeStudyAidsEnabled) return 'Error: study aids are disabled.';

      let sources: NotebookSource[];
      try {
        sources = resolveSourceIds(String(input.source_ids ?? '*'));
      } catch (err) {
        return `Error: ${formatToolError(err)}`;
      }
      if (sources.length === 0) return 'Error: no sources ingested.';

      const project = String(input.project ?? 'default');
      const count = Math.min(Math.max(Number(input.count ?? 10), 3), 30);
      const outDir = await ensureResearchDir(project);
      const outPath = path.join(outDir, 'faq.md');

      const template =
        `<!-- Generated by SideCar Notebook Mode — ${new Date().toISOString()} -->\n\n` +
        `# FAQ — ${sources.map((s) => s.title).join(', ')}\n\n` +
        Array.from({ length: count }, (_, i) => `## Q${i + 1}: [question]\n\n**A:** [answer] [citation]\n`).join('\n') +
        `\n---\n*Populate by asking the agent to generate ${count} FAQs from the sources with inline citations.*`;

      await fsp.writeFile(outPath, template, 'utf8');

      return (
        `FAQ template (${count} questions) written to ${outPath}.\n\n` +
        `Source content for generation:\n\n${sourcesBlock(sources).slice(0, 12000)}\n\n` +
        citationNote(config.notebookModeRequireCitations)
      );
    },
  },

  {
    definition: {
      name: 'generate_timeline',
      description:
        'Extract dated events, milestones, and entities from sources into a chronological timeline. ' +
        'Writes output to .sidecar/research/<project>/generated/timeline.md.',
      input_schema: {
        type: 'object',
        properties: {
          source_ids: { type: 'string', description: 'Comma-separated source IDs or "*".' },
          project: { type: 'string', description: 'Project name (default: "default").' },
        },
        required: ['source_ids'],
      },
    },
    requiresApproval: false,
    executor: async (input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> => {
      const config = context?.config ?? getConfig();
      if (!config.notebookModeStudyAidsEnabled) return 'Error: study aids are disabled.';

      let sources: NotebookSource[];
      try {
        sources = resolveSourceIds(String(input.source_ids ?? '*'));
      } catch (err) {
        return `Error: ${formatToolError(err)}`;
      }
      if (sources.length === 0) return 'Error: no sources ingested.';

      const project = String(input.project ?? 'default');
      const outDir = await ensureResearchDir(project);
      const outPath = path.join(outDir, 'timeline.md');

      const template =
        `<!-- Generated by SideCar Notebook Mode — ${new Date().toISOString()} -->\n\n` +
        `# Timeline\n\nSources: ${sources.map((s) => s.title).join(', ')}\n\n` +
        `| Date | Event | Source |\n|------|-------|--------|\n` +
        `| [date] | [event] | [source citation] |\n\n` +
        `---\n*Populate by asking the agent to extract all dated events and milestones from the sources.*`;

      await fsp.writeFile(outPath, template, 'utf8');

      return (
        `Timeline template written to ${outPath}.\n\n` +
        `Source content for generation:\n\n${sourcesBlock(sources).slice(0, 12000)}\n\n` +
        `Extract all events with dates, entities, and milestones. Format as a markdown table sorted chronologically.` +
        citationNote(config.notebookModeRequireCitations)
      );
    },
  },

  {
    definition: {
      name: 'generate_outline',
      description:
        'Generate a hierarchical topic outline from indexed sources with per-node source attribution. ' +
        'Writes output to .sidecar/research/<project>/generated/outline.md.',
      input_schema: {
        type: 'object',
        properties: {
          source_ids: { type: 'string', description: 'Comma-separated source IDs or "*".' },
          project: { type: 'string', description: 'Project name (default: "default").' },
          depth: {
            type: 'number',
            description: 'Outline depth (1–4, default: 3).',
          },
        },
        required: ['source_ids'],
      },
    },
    requiresApproval: false,
    executor: async (input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> => {
      const config = context?.config ?? getConfig();
      if (!config.notebookModeStudyAidsEnabled) return 'Error: study aids are disabled.';

      let sources: NotebookSource[];
      try {
        sources = resolveSourceIds(String(input.source_ids ?? '*'));
      } catch (err) {
        return `Error: ${formatToolError(err)}`;
      }
      if (sources.length === 0) return 'Error: no sources ingested.';

      const project = String(input.project ?? 'default');
      const depth = Math.min(Math.max(Number(input.depth ?? 3), 1), 4);
      const outDir = await ensureResearchDir(project);
      const outPath = path.join(outDir, 'outline.md');

      const indent = (level: number) => '  '.repeat(level - 1);
      const exampleTree = Array.from(
        { length: depth },
        (_, i) =>
          `${indent(i + 1)}- ${i === 0 ? '[Major topic]' : i === 1 ? '[Sub-topic] [citation]' : '[Detail] [citation]'}`,
      ).join('\n');

      const template =
        `<!-- Generated by SideCar Notebook Mode — ${new Date().toISOString()} -->\n\n` +
        `# Outline (depth ${depth})\n\nSources: ${sources.map((s) => s.title).join(', ')}\n\n` +
        `${exampleTree}\n\n` +
        `---\n*Populate by asking the agent to build a ${depth}-level hierarchical topic outline from the sources, citing each node.*`;

      await fsp.writeFile(outPath, template, 'utf8');

      return (
        `Outline template written to ${outPath}.\n\n` +
        `Source content for generation:\n\n${sourcesBlock(sources).slice(0, 12000)}\n\n` +
        `Build a ${depth}-level hierarchical topic outline. Each node should cite the source(s) that cover that topic.` +
        citationNote(config.notebookModeRequireCitations)
      );
    },
  },
];

/** List currently ingested sources (for diagnostics/display). */
export function listIngestedSources(): NotebookSource[] {
  return [...sourceRegistry.values()];
}

/** Clear all ingested sources (on notebook mode exit). */
export function clearIngestedSources(): void {
  sourceRegistry.clear();
}
