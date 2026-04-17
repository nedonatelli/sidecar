import { workspace, Uri } from 'vscode';
import * as path from 'path';

export interface SecurityIssue {
  file: string;
  line: number;
  severity: 'error' | 'warning';
  category: 'secret' | 'vulnerability';
  message: string;
}

// --- Secret patterns ---
//
// **Version** — bump `SECRET_PATTERNS_VERSION` whenever patterns are
// added, removed, or materially changed. Downstream tooling (an
// eventual `sidecar.scanner.patternsVersion` diagnostic, CI smoke
// tests, and the SECURITY.md audit trail) reads this constant so
// users can tell at a glance which pattern set their extension ships.
//
// **CVE / disclosure path** — see [`SECURITY.md`](../../SECURITY.md).
// Reports go to the maintainer via the project's private disclosure
// channel. Pattern gaps (e.g., a new provider's key format slipping
// through) are treated as low-severity CVEs but still shipped as
// patch releases — malicious MCP servers, telemetry leaks, and
// agent-forwarded tool inputs all depend on this catalog staying
// current.

export const SECRET_PATTERNS_VERSION = 2;

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // --- AWS ---
  { name: 'AWS Access Key', pattern: /(?:^|[^A-Za-z0-9/+=])AKIA[0-9A-Z]{16}(?:[^A-Za-z0-9/+=]|$)/ },
  { name: 'AWS Secret Key', pattern: /(?:aws_secret_access_key|secret_key)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/i },
  // --- GitHub ---
  { name: 'GitHub Token', pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/ },
  // --- LLM provider keys ---
  // Ordered provider-first-matches-first: the more-specific `sk-ant-`
  // and `sk-or-` patterns must run before the catch-all OpenAI `sk-`
  // so a match counts under the correct provider name.
  { name: 'Anthropic API Key', pattern: /sk-ant-[A-Za-z0-9_\-]{20,}/ },
  { name: 'OpenRouter API Key', pattern: /sk-or-[A-Za-z0-9_\-]{20,}/ },
  { name: 'OpenAI API Key', pattern: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'HuggingFace Token', pattern: /\bhf_[A-Za-z0-9]{34,}\b/ },
  { name: 'Cohere API Key', pattern: /\bco-[A-Za-z0-9]{40}\b/ },
  { name: 'Replicate API Token', pattern: /\br8_[A-Za-z0-9]{37}\b/ },
  // --- Payment providers ---
  { name: 'Stripe Live Secret Key', pattern: /\bsk_live_[A-Za-z0-9]{24,}/ },
  { name: 'Stripe Live Publishable Key', pattern: /\bpk_live_[A-Za-z0-9]{24,}/ },
  { name: 'Stripe Live Restricted Key', pattern: /\brk_live_[A-Za-z0-9]{24,}/ },
  // --- Communication APIs ---
  { name: 'Twilio Account SID', pattern: /\bAC[0-9a-f]{32}\b/ },
  { name: 'SendGrid API Key', pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { name: 'Mailgun API Key', pattern: /\bkey-[0-9a-f]{32}\b/ },
  // --- Cloud platforms ---
  { name: 'Google API Key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    name: 'Azure Storage Connection String',
    pattern: /DefaultEndpointsProtocol=https;AccountName=[A-Za-z0-9]+;AccountKey=[^;\s'"]+/,
  },
  // --- Package registries ---
  { name: 'npm Access Token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'npm Legacy Auth Token', pattern: /\/\/registry\.npmjs\.org\/:_authToken=[A-Za-z0-9_-]+/ },
  { name: 'PyPI Token', pattern: /\bpypi-AgE[A-Za-z0-9_-]{50,}/ },
  // --- Team comms ---
  { name: 'Slack Token', pattern: /xox[bprs]-[A-Za-z0-9\-]{10,}/ },
  // --- Generic heuristics (ordered last — weakest signal) ---
  { name: 'Generic API Key', pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*['"][A-Za-z0-9_\-]{20,}['"]/i },
  { name: 'Generic Secret', pattern: /(?:secret|password|passwd|token)\s*[=:]\s*['"][^'"]{8,}['"]/i },
  { name: 'Private Key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'JWT Token', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/ },
  { name: 'Connection String', pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^\s'"]{10,}/i },
  { name: 'Hardcoded IP with credentials', pattern: /(?:https?:\/\/)[^:]+:[^@]+@\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/ },
];

// --- Vulnerability patterns ---

interface VulnerabilityPattern {
  name: string;
  pattern: RegExp;
  fileTypes?: string[];
}

const VULNERABILITY_PATTERNS: VulnerabilityPattern[] = [
  {
    name: 'SQL Injection risk: string concatenation in query',
    pattern: /(?:execute|query|raw)\s*\(\s*['"`].*\$\{|(?:execute|query|raw)\s*\(\s*['"`].*\+\s*\w/,
    fileTypes: ['.ts', '.js', '.py', '.java', '.rb', '.php'],
  },
  {
    name: 'Command Injection risk: unvalidated input in exec/spawn',
    pattern: /(?:exec|execSync|spawn|system|popen)\s*\(\s*(?:.*\$\{|.*\+\s*\w)/,
    fileTypes: ['.ts', '.js', '.py', '.rb', '.php'],
  },
  {
    name: 'XSS risk: innerHTML assignment',
    pattern: /\.innerHTML\s*=\s*(?!['"`]<)/,
    fileTypes: ['.ts', '.js', '.tsx', '.jsx'],
  },
  {
    name: 'Eval usage: potential code injection',
    pattern: /\beval\s*\(/,
    fileTypes: ['.ts', '.js', '.tsx', '.jsx', '.py'],
  },
  {
    name: 'Insecure HTTP URL (non-localhost)',
    pattern: /['"]http:\/\/(?!localhost|127\.0\.0\.1)[^'"]+['"]/,
  },
];

// Files to skip (binary, generated, deps)
const SKIP_PATTERNS = /(?:node_modules|\.git|dist|out|\.min\.|\.map$|\.lock$|package-lock)/;

/**
 * Scan file content for secrets and vulnerabilities.
 */
export function scanContent(content: string, filePath: string): SecurityIssue[] {
  if (SKIP_PATTERNS.test(filePath)) return [];

  const ext = path.extname(filePath).toLowerCase();
  const issues: SecurityIssue[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip comments (basic heuristic)
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

    // Secret detection
    for (const sp of SECRET_PATTERNS) {
      if (sp.pattern.test(line)) {
        issues.push({
          file: filePath,
          line: lineNum,
          severity: 'error',
          category: 'secret',
          message: `Potential ${sp.name} detected`,
        });
      }
    }

    // Vulnerability detection
    for (const vp of VULNERABILITY_PATTERNS) {
      if (vp.fileTypes && !vp.fileTypes.includes(ext)) continue;
      if (vp.pattern.test(line)) {
        issues.push({
          file: filePath,
          line: lineNum,
          severity: 'warning',
          category: 'vulnerability',
          message: vp.name,
        });
      }
    }
  }

  return issues;
}

/**
 * Scan a workspace file by path for secrets and vulnerabilities.
 */
export async function scanFile(relativePath: string): Promise<SecurityIssue[]> {
  const rootUri = workspace.workspaceFolders?.[0]?.uri;
  if (!rootUri) return [];

  try {
    const fileUri = Uri.joinPath(rootUri, relativePath);
    const bytes = await workspace.fs.readFile(fileUri);
    const content = Buffer.from(bytes).toString('utf-8');
    return scanContent(content, relativePath);
  } catch {
    return [];
  }
}

/**
 * Format security issues as a readable string for chat/diagnostics output.
 */
export function formatIssues(issues: SecurityIssue[]): string {
  if (issues.length === 0) return '';
  return issues.map((i) => `${i.file}:${i.line} [${i.severity.toUpperCase()}] ${i.message}`).join('\n');
}

/**
 * Replace every match of the `SECRET_PATTERNS` used by the line-level
 * scanner with `[REDACTED:<name>]` so secrets can't leak through
 * non-source channels (env vars handed to hook / custom-tool child
 * processes, log sinks, tool-result bodies forwarded to external
 * MCP servers, etc.).
 *
 * Used by `executor.ts` before setting `SIDECAR_INPUT` / `SIDECAR_OUTPUT`
 * on a hook's child process environment, and by `tools.ts` before
 * forwarding user-typed `custom_*` tool input — without this, a tool
 * call input like `{"key": "sk-ant-AAAA..."}` (e.g. after a `read_file`
 * on a `.env` that slipped past the sensitive-file guard) would land
 * verbatim in the child environment, from which anything the child
 * process invokes inherits the secret. Audit cycle-3 MEDIUM #7.
 *
 * Only redacts — does not report. Callers that want both redaction and
 * an audit trail should also run `scanContent()` on the original text.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let redacted = text;
  for (const sp of SECRET_PATTERNS) {
    // Each pattern is match-and-replace with `g` forced on — the
    // canonical `SECRET_PATTERNS` don't carry a `g` flag because
    // `scanContent`'s line-by-line walk only needs a first-match test.
    const globalPattern = new RegExp(
      sp.pattern.source,
      sp.pattern.flags.includes('g') ? sp.pattern.flags : sp.pattern.flags + 'g',
    );
    redacted = redacted.replace(globalPattern, `[REDACTED:${sp.name}]`);
  }
  return redacted;
}
