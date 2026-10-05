/**
 * Web search — pluggable provider backend.
 *
 * Providers:
 *   duckduckgo — HTML scraping, no API key required (default).
 *   tavily     — REST API, requires sidecar.webSearch.apiKey (tvly-xxx).
 *   brave      — REST API, requires sidecar.webSearch.apiKey (BSAxxx).
 */

export type WebSearchProvider = 'duckduckgo' | 'tavily' | 'brave';

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

/**
 * The search provider refused to answer: a bot check (DuckDuckGo) or a rate
 * limit (Tavily, Brave). Distinct from "no results" -- rephrasing cannot help,
 * and every retry against a bot check deepens it.
 */
export class SearchProviderBlockedError extends Error {
  constructor(
    readonly provider: WebSearchProvider,
    detail: string,
  ) {
    super(detail);
    this.name = 'SearchProviderBlockedError';
  }
}

/** How long a blocked provider is left alone before it is asked again. */
export const SEARCH_BLOCK_COOLDOWN_MS = 10 * 60_000;
const blockedUntil = new Map<WebSearchProvider, number>();

/** Test hook: forget every recorded block. */
export function resetSearchBlocks(): void {
  blockedUntil.clear();
}

function block(provider: WebSearchProvider, detail: string): never {
  blockedUntil.set(provider, Date.now() + SEARCH_BLOCK_COOLDOWN_MS);
  throw new SearchProviderBlockedError(provider, detail);
}

// DuckDuckGo's bot check, observed 2026-10-05: HTTP 202 with an "anomaly" modal
// ("Unfortunately, bots use DuckDuckGo too. Select all squares containing a
// duck") and no results. Any one marker is enough.
const DDG_CHALLENGE = /anomaly-modal|anomaly\.js|bots use DuckDuckGo too/i;

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

/** The host each provider's searches actually go to -- what the probe should reach. */
const PROVIDER_PROBE_URL: Record<WebSearchProvider, string> = {
  duckduckgo: 'https://duckduckgo.com/',
  tavily: 'https://api.tavily.com/',
  brave: 'https://api.search.brave.com/',
};

/**
 * Can web_search reach the network it needs?
 *
 * It used to HEAD duckduckgo.com whatever the provider and call anything but a
 * 2xx "offline": a Tavily or Brave user on a network that blocks DuckDuckGo was
 * told they had no internet, and a server answering HEAD with 405 read as a dead
 * connection. Now it probes the configured provider's own host, and ANY HTTP
 * answer means reachable -- only a network error or timeout means offline.
 *
 * @param overrideUrl  `sidecar.webSearch.connectivityCheckUrl`: empty = probe the
 *   provider's host; a URL = probe that instead (e.g. a host a corporate network
 *   allows); "off" = skip the probe and let the search report its own failure.
 */
export async function checkInternetConnectivity(
  provider: WebSearchProvider = 'duckduckgo',
  overrideUrl = '',
): Promise<boolean> {
  const override = overrideUrl.trim();
  if (override.toLowerCase() === 'off') return true;
  try {
    await fetch(override || PROVIDER_PROBE_URL[provider] || PROVIDER_PROBE_URL.duckduckgo, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Search the web using the configured provider.
 *
 * Throws `SearchQueryBlockedError` if the query matches a credential pattern.
 *
 * @param query      The search query string.
 * @param provider   Which backend to use (default: duckduckgo).
 * @param apiKey     API key for Tavily or Brave (ignored for duckduckgo).
 */
export async function searchWeb(
  query: string,
  provider: WebSearchProvider = 'duckduckgo',
  apiKey = '',
): Promise<SearchResult[]> {
  const leakedSecret = checkSearchQueryForSecrets(query);
  if (leakedSecret) {
    throw new SearchQueryBlockedError(
      `Refusing to run web_search: the query contains what looks like ${leakedSecret}. ` +
        `Search queries become part of the URL and are logged by the search engine, ` +
        `so secrets in queries become data leaks. If this match is a false positive, ` +
        `reword the query without the credential-shaped token.`,
    );
  }

  const until = blockedUntil.get(provider) ?? 0;
  if (Date.now() < until) {
    throw new SearchProviderBlockedError(provider, `${provider} blocked an earlier search; not asking again yet.`);
  }

  if (provider === 'tavily') return searchWebTavily(query, apiKey);
  if (provider === 'brave') return searchWebBrave(query, apiKey);
  return searchWebDuckDuckGo(query);
}

async function searchWebDuckDuckGo(query: string): Promise<SearchResult[]> {
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

  if (response.status === 429) block('duckduckgo', 'DuckDuckGo rate-limited the search (HTTP 429).');
  if (!response.ok) {
    throw new Error(`Search failed: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  // 202 is `ok`, so the bot check used to be parsed as an empty result set.
  if (response.status === 202 || DDG_CHALLENGE.test(html)) {
    block('duckduckgo', 'DuckDuckGo answered with a bot check instead of results.');
  }
  return parseSearchResults(html);
}

async function searchWebTavily(query: string, apiKey: string): Promise<SearchResult[]> {
  if (!apiKey) throw new Error('Tavily requires sidecar.webSearch.apiKey (get one at tavily.com).');

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: MAX_RESULTS, include_raw_content: false }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT),
  });

  if (response.status === 429) block('tavily', 'Tavily rate-limited the search (HTTP 429).');
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Tavily search failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`);
  }

  const json = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (json.results ?? []).slice(0, MAX_RESULTS).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }));
}

async function searchWebBrave(query: string, apiKey: string): Promise<SearchResult[]> {
  if (!apiKey) throw new Error('Brave Search requires sidecar.webSearch.apiKey (get one at brave.com/search/api).');

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT),
  });

  if (response.status === 429) block('brave', 'Brave rate-limited the search (HTTP 429).');
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Brave search failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`);
  }

  const json = (await response.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (json.web?.results ?? []).slice(0, MAX_RESULTS).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.description ?? '',
  }));
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

import { unescapeHtml } from '../util/html.js';

/** Strip HTML tags from a string. */
function stripHtml(html: string): string {
  return unescapeHtml(html.replace(/<[^>]+>/g, ''));
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
