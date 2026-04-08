import { window, workspace, Uri } from 'vscode';
import { SideCarClient } from '../ollama/client.js';
import type { ChatMessage } from '../ollama/types.js';
import { getWorkspaceRoot } from '../config/workspace.js';
import type { SidecarDir } from '../config/sidecarDir.js';

const SPEC_SYSTEM_PROMPT = `You are a software architect. When given a feature request, generate a structured specification with these sections:

## Requirements
Use EARS (Easy Approach to Requirements Syntax) notation. Each requirement should have:
- ID (REQ-001, REQ-002, etc.)
- Description in EARS format ("When [trigger], the [system] shall [action]")
- Acceptance criteria as a checklist

## Design
- Architecture overview
- Components/modules involved
- Data flow
- Key interfaces and types
- Dependencies

## Tasks
Ordered by dependency. Each task should have:
- ID (TASK-001, TASK-002, etc.)
- Description
- Which requirement(s) it fulfills (e.g. REQ-001)
- Estimated complexity (S/M/L)
- Files to create or modify

Output ONLY the specification in markdown. Be thorough but concise.`;

export async function generateSpec(client: SideCarClient, featureDescription: string): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: `Generate a specification for this feature:\n\n${featureDescription}`,
    },
  ];

  client.updateSystemPrompt(SPEC_SYSTEM_PROMPT);

  try {
    return await client.complete(messages, 4096);
  } catch (err) {
    window.showErrorMessage(`Spec generation failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function saveSpec(spec: string, name: string, sidecarDir?: SidecarDir | null): Promise<void> {
  const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();

  if (sidecarDir?.isReady()) {
    await sidecarDir.writeText(`specs/${safeName}.md`, spec);
    const doc = await workspace.openTextDocument(sidecarDir.getUri('specs', `${safeName}.md`));
    await window.showTextDocument(doc, { preview: true });
    return;
  }

  // Fallback: write to .sidecar/specs/ using raw paths
  const root = getWorkspaceRoot();
  if (!root) return;

  const specsDir = Uri.joinPath(Uri.file(root), '.sidecar', 'specs');
  try {
    await workspace.fs.createDirectory(specsDir);
  } catch {
    // Already exists
  }

  const specUri = Uri.joinPath(specsDir, `${safeName}.md`);
  await workspace.fs.writeFile(specUri, Buffer.from(spec, 'utf-8'));

  const doc = await workspace.openTextDocument(specUri);
  await window.showTextDocument(doc, { preview: true });
}
