---
title: SIDECAR.md
layout: docs
nav_order: 8
---

# SIDECAR.md — Project instructions

Create a `SIDECAR.md` file in your project root to give SideCar project-specific instructions that persist across sessions. This is analogous to `CLAUDE.md` for Claude Code.

## Generating with `/init`

Run `/init` in the chat to auto-generate `SIDECAR.md` from your codebase. SideCar scans config files, the file tree, and sample source files to produce a structured project overview. It prioritizes entry-point files (main, index, app, server, cli) and samples from diverse directories for convention detection.

If `CLAUDE.md`, `.claude/CLAUDE.md`, `.github/copilot-instructions.md`, or `AGENTS.md` files exist in your project, `/init` reads them to inform the generated notes. If a `SIDECAR.md` already exists, you'll be asked to confirm before overwriting.

## How it works

SideCar reads `SIDECAR.md` on every message and includes it in the system prompt. The file is cached in memory and automatically invalidated when you save changes (via a file watcher).

## Where to put it

SideCar checks two locations in order:

1. `.sidecar/SIDECAR.md` (preferred — keeps project instructions alongside other SideCar data)
2. `SIDECAR.md` in the workspace root (fallback for backward compatibility)

```
my-project/
  .sidecar/
    SIDECAR.md    <-- preferred location
    specs/
    plans/
    memory/
  src/
  package.json
  ...
```

Or in the root:

```
my-project/
  SIDECAR.md    <-- also works
  src/
  package.json
  ...
```

## Example

```markdown
# Project: My App

## Build
- Run `npm run build` to compile
- Run `npm test` to run tests (Vitest)
- Run `npm run lint` to check code style

## Conventions
- Use TypeScript strict mode
- Prefer async/await over callbacks
- Components go in src/components/
- Tests go in src/__tests__/
- Use conventional commit messages

## Architecture
- Express API in src/server/
- React frontend in src/client/
- Shared types in src/shared/types.ts

## Important
- Never modify migration files after they've been applied
- Environment variables are in .env.example (don't commit .env)
```

## Tips

- **Keep it concise** — the content counts against your context window. Focus on what the AI needs to know, not what it can read from the code.
- **Include build/test commands** — the agent uses these when running tests and fixing errors.
- **List conventions** — coding style, directory structure, naming patterns.
- **Note gotchas** — things the AI might get wrong without guidance (e.g., "use the v2 API, not v1").
- **Update it as you go** — add instructions when the agent makes a mistake you don't want repeated.

## Path-scoped section injection (v0.67+)

For large projects where SIDECAR.md grows beyond 10-15 KB, v0.67 introduced path-aware routing: sections opt-in to scoping via an HTML-comment sentinel immediately under their H2/H3 heading, and SideCar only injects matching sections into the system prompt for each turn. On a small-context local model (4K tokens) this is the difference between 3.7 KB of boilerplate per turn vs. only the relevant 400 bytes.

### The `@paths` sentinel

Add an HTML comment immediately under a section heading with comma-separated glob patterns:

```markdown
## Transforms
<!-- @paths: src/transforms/**, src/dsp/** -->
Filter kernels go under src/transforms/. Naming: fft, dct, dwt.
Always validate the sample rate matches the expected window.

## UI Components
<!-- @paths: src/components/**, src/views/** -->
Use the design-token variables from src/theme/tokens.ts. Prefer
controlled components over uncontrolled.

## Build
- Run `npm test` to verify
- Run `npm run lint` to check style
```

The comment form is invisible in GitHub's markdown preview and other standard renderers, so the file stays human-readable. Sections without a sentinel default to `priority: 'always'` — they always get injected, preserving pre-v0.67 behavior for unannotated files.

Glob syntax:
- `**` — any path depth (including `/`)
- `*` — any run of non-`/` characters (segment wildcard)
- `?` — any single non-`/` character
- Trailing `/` — treated as `/**` (e.g. `src/transforms/` matches everything inside)

### Selector rules

Every injection walks three priority tiers:

1. **Always** — sections without a sentinel + sections whose heading matches `sidecar.sidecarMd.alwaysIncludeHeadings` (default `["Build", "Conventions", "Setup"]`)
2. **Scoped** — sections with a matching `@paths` glob against either the active editor's file path or a path explicitly mentioned in the user's message (via `@file:path` or backtick-quoted paths containing `/`). Capped at `sidecar.sidecarMd.maxScopedSections` (default `5`)
3. **Low** — sections whose heading matches `sidecar.sidecarMd.lowPriorityHeadings` (default `["Glossary", "FAQ", "Changelog"]`) — included only when budget remains

On overflow, whole sections drop in reverse priority order (low first, then scoped, then always) — no more mid-sentence truncation at the budget boundary. The preamble (content before the first H2) always lands verbatim.

### When to use it

Add `@paths` sentinels when:
- Your SIDECAR.md has grown past ~5 KB
- Different conventions apply to different parts of the codebase (e.g. `src/transforms/` has strict numerical stability rules that `src/ui/` doesn't)
- You run SideCar on small-context local models where every token matters

Leave sentinels off when:
- Your SIDECAR.md is tight and globally relevant
- You want strict backward-compat with pre-v0.67 behavior

### Mode override

`sidecar.sidecarMd.mode: 'full'` forces the legacy whole-file behavior regardless of sentinel presence. The default (`sections`) degrades to `full` automatically when the file has zero `@paths` sentinels, so no migration is required.

See [Configuration — SIDECAR.md Path-Scoped Section Injection](configuration#sidecarmd-path-scoped-section-injection-v067) for the config surface.
