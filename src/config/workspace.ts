import { workspace, CancellationToken } from 'vscode';
import * as path from 'path';

export interface WorkspaceFile {
  relativePath: string;
  content: string;
}

const IGNORED_DIRS = '{node_modules,.git,out,dist,.venv,venv,__pycache__,.next}/**';
const MAX_FILE_SIZE = 100 * 1024; // 100KB
const MAX_CONTENT_LENGTH = 10_000; // 10K chars per file

export async function getWorkspaceContext(
  patterns: string[],
  maxFiles: number,
  token?: CancellationToken
): Promise<string> {
  const workspaceFolders = workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return '';
  }

  const files: WorkspaceFile[] = [];
  const rootPath = workspaceFolders[0].uri.fsPath;

  for (const pattern of patterns) {
    if (files.length >= maxFiles) break;
    if (token?.isCancellationRequested) break;

    const uris = await workspace.findFiles(
      pattern,
      IGNORED_DIRS,
      maxFiles - files.length,
      token
    );

    for (const uri of uris) {
      if (files.length >= maxFiles) break;
      if (token?.isCancellationRequested) break;

      try {
        const stat = await workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_SIZE) continue;

        const bytes = await workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString('utf-8');
        const relativePath = path.relative(rootPath, uri.fsPath);

        files.push({
          relativePath,
          content: content.slice(0, MAX_CONTENT_LENGTH),
        });
      } catch {
        // Skip files we can't read
      }
    }
  }

  if (files.length === 0) {
    return '';
  }

  const parts = ['## Workspace Context\n'];
  for (const file of files) {
    parts.push(`\n### ${file.relativePath}\n\`\`\`\n${file.content}\n\`\`\`\n`);
  }

  return parts.join('');
}

export function getWorkspaceEnabled(): boolean {
  return workspace.getConfiguration('ollama').get<boolean>('includeWorkspace', true);
}

export function getFilePatterns(): string[] {
  return workspace.getConfiguration('ollama').get<string[]>('filePatterns', [
    '**/*.ts',
    '**/*.js',
    '**/*.py',
    '**/*.md',
  ]);
}

export function getMaxFiles(): number {
  return workspace.getConfiguration('ollama').get<number>('maxFiles', 10);
}
