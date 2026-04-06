import { workspace, commands, Uri, CancellationToken, SymbolInformation } from 'vscode';
import * as path from 'path';

export interface WorkspaceFile {
  relativePath: string;
  content: string;
}

const MAX_FILE_SIZE = 100 * 1024; // 100KB
const MAX_CONTENT_LENGTH = 10_000; // 10K chars per file

export async function getWorkspaceContext(
  patterns: string[],
  maxFiles: number,
  token?: CancellationToken,
): Promise<string> {
  const workspaceFolders = workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return 'NO_WORKSPACE';
  }

  const files: WorkspaceFile[] = [];
  const rootPath = workspaceFolders[0].uri.fsPath;
  for (const pattern of patterns) {
    if (files.length >= maxFiles) break;
    if (token?.isCancellationRequested) break;

    const uris = await workspace.findFiles(
      pattern,
      `**/{node_modules,.git,out,dist,.venv,venv,__pycache__,.next}/**`,
      maxFiles - files.length,
      token,
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

  const parts = [`## Workspace Context\n`];
  for (const file of files) {
    parts.push(`\n### ${file.relativePath}\n\`\`\`\n${file.content}\n\`\`\`\n`);
  }

  return parts.join('');
}

export function getWorkspaceRoot(): string {
  const workspaceFolders = workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) return '';
  return workspaceFolders[0].uri.fsPath;
}

export function getWorkspaceEnabled(): boolean {
  return workspace.getConfiguration('sidecar').get<boolean>('includeWorkspace', true);
}

export function getFilePatterns(): string[] {
  return workspace
    .getConfiguration('sidecar')
    .get<
      string[]
    >('filePatterns', ['**/*.ts', '**/*.js', '**/*.py', '**/*.md', '**/*.kt', '**/*.java', '**/*.swift', '**/*.go', '**/*.rs', '**/*.c', '**/*.cpp', '**/*.h', '**/*.rb', '**/*.php', '**/*.cs', '**/*.json', '**/*.yaml', '**/*.yml', '**/*.toml', '**/*.gradle.kts', '**/*.gradle', '**/*.html', '**/*.css', '**/*.scss', '**/*.sh', '**/*.sql']);
}

export function getMaxFiles(): number {
  return workspace.getConfiguration('sidecar').get<number>('maxFiles', 10);
}

export async function resolveAtReferences(text: string): Promise<string> {
  const workspaceFolders = workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) return text;

  const root = workspaceFolders[0].uri;
  let result = text;
  const attachments: string[] = [];

  // @file:path — include file content
  const fileRefs = text.matchAll(/@file:([^\s]+)/g);
  for (const match of fileRefs) {
    const filePath = match[1];
    try {
      const fileUri = Uri.joinPath(root, filePath);
      const bytes = await workspace.fs.readFile(fileUri);
      const content = Buffer.from(bytes).toString('utf-8').slice(0, MAX_CONTENT_LENGTH);
      attachments.push(`### @file:${filePath}\n\`\`\`\n${content}\n\`\`\``);
    } catch {
      /* file not found */
    }
  }

  // @folder:path — list folder contents
  const folderRefs = text.matchAll(/@folder:([^\s]+)/g);
  for (const match of folderRefs) {
    const folderPath = match[1];
    try {
      const folderUri = Uri.joinPath(root, folderPath);
      const entries = await workspace.fs.readDirectory(folderUri);
      const listing = entries.map(([name, type]) => `${type === 2 ? '📁 ' : '📄 '}${name}`).join('\n');
      attachments.push(`### @folder:${folderPath}\n\`\`\`\n${listing}\n\`\`\``);
    } catch {
      /* folder not found */
    }
  }

  // @symbol:name — search for symbol in workspace
  const symbolRefs = text.matchAll(/@symbol:([^\s]+)/g);
  for (const match of symbolRefs) {
    const symbolName = match[1];
    try {
      const symbols = await commands.executeCommand<SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        symbolName,
      );
      if (symbols && symbols.length > 0) {
        const results = symbols
          .slice(0, 10)
          .map((s: SymbolInformation) => {
            const relPath = path.relative(root.fsPath, s.location.uri.fsPath);
            return `${s.name} (${s.kind}) — ${relPath}:${s.location.range.start.line + 1}`;
          })
          .join('\n');
        attachments.push(`### @symbol:${symbolName}\n\`\`\`\n${results}\n\`\`\``);
      }
    } catch {
      /* symbol search failed */
    }
  }

  if (attachments.length > 0) {
    result += '\n\n--- Referenced Context ---\n\n' + attachments.join('\n\n');
  }

  return result;
}

export async function resolveFileReferences(text: string): Promise<string> {
  const workspaceFolders = workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) return text;

  const root = workspaceFolders[0].uri;
  const filePathRegex = /(?:^|\s)(\.{0,2}\/[\w\-.\/]+\.\w{1,10})(?:\s|$|[,;:)])/g;
  let match;
  const attached: { filePath: string; content: string }[] = [];
  const seen = new Set<string>();

  while ((match = filePathRegex.exec(text)) !== null) {
    const candidate = match[1].trim();
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const fileUri = Uri.joinPath(root, candidate);
      const stat = await workspace.fs.stat(fileUri);
      if (stat.size > MAX_FILE_SIZE) continue;
      const bytes = await workspace.fs.readFile(fileUri);
      const content = Buffer.from(bytes).toString('utf-8').slice(0, MAX_CONTENT_LENGTH);
      attached.push({ filePath: candidate, content });
    } catch {
      // File doesn't exist, skip
    }
  }

  if (attached.length === 0) return text;

  let result = text + '\n\n--- Referenced Files ---\n';
  for (const f of attached) {
    result += `\n### ${f.filePath}\n\`\`\`\n${f.content}\n\`\`\`\n`;
  }
  return result;
}
