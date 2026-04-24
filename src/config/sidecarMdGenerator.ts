import * as path from 'path';
import { workspace, window, Uri } from 'vscode';
import { SideCarClient } from '../ollama/client.js';
import type { ChatMessage } from '../ollama/types.js';
import { getWorkspaceRoot } from './workspace.js';

// ---------------------------------------------------------------------------
// SIDECAR.md generator (v0.82)
//
// Inspects the workspace and asks the active LLM to draft a SIDECAR.md —
// the project-level instruction file SideCar injects into every chat session.
// A good SIDECAR.md tells SideCar where key files live (roadmap, changelog,
// security policy, docs), how to build + test, and which parts of the
// codebase correspond to which features.
//
// The generator follows the same pattern as generateCommitMessage:
//   1. Read workspace context (package.json, README, dir listing, key docs)
//   2. Call client.complete() with a detailed format-spec prompt
//   3. Write SIDECAR.md to the workspace root
//   4. Offer to open it for review
// ---------------------------------------------------------------------------

const CONTEXT_MAX_CHARS = 8_000;
const OUTPUT_MAX_TOKENS = 2_048;

/** Read a file relative to the workspace root. Returns '' on any error. */
async function readWorkspaceFile(root: string, relPath: string): Promise<string> {
  try {
    const uri = Uri.file(path.join(root, relPath));
    const bytes = await workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf-8');
  } catch {
    return '';
  }
}

/** List directory entries one level deep. Returns '' on error. */
async function listDir(root: string, relPath: string): Promise<string> {
  try {
    const uri = Uri.file(path.join(root, relPath));
    const entries = await workspace.fs.readDirectory(uri);
    return entries
      .filter(([name]) => !name.startsWith('.') && name !== 'node_modules')
      .map(([name, type]) => `${name}${type === 2 ? '/' : ''}`)
      .sort()
      .join('\n');
  } catch {
    return '';
  }
}

/** Gather workspace context for the generator prompt. */
async function gatherContext(root: string): Promise<string> {
  const parts: string[] = [];

  // Package metadata
  const pkgRaw = await readWorkspaceFile(root, 'package.json');
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
      const meta = {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        scripts: pkg.scripts,
        main: pkg.main,
      };
      parts.push('## package.json (summary)\n```json\n' + JSON.stringify(meta, null, 2) + '\n```');
    } catch {
      parts.push('## package.json\n' + pkgRaw.slice(0, 1_000));
    }
  }

  // Root-level layout
  const rootListing = await listDir(root, '');
  if (rootListing) parts.push('## Root directory listing\n' + rootListing);

  // Source directory layout (one level deep)
  const srcListing = await listDir(root, 'src');
  if (srcListing) parts.push('## src/ layout\n' + srcListing);

  // README (trimmed — we only need the first ~2 KB for the overview)
  const readme = await readWorkspaceFile(root, 'README.md');
  if (readme) parts.push('## README.md (first 2000 chars)\n' + readme.slice(0, 2_000));

  // CLAUDE.md — if present, it's the gold-standard architecture guide
  const claudeMd = await readWorkspaceFile(root, 'CLAUDE.md');
  if (claudeMd) parts.push('## CLAUDE.md (first 3000 chars)\n' + claudeMd.slice(0, 3_000));

  // Sniff for other notable files at the root
  const notableFiles: string[] = [];
  for (const candidate of ['ROADMAP.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'ARCHITECTURE.md']) {
    try {
      await workspace.fs.stat(Uri.file(path.join(root, candidate)));
      notableFiles.push(candidate);
    } catch {
      // not present
    }
  }
  if (notableFiles.length > 0) {
    parts.push('## Other notable files at root\n' + notableFiles.join('\n'));
  }

  // docs/ listing if present
  const docsListing = await listDir(root, 'docs');
  if (docsListing) parts.push('## docs/ layout\n' + docsListing);

  const combined = parts.join('\n\n');
  return combined.length > CONTEXT_MAX_CHARS ? combined.slice(0, CONTEXT_MAX_CHARS) + '\n... (truncated)' : combined;
}

const FORMAT_SPEC = `
## SIDECAR.md format rules

SIDECAR.md is injected verbatim into every SideCar chat session's system prompt.
Follow these rules exactly:

1. **H1 preamble** — Start with \`# <Project Name>\`, then 1–3 sentences describing
   what the project is and does. This is always included.

2. **H2 sections** — One heading per major topic. Sections without a path sentinel
   are included in every session. Keep them tight — budget counts.

3. **Path-scoped sections** — For sections relevant only to specific files, add
   \`<!-- @paths: glob, glob -->\` on the line immediately below the heading.
   These sections are only injected when the user's active file matches a glob.
   Use \`**\` for any depth, \`*\` for any non-slash segment.
   Example:
   \`\`\`
   ## API Layer
   <!-- @paths: src/api/**, src/routes/** -->
   The API is built with Express...
   \`\`\`

4. **Mandatory sections to include:**
   - **Key Reference Files** — bullet list mapping file names to their purpose
     (roadmap, changelog, security policy, architecture docs, etc.)
   - **Commands** — how to build, test, lint, and run the project (fenced code block)
   - **Architecture Map** — brief directory/module guide, one line per subsystem

5. **Optional scoped sections** — add H2/H3 sections scoped to specific paths for
   subsystem-specific tips (e.g. how the auth layer works, how to add a new tool,
   what patterns tests follow).

6. **Style:** use plain Markdown. No preamble, no commentary, no code fences around
   the whole document. Output ONLY the SIDECAR.md content — nothing else.
`;

export async function generateSidecarMd(client: SideCarClient): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    window.showWarningMessage('No workspace folder open.');
    return;
  }

  const existingPath = path.join(root, 'SIDECAR.md');
  const existingContent = await readWorkspaceFile(root, 'SIDECAR.md');
  if (existingContent) {
    const overwrite = await window.showWarningMessage(
      'SIDECAR.md already exists. Overwrite it?',
      { modal: true },
      'Overwrite',
    );
    if (overwrite !== 'Overwrite') return;
  }

  const context = await gatherContext(root);

  const messages: ChatMessage[] = [
    {
      role: 'user',
      content:
        `Generate a SIDECAR.md file for the project described below.\n` +
        `\n${FORMAT_SPEC}\n` +
        `## Project context\n\n${context}`,
    },
  ];

  client.updateSystemPrompt(
    'You are an expert technical writer generating a SIDECAR.md file for a software project. ' +
      'SIDECAR.md is injected into every AI chat session as persistent project context. ' +
      'Your output must be concise (most sections 3–8 lines), well-structured Markdown, ' +
      'and immediately useful to an AI assistant reading it cold. ' +
      'You never add padding, filler text, or commentary outside the document. ' +
      'Output ONLY the SIDECAR.md content.',
  );

  await window.withProgress(
    { location: { viewId: 'sidecar.chatView' }, title: 'Generating SIDECAR.md...' },
    async () => {
      try {
        let content = await client.complete(messages, OUTPUT_MAX_TOKENS);

        // Strip any code fence the model may have wrapped the output in
        content = content
          .replace(/^```(?:markdown|md)?\n?/, '')
          .replace(/\n?```\s*$/, '')
          .trim();

        const uri = Uri.file(existingPath);
        await workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));

        const action = await window.showInformationMessage(
          'SIDECAR.md generated and saved to your workspace root.',
          'Open File',
        );
        if (action === 'Open File') {
          await workspace.openTextDocument(uri).then((doc) => window.showTextDocument(doc));
        }
      } catch (err) {
        window.showErrorMessage(`Failed to generate SIDECAR.md: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
