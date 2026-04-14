/**
 * Web search via DuckDuckGo HTML — no API key required.
 * Extracts search results from the HTML response.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Error thrown when a search query contains credential-looking substrings.
 * Caught by the tool executor and surfaced as a tool-result error so the
 * model sees a clear reason and doesn't retry with the same payload.
 */
export class SearchQueryBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SearchQueryBlockedError';
  }
}

const SEARCH_URL = 'https://html.duckduckgo.com/html/';
const USER_AGENT = 'SideCar-VSCode/1.0 (AI Coding Assistant)';
const SEARCH_TIMEOUT = 10_000;
const MAX_RESULTS = 8;

/**
 * Patterns that look like leaked credentials embedded in a search query.
 * A prompt-injected agent attempting to exfiltrate secrets into the
 * DuckDuckGo query-string logs would match one of these. The list is
 * intentionally narrower than the full security-scanner pattern set —
 * search queries legitimately contain words like `token` and `secret`
 * (e.g., "how do OAuth tokens work"), so we only flag patterns with
 * unambiguous credential shapes.
 */
const CREDENTIAL_LIKE_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'AWS Access Key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub Token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b/ },
  { name: 'Anthropic API Key', pattern: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/ },
  { name: 'OpenAI API Key', pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'Slack Token', pattern: /\bxox[bprs]-[A-Za-z0-9\-]{10,}\b/ },
  { name: 'JWT Token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\b/ },
  { name: 'Private Key Block', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
];

/**
 * Exfiltration defense: refuse to send a search query that contains
 * credential-shaped substrings. Returns the matched pattern name, or
 * null if the query is clean. Exported for testing.
 */
export function checkSearchQueryForSecrets(query: string): string | null {
  for (const { name, pattern } of CREDENTIAL_LIKE_PATTERNS) {
    if (pattern.test(query)) return name;
  }
  return null;
}

/** Check if the machine has internet connectivity by pinging a known endpoint. */
export async function checkInternetConnectivity(): Promise<boolean> {
  try {
    const response = await fetch('https://duckduckgo.com/', {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Search the web using DuckDuckGo and return parsed results.
 * Returns an empty array if offline or the search fails.
 *
 * Throws `SearchQueryBlockedError` if the query matches a credential
 * pattern — this is the exfiltration gate that prevents a prompt-
 * injected agent from leaking secrets into DuckDuckGo's query-string
 * logs via a `web_search("my secret is sk-ant-xxx")` call.
 */
export async function searchWeb(query: string): Promise<SearchResult[]> {
  const leakedSecret = checkSearchQueryForSecrets(query);
  if (leakedSecret) {
    throw new SearchQueryBlockedError(
      `Refusing to run web_search: the query contains what looks like ${leakedSecret}. ` +
        `Search queries become part of the URL and are logged by the search engine, ` +
        `so secrets in queries become data leaks. If this match is a false positive, ` +
        `reword the query without the credential-shaped token.`,
    );
  }

  const params = new URLSearchParams({ q: query });

  const response = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: params.toString(),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT),
  });

  if (!response.ok) {
    throw new Error(`Search failed: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  return parseSearchResults(html);
}

/**
 * Parse DuckDuckGo HTML search results into structured data.
 */
function parseSearchResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo HTML results are in <a class="result__a" href="...">title</a>
  // with <a class="result__snippet">snippet</a>
  const resultBlocks = html.split(/class="result\s/g).slice(1);

  for (const block of resultBlocks) {
    if (results.length >= MAX_RESULTS) break;

    // Extract URL from result__a href
    const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
    if (!urlMatch) continue;

    // DuckDuckGo proxies URLs through a redirect — extract the actual URL
    let url = urlMatch[1];
    const uddgMatch = url.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      url = decodeURIComponent(uddgMatch[1]);
    }

    // Skip DuckDuckGo internal links
    if (url.includes('duckduckgo.com')) continue;

    // Extract title from result__a content
    const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    const title = titleMatch ? stripHtml(titleMatch[1]).trim() : '';

    // Extract snippet from result__snippet
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : '';

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

/** Strip HTML tags from a string. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Format search results as a readable string for the LLM.
 */
export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No search results found.';
  }

  return results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`).join('\n\n');
}
