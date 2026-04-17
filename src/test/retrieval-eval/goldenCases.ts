/**
 * Golden-case dataset for RAG-eval (v0.62 e.1). Each case fixes a
 * known-correct retrieval pattern against the synthetic fixture in
 * `fixture.ts`. The fake embedding pipeline in `harness.ts` gives
 * tokenized-prefix similarity, so these cases exercise the *pipeline
 * logic* (filter translation, graph walk, dedup, ranking) rather than
 * real semantic quality — that's what the LLM-eval layer under
 * `tests/llm-eval/` covers separately.
 *
 * Each entry spells out:
 *   - what we're asking about
 *   - which symbols MUST surface in the top-K to count as a pass
 *   - optional retrieval knobs (kindFilter, pathPrefix, graph depth)
 *
 * Add a case whenever you ship a retrieval-affecting change and want
 * to pin the regression. Cases should be independent of embedding
 * backend choice — if a query depends on semantic nuance the fake
 * pipeline can't produce, write a real-model case in
 * `tests/llm-eval/retrieval.eval.ts` instead.
 */

import type { GoldenCase } from './harness.js';

export const GOLDEN_CASES: GoldenCase[] = [
  // ---------------------------------------------------------------------------
  // Concept search — tests that vector ranking surfaces the right
  // symbol when the query describes what a function does.
  // ---------------------------------------------------------------------------
  {
    name: 'concept: authorization middleware surfaces requireAuth',
    query: 'authorization middleware require auth',
    tags: ['concept-search', 'vector'],
    relevantSymbolIds: ['src/auth/middleware.ts::requireAuth'],
    topK: 5,
  },
  {
    name: 'concept: token verification surfaces verifyToken',
    query: 'verify token authorization bearer',
    tags: ['concept-search', 'vector'],
    relevantSymbolIds: ['src/auth/token.ts::verifyToken'],
    topK: 5,
  },
  {
    name: 'concept: user database operations',
    query: 'user database find create operations',
    tags: ['concept-search', 'vector'],
    relevantSymbolIds: ['src/db/users.ts::findUserById', 'src/db/users.ts::createUser'],
    topK: 8,
  },
  {
    name: 'concept: logging utilities',
    query: 'log info error console logger',
    tags: ['concept-search', 'vector'],
    relevantSymbolIds: ['src/utils/logger.ts::logInfo', 'src/utils/logger.ts::logError'],
    topK: 5,
  },
  {
    name: 'concept: formatting helpers',
    query: 'format timestamp duration date',
    tags: ['concept-search', 'vector'],
    relevantSymbolIds: ['src/utils/format.ts::formatTimestamp', 'src/utils/format.ts::formatDuration'],
    topK: 5,
  },

  // ---------------------------------------------------------------------------
  // Graph walk — symbols whose *bodies* don't match the query but
  // whose relationship to a matching symbol should surface them.
  // The fake pipeline guarantees `handleUsers`/`handlePosts` won't
  // score against "authorization middleware" directly (their bodies
  // don't say "auth" or "middleware"), so these cases prove the
  // enrichment path is active.
  // ---------------------------------------------------------------------------
  {
    name: 'graph walk: auth middleware surfaces its callers',
    query: 'authorization middleware require auth',
    tags: ['graph-walk'],
    relevantSymbolIds: [
      'src/auth/middleware.ts::requireAuth',
      'src/routes/users.ts::handleUsers',
      'src/routes/users.ts::handleUserById',
      'src/routes/posts.ts::handlePosts',
    ],
    topK: 3, // direct top-3 is just requireAuth + maybe one noisy hit
    graphWalkDepth: 1,
    maxGraphHits: 10,
  },
  {
    name: 'graph walk: depth 0 disables enrichment',
    // Same query as above but depth=0 means the callers MUST NOT be
    // reached — the scorer uses `relevantSymbolIds` as a positive
    // assertion, so here we assert only requireAuth is expected.
    // A separate case in the vitest runner asserts handleUsers is
    // absent when depth=0.
    query: 'authorization middleware require auth',
    tags: ['graph-walk', 'depth-zero'],
    relevantSymbolIds: ['src/auth/middleware.ts::requireAuth'],
    topK: 3,
    graphWalkDepth: 0,
  },

  // ---------------------------------------------------------------------------
  // Kind filter — restricts results to specific symbol kinds.
  // ---------------------------------------------------------------------------
  {
    name: 'kind filter: interfaces only',
    query: 'user post session data',
    tags: ['kind-filter'],
    relevantSymbolIds: ['src/types.ts::User', 'src/types.ts::Post', 'src/types.ts::Session'],
    topK: 10,
    kindFilter: ['interface'],
    graphWalkDepth: 0, // don't let graph walk add non-interface hits
  },
  {
    name: 'kind filter: functions only excludes interfaces',
    query: 'user data',
    tags: ['kind-filter'],
    relevantSymbolIds: ['src/db/users.ts::findUserById', 'src/db/users.ts::createUser'],
    topK: 10,
    kindFilter: ['function'],
    graphWalkDepth: 0,
  },

  // ---------------------------------------------------------------------------
  // Path prefix — restricts to a subdirectory.
  // ---------------------------------------------------------------------------
  {
    name: 'path prefix: routes/ scope',
    query: 'handle request',
    tags: ['path-filter'],
    relevantSymbolIds: [
      'src/routes/users.ts::handleUsers',
      'src/routes/users.ts::handleUserById',
      'src/routes/posts.ts::handlePosts',
    ],
    topK: 10,
    pathPrefix: 'src/routes/',
    graphWalkDepth: 0, // don't let graph walk pull in callees outside routes/
  },
  {
    name: 'path prefix: utils/ scope filters out logger and format together',
    query: 'utility helper',
    tags: ['path-filter'],
    relevantSymbolIds: [
      'src/utils/logger.ts::logInfo',
      'src/utils/logger.ts::logError',
      'src/utils/format.ts::formatTimestamp',
      'src/utils/format.ts::formatDuration',
    ],
    topK: 10,
    pathPrefix: 'src/utils/',
    graphWalkDepth: 0,
  },
];
