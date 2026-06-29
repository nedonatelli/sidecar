---
title: Smart Context
layout: docs
nav_order: 9
---

# Smart Context — AST-Based Code Extraction

SideCar uses lightweight AST parsing to extract relevant functions, classes, and methods from your codebase instead of including entire files in context. This reduces noise and makes better use of limited context windows, especially on local models.

## Supported Languages

| Language | Elements extracted | Block detection |
|----------|-------------------|-----------------|
| JavaScript / TypeScript | `function`, `const/let fn = () =>`, `class`, `import`, `export` | Brace counting `{ }` |
| Python | `def`, `async def`, `class` | Indentation tracking |
| Rust | `fn`, `pub fn`, `async fn` | Brace counting `{ }` |
| Go | `func`, method receivers | Brace counting `{ }` |
| Java / Kotlin | Methods, `fun`, `class` | Brace counting `{ }` |

For unsupported languages, SideCar falls back to including the full file content.

## How It Works

1. **File scanning**: When building context, SideCar scores workspace files by relevance to your query
2. **Element extraction**: For supported languages, the AST parser identifies code elements (functions, classes, methods) in each file
3. **Relevance scoring**: Elements are scored by name match (+0.5), content match (+0.3), and type (class +0.3, function/method +0.2)
4. **Selective inclusion**: Only elements scoring above 0.3 are included, with `...` gap markers between non-contiguous regions
5. **Full body capture**: Extracted elements include their complete body (not just the definition line), found via brace counting or indentation tracking

## Example

When you ask "How does the pruneHistory function work?", SideCar:

1. Finds `context.ts` via keyword matching on "pruneHistory"
2. Extracts the `pruneHistory` function with its full body (including nested helpers)
3. Includes 1 line of context before the function definition
4. Adds `...` markers to show where content was skipped
5. Sends only the relevant ~50 lines instead of the full 170-line file

## Context Priority

Smart context is part of the workspace context pipeline:

1. **Pinned files** — always included first (via `sidecar.pinnedContext` or `@pin:path`)
2. **Relevant files** — scored by query relevance, with AST extraction for supported languages
3. **Workspace tree** — appended last if budget remains, truncated if tight

This ordering ensures the most valuable context gets priority, especially on local models with limited context windows (capped at 8K tokens by default).

## Configuration

Smart context is enabled by default with no additional configuration. It applies automatically to:
- Workspace index context (when the index is ready)
- Fallback glob-based context (via `enhanceContextWithSmartElements`)

The workspace context budget is controlled by `sidecar.maxFiles` and the internal context cap. For local models, tool definitions reserve ~10K chars of the budget to prevent oversized prompts.

## How it parses (dual path)

Smart context uses a **two-tier** strategy. When the tree-sitter WASM grammars are available, it parses a real AST (`src/parsing/`, lazy-loaded). If tree-sitter can't load — unsupported host, missing WASM — it falls back transparently to the always-available regex analyzer (`SimpleCodeAnalyzer` in `src/astContext.ts`), so symbol extraction degrades gracefully rather than failing. The limitations below describe the regex fallback.

## Limitations

- **Regex-based parsing (fallback path)**: The regex analyzer uses pattern matching, not a full AST. It may miss edge cases like deeply nested arrow functions, decorated Python methods, or complex Go interface implementations. The tree-sitter path handles these when its grammars are loaded.
- **Smart-context relevance is keyword-based**: The legacy file-relevance pass uses keyword matching, not embeddings. Embedding-based semantic search now ships separately as the [Project Knowledge Index](rag-and-memory.md) (symbol-level, MiniLM) — see that doc for the semantic path.
- **Cross-file references**: The symbol graph resolves cross-file callers/callees (and the PKI graph-walk expands from a hit to its callers). Tree-sitter extraction itself is per-file; the graph layer stitches files together.
