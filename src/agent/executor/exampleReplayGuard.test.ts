import { describe, it, expect } from 'vitest';
import { extractExampleArgs, isExampleReplay, buildExampleReplayError } from './exampleReplayGuard.js';

// Real description shapes from the catalog (ec772f7 standardized on
// "when to use + when not + example"), including the live-observed
// ask_user replay that motivated the guard.
const ASK_USER_DESC =
  'Ask the user a clarifying question with suggested options they can pick from. ' +
  'Example: `ask_user(question="Which auth flow should the callback use?", options=["OAuth code exchange", "Implicit (deprecated)", "Password grant"], allow_custom=true)`.';

describe('extractExampleArgs', () => {
  it('parses the ask_user example: strings, string array, boolean', () => {
    expect(extractExampleArgs(ASK_USER_DESC)).toEqual({
      question: 'Which auth flow should the callback use?',
      options: ['OAuth code exchange', 'Implicit (deprecated)', 'Password grant'],
      allow_custom: true,
    });
  });

  it('parses single-quoted strings', () => {
    expect(extractExampleArgs("Describe a tool. Example: `describe_tool(name='latex_compile')`.")).toEqual({
      name: 'latex_compile',
    });
  });

  it('parses numbers and negative-number arrays', () => {
    expect(
      extractExampleArgs(
        'Run a query. Example: `db_query(connection_id="my-db", sql="SELECT * FROM runs WHERE snr < $1 LIMIT 20", params=[-30])`.',
      ),
    ).toEqual({
      connection_id: 'my-db',
      sql: 'SELECT * FROM runs WHERE snr < $1 LIMIT 20',
      params: [-30],
    });
  });

  it('handles parentheses and equals signs inside string values (edit_file example)', () => {
    expect(
      extractExampleArgs(
        'Edit a file. Example: `edit_file(path="src/utils.ts", search="function greet(name: string)", replace="function greet(name: string, greeting = \'Hello\')")`.',
      ),
    ).toEqual({
      path: 'src/utils.ts',
      search: 'function greet(name: string)',
      replace: "function greet(name: string, greeting = 'Hello')",
    });
  });

  it('unescapes backslash-escaped quotes inside strings', () => {
    expect(
      extractExampleArgs(
        'Example: `write_file(path="src/hello.ts", content="export const hello = () => \\\'hi\\\';")`',
      ),
    ).toEqual({
      path: 'src/hello.ts',
      content: "export const hello = () => 'hi';",
    });
  });

  it('parses integers, booleans, and null literals', () => {
    expect(extractExampleArgs('Example: `t(n=42, ratio=0.5, on=false, x=null)`')).toEqual({
      n: 42,
      ratio: 0.5,
      on: false,
      x: null,
    });
  });

  it('parses JSON-shaped object values', () => {
    expect(extractExampleArgs('Example: `t(opts={"depth": 2, "tags": ["a"]})`')).toEqual({
      opts: { depth: 2, tags: ['a'] },
    });
  });

  it('parses colon-separated arguments (notebook/research tool style)', () => {
    expect(
      extractExampleArgs(
        'Ingest a source. Example: `ingest_source(source: "https://arxiv.org/abs/1706.03762", label: "attention-paper")`.',
      ),
    ).toEqual({
      source: 'https://arxiv.org/abs/1706.03762',
      label: 'attention-paper',
    });
  });

  it('parses the whole-object form with unquoted keys (render_viz style)', () => {
    expect(
      extractExampleArgs('Example: `render_viz({ type: "chart", data: [10, 20, 15], labels: ["Q1", "Q2", "Q3"] })`'),
    ).toEqual({
      type: 'chart',
      data: [10, 20, 15],
      labels: ['Q1', 'Q2', 'Q3'],
    });
  });

  it('returns null for zero-arg examples', () => {
    expect(extractExampleArgs('Check CI. Example: `check_pr_ci()`.')).toBeNull();
  });

  it('returns null for <placeholder> values', () => {
    expect(extractExampleArgs('Example: `synthesize_tests(constraints=<JSON string>, doc_slug="spec")`')).toBeNull();
  });

  it('returns null when there is no example', () => {
    expect(extractExampleArgs('Reads a file from the workspace.')).toBeNull();
    expect(extractExampleArgs(undefined)).toBeNull();
  });

  it('returns null on malformed argument syntax', () => {
    expect(extractExampleArgs('Example: `t(question)`')).toBeNull();
    expect(extractExampleArgs('Example: `t(q="unterminated)`')).toBeNull();
    expect(extractExampleArgs('Example: `t(a=[1, 2)`')).toBeNull();
  });
});

describe('isExampleReplay', () => {
  it('flags a verbatim replay of the ask_user example', () => {
    expect(
      isExampleReplay(
        'ask_user',
        {
          question: 'Which auth flow should the callback use?',
          options: ['OAuth code exchange', 'Implicit (deprecated)', 'Password grant'],
          allow_custom: true,
        },
        ASK_USER_DESC,
      ),
    ).toBe(true);
  });

  it('is insensitive to key order', () => {
    expect(
      isExampleReplay(
        'ask_user',
        {
          allow_custom: true,
          options: ['OAuth code exchange', 'Implicit (deprecated)', 'Password grant'],
          question: 'Which auth flow should the callback use?',
        },
        ASK_USER_DESC,
      ),
    ).toBe(true);
  });

  it('does not flag a call with any argument changed', () => {
    expect(
      isExampleReplay(
        'ask_user',
        {
          question: 'Should I use tabs or spaces?',
          options: ['OAuth code exchange', 'Implicit (deprecated)', 'Password grant'],
          allow_custom: true,
        },
        ASK_USER_DESC,
      ),
    ).toBe(false);
  });

  it('does not flag a subset of the example arguments', () => {
    expect(isExampleReplay('ask_user', { question: 'Which auth flow should the callback use?' }, ASK_USER_DESC)).toBe(
      false,
    );
  });

  it('does not flag a superset of the example arguments', () => {
    const desc = 'Example: `edit_file(path="src/utils.ts", search="a")`';
    expect(isExampleReplay('edit_file', { path: 'src/utils.ts', search: 'a', replace: 'b' }, desc)).toBe(false);
  });

  it('never guards single-argument examples — real workspaces collide with them', () => {
    // An eval fixture independently chose src/utils.ts, the exact path in
    // read_file's description example: a legitimate single-key call can
    // match a single-arg example by coincidence, so those are unguarded.
    const desc = 'Read a file. Example: `read_file(path="src/utils.ts")`.';
    expect(isExampleReplay('read_file', { path: 'src/utils.ts' }, desc)).toBe(false);
  });

  it('never flags empty input, non-object input, or tools without a guardable example', () => {
    expect(isExampleReplay('ask_user', {}, ASK_USER_DESC)).toBe(false);
    expect(isExampleReplay('ask_user', 'hi', ASK_USER_DESC)).toBe(false);
    expect(isExampleReplay('ask_user', ['x'], ASK_USER_DESC)).toBe(false);
    expect(isExampleReplay('check_pr_ci', { any: 'thing' }, 'Example: `check_pr_ci()`.')).toBe(false);
    expect(isExampleReplay('plain', { a: 1 }, 'No example here.')).toBe(false);
    expect(isExampleReplay('plain', { a: 1 }, undefined)).toBe(false);
  });

  it('re-extracts when a cached tool name reappears with a changed description (MCP reconnect)', () => {
    const name = 'mcp_srv_search';
    const descV1 = 'Example: `mcp_srv_search(query="alpha", limit=5)`';
    const descV2 = 'Example: `mcp_srv_search(query="beta", limit=5)`';
    expect(isExampleReplay(name, { query: 'alpha', limit: 5 }, descV1)).toBe(true);
    expect(isExampleReplay(name, { query: 'alpha', limit: 5 }, descV2)).toBe(false);
    expect(isExampleReplay(name, { query: 'beta', limit: 5 }, descV2)).toBe(true);
  });
});

describe('buildExampleReplayError', () => {
  it('names the tool and instructs plain-text fallback', () => {
    const msg = buildExampleReplayError('ask_user');
    expect(msg).toContain('ask_user');
    expect(msg).toContain('illustrative');
    expect(msg).toContain('plain text');
  });
});
