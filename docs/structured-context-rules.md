---
title: Structured Context Rules
layout: docs
nav_order: 9
---

# Structured Context Rules (.sidecarrules)

Control which files SideCar includes in its context using a `.sidecarrules` file in your workspace root. Rules use glob patterns to influence file scoring during context building.

## File format

Create a `.sidecarrules` file in your project root with a JSON object containing a `rules` array:

```json
{
  "rules": [
    { "type": "prefer", "pattern": "src/core/**", "boost": 0.4 },
    { "type": "ban", "pattern": "**/*.generated.*" },
    { "type": "require", "pattern": "**/*.test.*" }
  ]
}
```

## Rule types

### prefer

Boosts the relevance score of matching files so they rank higher in context.

```json
{ "type": "prefer", "pattern": "src/api/**", "boost": 0.3 }
```

- `boost` is optional (default: 0.3)
- Higher boost values push files further up the ranking
- Useful for prioritizing the parts of the codebase you're actively working on

### ban

Removes matching files from context entirely. They won't be included regardless of their relevance score.

```json
{ "type": "ban", "pattern": "**/*.generated.*" }
```

Use this for:
- Generated code that shouldn't be edited directly
- Large vendored files that waste context budget
- Deprecated modules you want the agent to ignore

### require

Ensures matching files have at least a minimum score so they're not dropped during top-K selection, even if they don't match the current query.

```json
{ "type": "require", "pattern": "src/types/**" }
```

- `boost` is optional (default: 0.1) and sets the minimum score for files that would otherwise score 0
- Does not affect files that already have a positive score

## Glob pattern syntax

Patterns support standard glob syntax:

| Pattern | Matches |
|---------|---------|
| `*` | Any characters within a single path segment |
| `**` | Any characters across path segments (recursive) |
| `?` | A single character |
| `src/*.ts` | TypeScript files directly in `src/` |
| `src/**/*.ts` | TypeScript files anywhere under `src/` |
| `**/*.test.*` | Test files at any depth |

## Examples

### Focus on a specific module

```json
{
  "rules": [
    { "type": "prefer", "pattern": "src/payments/**", "boost": 0.5 },
    { "type": "ban", "pattern": "src/legacy/**" }
  ]
}
```

### Exclude build artifacts and always include types

```json
{
  "rules": [
    { "type": "ban", "pattern": "dist/**" },
    { "type": "ban", "pattern": "coverage/**" },
    { "type": "require", "pattern": "src/types/**" }
  ]
}
```

## How rules interact with other scoring

Context rules are applied after heuristic and semantic scoring:

1. **Heuristic scoring** — file extension, path matching, conversation history
2. **Semantic scoring** — ONNX embedding cosine similarity (if enabled)
3. **Context rules** — prefer/ban/require applied to the blended scores
4. **Top-K selection** — highest-scoring files selected within the context budget
