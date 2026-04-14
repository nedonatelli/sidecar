import { workspace, commands, Uri, CancellationToken, SymbolInformation } from 'vscode';
import * as path from 'path';
import { getConfig } from './settings.js';

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

export function getContextLimit(): number {
  return workspace.getConfiguration('sidecar').get<number>('contextLimit', 0);
}

export async function resolveAtReferences(text: string): Promise<string> {
  const workspaceFolders = workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) return text;

  const root = workspaceFolders[0].uri;
  let result = text;
  const attachments: string[] = [];

  const rootPath = root.fsPath;

  /** Resolve a relative path and verify it stays within the workspace root. */
  function resolveWithinWorkspace(relativePath: string): string | null {
    const resolved = path.resolve(rootPath, relativePath);
    if (!resolved.startsWith(rootPath + path.sep) && resolved !== rootPath) return null;
    return resolved;
  }

  // @file:path — include file content
  const fileRefs = text.matchAll(/@file:([^\s]+)/g);
  for (const match of fileRefs) {
    const filePath = match[1];
    const resolved = resolveWithinWorkspace(filePath);
    if (!resolved) {
      attachments.push(`### @file:${filePath}\n⚠️ Path traversal blocked — must be within workspace`);
      continue;
    }
    try {
      const fileUri = Uri.file(resolved);
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
    const resolved = resolveWithinWorkspace(folderPath);
    if (!resolved) {
      attachments.push(`### @folder:${folderPath}\n⚠️ Path traversal blocked — must be within workspace`);
      continue;
    }
    try {
      const folderUri = Uri.file(resolved);
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

  // @pin:path — pin a file/folder for persistent context inclusion
  // (Stripped from message text; pinning is handled by the caller via extractPinReferences)
  result = result.replace(/@pin:[^\s]+/g, '').trim();

  if (attachments.length > 0) {
    result += '\n\n--- Referenced Context ---\n\n' + attachments.join('\n\n');
  }

  return result;
}

/** Extract @pin:path references from message text and return the paths. */
export function extractPinReferences(text: string): string[] {
  const matches = [...text.matchAll(/@pin:([^\s]+)/g)];
  return matches.map((m) => m[1]);
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

const MAX_URL_CONTENT = 5000;
const MAX_URLS_PER_MESSAGE = 3;
const URL_FETCH_TIMEOUT = 10000;

/**
 * Check if a URL hostname resolves to a private/reserved IP range.
 * Blocks SSRF against cloud metadata, internal services, and localhost.
 */
function isPrivateUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname;
    // Block localhost
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
    // Block private IPv4 ranges and cloud metadata
    const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4) {
      const [, a, b] = ipv4.map(Number);
      if (a === 10) return true; // 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
      if (a === 192 && b === 168) return true; // 192.168.0.0/16
      if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local, cloud metadata)
      if (a === 0) return true; // 0.0.0.0/8
    }
    return false;
  } catch {
    return true; // Block malformed URLs
  }
}

/**
 * Outbound-host allowlist check for URL fetching.
 *
 * When `sidecar.outboundAllowlist` is non-empty, a URL is only fetched
 * if its hostname matches one of the configured patterns. Empty list
 * (the default) allows every public URL — existing behaviour, since
 * SSRF and private-IP blocking via `isPrivateUrl` still applies.
 *
 * Patterns support a leading `*.` wildcard for subdomain matching
 * (`*.github.com` matches `api.github.com` and `raw.github.com` but
 * not `github.com` itself — add both entries to cover that case).
 * Exact hostnames also work: `github.com`, `example.org`.
 *
 * Exported for testing; callers go through `isAllowedOutboundHost`
 * which reads the current config.
 */
export function matchAllowlistHost(host: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  const lower = host.toLowerCase();
  for (const pattern of allowlist) {
    const p = pattern.toLowerCase().trim();
    if (!p) continue;
    if (p.startsWith('*.')) {
      const suffix = p.slice(2);
      if (lower.endsWith('.' + suffix)) return true;
    } else if (lower === p) {
      return true;
    }
  }
  return false;
}

function isAllowedOutboundHost(urlStr: string): boolean {
  const allowlist = getConfig().outboundAllowlist;
  if (!allowlist || allowlist.length === 0) return true;
  try {
    return matchAllowlistHost(new URL(urlStr).hostname, allowlist);
  } catch {
    return false;
  }
}

/**
 * Detect URLs in the message text, fetch readable content, and append it.
 */
export async function resolveUrlReferences(text: string): Promise<string> {
  const urlRegex = /https?:\/\/[^\s)>\]]+/g;
  const urls = [...text.matchAll(urlRegex)].map((m) => m[0]);
  if (urls.length === 0) return text;

  const attachments: string[] = [];
  const seen = new Set<string>();

  for (const url of urls.slice(0, MAX_URLS_PER_MESSAGE)) {
    if (seen.has(url)) continue;
    seen.add(url);
    if (isPrivateUrl(url)) continue; // SSRF protection
    if (!isAllowedOutboundHost(url)) continue; // outbound allowlist (when configured)
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(URL_FETCH_TIMEOUT),
        headers: { 'User-Agent': 'SideCar-VSCode/1.0' },
      });
      if (!response.ok) continue;
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('text/plain')) continue;
      const html = await response.text();
      const readable = extractReadableContent(html).slice(0, MAX_URL_CONTENT);
      if (readable.length > 50) {
        attachments.push(`### ${url}\n\`\`\`\n${readable}\n\`\`\``);
      }
    } catch {
      /* timeout or network error — skip */
    }
  }

  if (attachments.length > 0) {
    return text + '\n\n--- Web Page Context ---\n\n' + attachments.join('\n\n');
  }
  return text;
}

function extractReadableContent(html: string): string {
  // Remove script and style tags with their content
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}
