/**
 * Synthetic corpus for RAG-eval (v0.62 e.1). A hand-built miniature
 * service codebase with known-correct "where is X?" answers. We use
 * this instead of indexing the real SideCar repo because:
 *
 *  - Tests stay fast (~30 symbols vs. thousands)
 *  - Ground truth is explicit: we know every symbol's role
 *  - Tests stay portable across contributor forks without
 *    depending on the repo shape the eval was authored against
 *
 * The fixture models a small web service with auth middleware,
 * route handlers that wrap the middleware, a DB layer, and assorted
 * utilities. Every golden query in `goldenCases.ts` references
 * symbols here.
 *
 * Structure of each entry:
 *   - `path`: workspace-relative path (never touched on disk — the
 *     harness hands these strings straight to the embedder)
 *   - `source`: the raw file source text, used for body extraction
 *     by line range
 *   - `symbols[]`: every symbol we want indexed, with the line range
 *     the harness slices out of `source` to feed to the embedder
 *   - `calls[]`: call-graph edges the harness seeds into the
 *     `SymbolGraph` so graph-walk retrieval has real edges to walk
 */

export interface FixtureSymbol {
  name: string;
  qualifiedName: string;
  kind: string; // 'function' | 'class' | 'interface' | 'method' | 'type' | 'variable'
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface FixtureCall {
  callerQualifiedName: string;
  calleeQualifiedName: string;
  /** 1-based line in the caller's file where the call site appears. */
  line: number;
}

export interface FixtureFile {
  path: string;
  source: string;
  symbols: FixtureSymbol[];
  calls: FixtureCall[];
}

/**
 * Helper that numbers `source` by 1-based lines so the `startLine` /
 * `endLine` fields below stay readable alongside the source. We avoid
 * template-literal arithmetic by keeping each file's source short.
 */
function file(path: string, source: string, symbols: FixtureSymbol[], calls: FixtureCall[] = []): FixtureFile {
  return { path, source, symbols, calls };
}

export const FIXTURE_FILES: FixtureFile[] = [
  // ---------------------------------------------------------------------------
  // Auth middleware — the canonical "where is auth handled?" target.
  // ---------------------------------------------------------------------------
  file(
    'src/auth/middleware.ts',
    // prettier-ignore
    [
      'import { verifyToken } from "./token";',             // 1
      '',                                                   // 2
      'export function requireAuth(req, res, next) {',      // 3
      '  const token = req.headers.authorization;',         // 4
      '  if (!verifyToken(token)) {',                       // 5
      '    return res.status(401).send("unauthorized");',   // 6
      '  }',                                                // 7
      '  next();',                                          // 8
      '}',                                                  // 9
    ].join('\n'),
    [{ name: 'requireAuth', qualifiedName: 'requireAuth', kind: 'function', startLine: 3, endLine: 9, exported: true }],
    [{ callerQualifiedName: 'requireAuth', calleeQualifiedName: 'verifyToken', line: 5 }],
  ),
  file(
    'src/auth/token.ts',
    [
      'export function verifyToken(token) {', // 1
      '  if (!token) return false;', // 2
      '  return token.startsWith("Bearer ");', // 3
      '}', // 4
      '', // 5
      'export function signToken(userId) {', // 6
      '  return "Bearer sig-" + userId;', // 7
      '}', // 8
    ].join('\n'),
    [
      { name: 'verifyToken', qualifiedName: 'verifyToken', kind: 'function', startLine: 1, endLine: 4, exported: true },
      { name: 'signToken', qualifiedName: 'signToken', kind: 'function', startLine: 6, endLine: 8, exported: true },
    ],
  ),

  // ---------------------------------------------------------------------------
  // Route handlers — these call `requireAuth` so graph walk should
  // surface them from an auth query even though their bodies don't
  // mention "auth" themselves.
  // ---------------------------------------------------------------------------
  file(
    'src/routes/users.ts',
    [
      'import { requireAuth } from "../auth/middleware";', // 1
      'import { findUserById } from "../db/users";', // 2
      '', // 3
      'export function handleUsers(req, res) {', // 4
      '  requireAuth(req, res, () => {', // 5
      '    res.json({ users: [] });', // 6
      '  });', // 7
      '}', // 8
      '', // 9
      'export function handleUserById(req, res) {', // 10
      '  requireAuth(req, res, () => {', // 11
      '    const user = findUserById(req.params.id);', // 12
      '    res.json({ user });', // 13
      '  });', // 14
      '}', // 15
    ].join('\n'),
    [
      { name: 'handleUsers', qualifiedName: 'handleUsers', kind: 'function', startLine: 4, endLine: 8, exported: true },
      {
        name: 'handleUserById',
        qualifiedName: 'handleUserById',
        kind: 'function',
        startLine: 10,
        endLine: 15,
        exported: true,
      },
    ],
    [
      { callerQualifiedName: 'handleUsers', calleeQualifiedName: 'requireAuth', line: 5 },
      { callerQualifiedName: 'handleUserById', calleeQualifiedName: 'requireAuth', line: 11 },
      { callerQualifiedName: 'handleUserById', calleeQualifiedName: 'findUserById', line: 12 },
    ],
  ),
  file(
    'src/routes/posts.ts',
    [
      'import { requireAuth } from "../auth/middleware";', // 1
      '', // 2
      'export function handlePosts(req, res) {', // 3
      '  requireAuth(req, res, () => {', // 4
      '    res.json({ posts: [] });', // 5
      '  });', // 6
      '}', // 7
    ].join('\n'),
    [{ name: 'handlePosts', qualifiedName: 'handlePosts', kind: 'function', startLine: 3, endLine: 7, exported: true }],
    [{ callerQualifiedName: 'handlePosts', calleeQualifiedName: 'requireAuth', line: 4 }],
  ),

  // ---------------------------------------------------------------------------
  // DB layer — "user database operations" should surface these.
  // ---------------------------------------------------------------------------
  file(
    'src/db/users.ts',
    [
      'export function findUserById(id) {', // 1
      '  return { id, name: "test" };', // 2
      '}', // 3
      '', // 4
      'export function createUser(data) {', // 5
      '  return { id: "new-id", ...data };', // 6
      '}', // 7
    ].join('\n'),
    [
      {
        name: 'findUserById',
        qualifiedName: 'findUserById',
        kind: 'function',
        startLine: 1,
        endLine: 3,
        exported: true,
      },
      { name: 'createUser', qualifiedName: 'createUser', kind: 'function', startLine: 5, endLine: 7, exported: true },
    ],
  ),

  // ---------------------------------------------------------------------------
  // Utilities — split into two files to validate pathPrefix filtering.
  // ---------------------------------------------------------------------------
  file(
    'src/utils/logger.ts',
    [
      'export function logInfo(message) {', // 1
      '  console.log("[INFO]", message);', // 2
      '}', // 3
      '', // 4
      'export function logError(message) {', // 5
      '  console.error("[ERROR]", message);', // 6
      '}', // 7
    ].join('\n'),
    [
      { name: 'logInfo', qualifiedName: 'logInfo', kind: 'function', startLine: 1, endLine: 3, exported: true },
      { name: 'logError', qualifiedName: 'logError', kind: 'function', startLine: 5, endLine: 7, exported: true },
    ],
  ),
  file(
    'src/utils/format.ts',
    [
      'export function formatTimestamp(ms) {', // 1
      '  return new Date(ms).toISOString();', // 2
      '}', // 3
      '', // 4
      'export function formatDuration(ms) {', // 5
      '  return (ms / 1000).toFixed(2) + "s";', // 6
      '}', // 7
    ].join('\n'),
    [
      {
        name: 'formatTimestamp',
        qualifiedName: 'formatTimestamp',
        kind: 'function',
        startLine: 1,
        endLine: 3,
        exported: true,
      },
      {
        name: 'formatDuration',
        qualifiedName: 'formatDuration',
        kind: 'function',
        startLine: 5,
        endLine: 7,
        exported: true,
      },
    ],
  ),

  // ---------------------------------------------------------------------------
  // Interface + type-only file — validates kindFilter.
  // ---------------------------------------------------------------------------
  file(
    'src/types.ts',
    [
      'export interface User {', // 1
      '  id: string;', // 2
      '  name: string;', // 3
      '  email: string;', // 4
      '}', // 5
      '', // 6
      'export interface Post {', // 7
      '  id: string;', // 8
      '  authorId: string;', // 9
      '  body: string;', // 10
      '}', // 11
      '', // 12
      'export interface Session {', // 13
      '  userId: string;', // 14
      '  expiresAt: number;', // 15
      '}', // 16
    ].join('\n'),
    [
      { name: 'User', qualifiedName: 'User', kind: 'interface', startLine: 1, endLine: 5, exported: true },
      { name: 'Post', qualifiedName: 'Post', kind: 'interface', startLine: 7, endLine: 11, exported: true },
      { name: 'Session', qualifiedName: 'Session', kind: 'interface', startLine: 13, endLine: 16, exported: true },
    ],
  ),

  // ---------------------------------------------------------------------------
  // Server config — a mix of function + interface for filter tests.
  // ---------------------------------------------------------------------------
  file(
    'src/config.ts',
    [
      'export interface ServerConfig {', // 1
      '  port: number;', // 2
      '  host: string;', // 3
      '}', // 4
      '', // 5
      'export function loadConfig() {', // 6
      '  return { port: 3000, host: "localhost" };', // 7
      '}', // 8
    ].join('\n'),
    [
      {
        name: 'ServerConfig',
        qualifiedName: 'ServerConfig',
        kind: 'interface',
        startLine: 1,
        endLine: 4,
        exported: true,
      },
      { name: 'loadConfig', qualifiedName: 'loadConfig', kind: 'function', startLine: 6, endLine: 8, exported: true },
    ],
  ),
];

/** Every symbol in the fixture, flattened — used for sanity checks. */
export function allFixtureSymbols(): Array<FixtureSymbol & { filePath: string }> {
  return FIXTURE_FILES.flatMap((f) => f.symbols.map((s) => ({ ...s, filePath: f.path })));
}

/**
 * Resolve a golden-dataset symbol reference (`filePath::qualifiedName`
 * or just `qualifiedName`) to the full fixture entry. Golden cases
 * sometimes reference by short name when the name is globally unique
 * in the fixture; this helper accepts either form.
 */
export function findFixtureSymbol(ref: string): (FixtureSymbol & { filePath: string }) | undefined {
  if (ref.includes('::')) {
    const [filePath, qualifiedName] = ref.split('::');
    return allFixtureSymbols().find((s) => s.filePath === filePath && s.qualifiedName === qualifiedName);
  }
  const matches = allFixtureSymbols().filter((s) => s.qualifiedName === ref);
  return matches.length === 1 ? matches[0] : undefined;
}
