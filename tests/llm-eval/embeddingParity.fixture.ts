// ---------------------------------------------------------------------------
// Fixed input set for the embedding-parity test (Layer 3 harness, v0.64
// post-release). These inputs exercise the real `@xenova/transformers`
// MiniLM pipeline across the patterns the Project Knowledge Index
// actually feeds it in production:
//
//   - Code bodies of varying length (short utility, long method)
//   - Multiple languages (TS, Python, Go) — the PKI indexes all three
//   - Different symbol kinds (function, class, interface, arrow, const)
//   - Query-style natural-language strings (what a user types into
//     `project_knowledge_search`)
//   - Single-identifier queries
//   - An empty / whitespace input (edge case: must not throw)
//
// Keep this list STABLE across releases. Adding new inputs forces a
// baseline regeneration which defeats the purpose of the parity check.
// If you need a new scenario, add it as a fresh entry at the END of
// the list and regenerate — old entries stay byte-identical with the
// pre-change snapshot, so you can still verify regressions on the old
// set while capturing a new baseline for the new input.
// ---------------------------------------------------------------------------

export interface ParityFixture {
  /** Short stable id used as the JSON key in the baseline snapshot. */
  id: string;
  /** Human-readable description for test output. */
  description: string;
  /** The actual input fed to the pipeline. */
  input: string;
}

export const PARITY_FIXTURES: readonly ParityFixture[] = [
  {
    id: 'ts-short-fn',
    description: 'TypeScript short utility function',
    input: `export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}`,
  },
  {
    id: 'ts-long-fn',
    description: 'TypeScript longer function with comments',
    input: `/**
 * Parse a config file and return the resolved settings object.
 * Falls back to defaults when the file is missing or malformed.
 */
export async function parseConfig(filePath: string): Promise<Config> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_CONFIG;
    }
    throw err;
  }
}`,
  },
  {
    id: 'ts-class',
    description: 'TypeScript class with methods',
    input: `export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly capacity: number, private readonly refillRate: number) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  consume(amount: number): boolean {
    this.refill();
    if (this.tokens < amount) return false;
    this.tokens -= amount;
    return true;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}`,
  },
  {
    id: 'ts-interface',
    description: 'TypeScript interface declaration',
    input: `export interface RouteSignals {
  role: RoutableRole;
  complexity?: 'low' | 'medium' | 'high';
  files?: readonly string[];
  prompt?: string;
  retryCount?: number;
  turnCount?: number;
}`,
  },
  {
    id: 'ts-arrow',
    description: 'TypeScript arrow function + const export',
    input: `export const isNonEmptyArray = <T,>(value: unknown): value is T[] =>
  Array.isArray(value) && value.length > 0;`,
  },
  {
    id: 'python-fn',
    description: 'Python function with type hints',
    input: `def exponential_backoff(attempt: int, base_ms: int = 1000, max_ms: int = 30000) -> int:
    """Compute the wait time in ms for a given retry attempt."""
    delay = base_ms * (2 ** (attempt - 1))
    return min(delay, max_ms)`,
  },
  {
    id: 'go-fn',
    description: 'Go function with error handling',
    input: `func (c *Client) Fetch(ctx context.Context, url string) ([]byte, error) {
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return nil, fmt.Errorf("build request: %w", err)
    }
    resp, err := c.httpClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("execute request: %w", err)
    }
    defer resp.Body.Close()
    return io.ReadAll(resp.Body)
}`,
  },
  {
    id: 'query-concept',
    description: 'Natural-language query (concept-level)',
    input: 'where is authentication middleware defined',
  },
  {
    id: 'query-action',
    description: 'Natural-language query (action-level)',
    input: 'how do I retry a failed HTTP request with exponential backoff',
  },
  {
    id: 'query-identifier',
    description: 'Single-identifier query',
    input: 'parseConfig',
  },
  {
    id: 'edge-empty',
    description: 'Whitespace-only input (must not crash the pipeline)',
    input: '   ',
  },
];
