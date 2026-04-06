---
title: SIDECAR.md
layout: default
nav_order: 8
---

# SIDECAR.md — Project instructions

Create a `SIDECAR.md` file in your project root to give SideCar project-specific instructions that persist across sessions. This is analogous to `CLAUDE.md` for Claude Code.

## How it works

SideCar reads `SIDECAR.md` on every message and includes it in the system prompt. The file is cached in memory and automatically invalidated when you save changes (via a file watcher).

## Where to put it

Place it in the root of your workspace:

```
my-project/
  SIDECAR.md    <-- here
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
