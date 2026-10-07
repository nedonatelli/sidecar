import { workspace, commands, Uri, CancellationToken, SymbolInformation } from 'vscode';
import * as path from 'path';
import { getConfig } from './settings.js';
import { unescapeHtml } from '../util/html.js';
import { isSensitiveFile, realWorkspaceRelative } from '../agent/tools/shared.js';
import { loadSidecarIgnore, isSidecarIgnored, type IgnoreMatcher } from './sidecarIgnore.js';
import { loadContextFileFilter } from './contextFileFilter.js';
import { classifyHostLiteral, urlBlockReason } from '../util/netGuard.js';

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
  const mayInclude = await loadContextFileFilter(workspaceFolders[0].uri);
  for (const pattern of patterns) {
    if (files.length >= maxFiles) break;
    if (token?.isCancellationRequested) break;

    const uris = await workspace.findFiles(
      pattern,
      `**/{node_modules,.git,out,dist,.venv,venv,__pycache__,.next,.stryker-tmp,graphify-out}/**`,
      maxFiles - files.length,
      token,
    );

    for (const uri of uris) {
      if (files.length >= maxFiles) break;
      if (token?.isCancellationRequested) break;
      if (!mayInclude(uri.fsPath)) continue;

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
    >('filePatterns', ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.vue', '**/*.py', '**/*.md', '**/*.kt', '**/*.kts', '**/*.java', '**/*.swift', '**/*.go', '**/*.rs', '**/*.c', '**/*.cpp', '**/*.cc', '**/*.cxx', '**/*.h', '**/*.hpp', '**/*.hh', '**/*.rb', '**/*.php', '**/*.cs', '**/*.lua', '**/*.scala', '**/*.dart', '**/*.json', '**/*.yaml', '**/*.yml', '**/*.toml', '**/*.gradle.kts', '**/*.gradle', '**/*.html', '**/*.css', '**/*.scss', '**/*.sh', '**/*.bash', '**/*.zsh', '**/*.sql']);
}

export function getMaxFiles(): number {
  return workspace.getConfiguration('sidecar').get<number>('maxFiles', 10);
}

export function getContextLimit(): number {
  return workspace.getConfiguration('sidecar').get<number>('contextLimit', 0);
}

/**
 * Why a file referenced in chat text may not be inlined into the prompt, or
 * null when it may. The text can include files someone else wrote, so the
 * file is judged by where it really is: inside the workspace, not a credential
 * file under any name, and not excluded by .sidecarignore.
 */
function inlineRefusal(rootPath: string, relPath: string, ignore: readonly IgnoreMatcher[]): string | null {
  const real = realWorkspaceRelative(rootPath, relPath);
  if (real === null) return 'outside the workspace — not attached';
  if (isSensitiveFile(relPath) || isSensitiveFile(real)) return 'credential file — not attached';
  if (isSidecarIgnored(real, ignore)) return 'excluded by .sidecarignore — not attached';
  return null;
}

export async function resolveAtReferences(text: string): Promise<string> {
  const workspaceFolders = workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) return text;

  const root = workspaceFolders[0].uri;
  let result = text;
  const attachments: string[] = [];

  const rootPath = root.fsPath;
  let ignore: IgnoreMatcher[] | undefined;

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
    ignore ??= await loadSidecarIgnore(root);
    const refusal = inlineRefusal(rootPath, filePath, ignore);
    if (refusal) {
      attachments.push(`### @file:${filePath}\n⚠️ ${refusal}`);
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
  let ignore: IgnoreMatcher[] | undefined;

  while ((match = filePathRegex.exec(text)) !== null) {
    const candidate = match[1].trim();
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    // A path merely MENTIONED in the text is attached automatically -- and the
    // text can include an attached file someone else wrote. So: inside the
    // workspace only (Uri.joinPath resolves `../` right out of it), and never
    // a credential file.
    const base = path.resolve(root.fsPath);
    const relCandidate = candidate.replace(/^\/+/, '');
    const resolved = path.resolve(base, relCandidate);
    if (!resolved.startsWith(base + path.sep) || isSensitiveFile(resolved)) continue;
    ignore ??= await loadSidecarIgnore(root);
    if (inlineRefusal(base, relCandidate, ignore)) continue;
    try {
      const fileUri = Uri.file(resolved);
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
export function isPrivateUrl(urlStr: string): boolean {
  try {
    // By address range, not by string (see util/netGuard.ts): the old list
    // missed the rest of 127/8 and IPv4-mapped IPv6. Literals only; the fetch
    // below adds DNS resolution and checks every redirect hop.
    const cls = classifyHostLiteral(new URL(urlStr).hostname);
    return cls !== 'name' && cls !== 'public';
  } catch {
    return true; // Block malformed URLs
  }
}

/**
 * fetch() with every hop checked: `fetch` follows redirects by default, so a
 * public URL answering 302 to 169.254.169.254 would be fetched and its body
 * put in the prompt. Follows at most 3 redirects, re-checking each Location
 * (DNS included); returns null when any hop is blocked.
 */
async function fetchPublic(url: string, init: RequestInit): Promise<Response | null> {
  let current = url;
  for (let hop = 0; hop <= 3; hop++) {
    if (await urlBlockReason(current)) return null;
    if (!isAllowedOutboundHost(current)) return null;
    const response = await fetch(current, { ...init, redirect: 'manual' });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (!location) return response;
    current = new URL(location, current).toString();
  }
  return null;
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
      const response = await fetchPublic(url, {
        signal: AbortSignal.timeout(URL_FETCH_TIMEOUT),
        headers: { 'User-Agent': 'SideCar-VSCode/1.0' },
      });
      if (!response?.ok) continue;
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
  // Strip remaining HTML tags, decode entities, collapse whitespace
  return unescapeHtml(text.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}
