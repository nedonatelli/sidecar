/**
 * Web search via DuckDuckGo HTML — no API key required.
 * Extracts search results from the HTML response.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const SEARCH_URL = 'https://html.duckduckgo.com/html/';
const USER_AGENT = 'SideCar-VSCode/1.0 (AI Coding Assistant)';
const SEARCH_TIMEOUT = 10_000;
const MAX_RESULTS = 8;

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
 */
export async function searchWeb(query: string): Promise<SearchResult[]> {
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
