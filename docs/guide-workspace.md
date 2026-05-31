---
title: Setting Up Your Workspace
layout: docs
nav_order: 18
---

# Setting Up Your Workspace

Out of the box, SideCar works on any codebase — but it works generically. It doesn't know your build commands, it doesn't know that `src/generated/` is off-limits, and it has no idea that your team uses a specific error-handling pattern. This guide covers the five steps that turn SideCar from a capable generalist into a specialist for your codebase.

## Why setup matters

Every agent turn is bounded by a context window. Without setup, that window is filled by whatever files SideCar's relevance scorer picks, a generic system prompt, and whatever the model already knows. With good setup:

- The agent knows how to build, test, and lint your project without guessing.
- Domain conventions land in the system prompt on every turn rather than being inferred hit-or-miss.
- The vector index knows your symbol graph, so "find where auth is validated" hits the right callsites immediately.
- Risky tasks run inside Shadow Workspaces where mistakes never touch your main tree.
- Context budget is spent on relevant code, not build artifacts.

Five minutes of setup saves hours of corrective prompting.

---

## Step 1: Create SIDECAR.md

`SIDECAR.md` is the single most impactful thing you can add. SideCar reads it on every message and injects it into the system prompt. It's your standing instructions to the agent — build commands, conventions, architecture notes, and no-go paths.

### Where to put it

Preferred location is `.sidecar/SIDECAR.md` (alongside other SideCar data). The workspace root (`SIDECAR.md`) also works.

### Generate it automatically

Run `/init` in chat. SideCar scans your file tree, entry-point files, and existing instruction files (`CLAUDE.md`, `.github/copilot-instructions.md`, `AGENTS.md`) to produce a structured first draft. Review and edit the output — the generator gives you the shape; you fill in the gotchas.

### What to include

**Build and test commands.** The agent runs these constantly. If it has to guess, it will guess wrong about your flags.

**Coding conventions.** Import ordering, error handling style, naming patterns, preferred utilities. The agent applies these when writing new code.

**Architecture notes.** Which directories own what. Where shared types live. What the API boundary is. You don't need prose — bullet lists work fine.

**No-go paths.** Files or directories the agent must never modify. Applied migrations, generated protobufs, vendored snapshots, lock files. Be explicit.

**Known gotchas.** "Use the v2 API, not v1." "The `db` package uses raw SQL — don't add an ORM." These are the instructions you'd give a new teammate on their first day.

### Realistic example — TypeScript monorepo

```markdown
# Project: acme-platform

## Build
- `pnpm run build` — compile all packages (turborepo, cached)
- `pnpm run test` — run all tests (Vitest, co-located with source)
- `pnpm run lint` — ESLint + Prettier check
- `pnpm run typecheck` — `tsc --noEmit` across the workspace
- `pnpm --filter @acme/api run dev` — start the API dev server

## Conventions
- TypeScript strict mode everywhere; no `any`
- `.js` extensions on all imports (NodeNext resolution)
- Zod schemas in `src/schemas/`; inferred types from schema, never hand-written duplicates
- Tests co-located with source: `foo.ts` → `foo.test.ts`
- Conventional commit messages: `feat:`, `fix:`, `chore:`, `docs:`
- Errors are typed discriminated unions — never `throw new Error('...')` in library code

## Architecture

<!-- @paths: packages/api/** -->
API package (`packages/api/`) is an Express app. Routes in `src/routes/`, middleware in
`src/middleware/`. Shared request context flows via `AsyncLocalStorage` in `src/context.ts`.
DB access goes through `src/db/` only — never import `pg` directly in routes.

<!-- @paths: packages/ui/** -->
UI package (`packages/ui/`) is React + Vite. Design tokens from `src/theme/tokens.ts`.
Use `cn()` from `src/lib/utils.ts` for conditional class names (Tailwind).
All data fetching via React Query hooks in `src/hooks/`.

<!-- @paths: packages/shared/** -->
Shared types and utilities in `packages/shared/`. Anything used by both API and UI lives here.
Entry point is `packages/shared/src/index.ts` — don't import internal paths directly.

## No-go zones
- Never modify files under `packages/*/src/generated/` — these are auto-generated from Protobuf
- Never edit `pnpm-lock.yaml` manually
- Never add dependencies to `packages/shared` without team review
- `migrations/` — applied migrations are immutable; only add new files, never edit existing ones

## Gotchas
- Use `packages/api/src/errors.ts` for error types — do not invent new error classes
- Feature flags live in `packages/shared/src/flags.ts`; check there before building conditional logic
- Tests that need a DB use the `withTestDb` helper from `packages/api/src/test/db.ts`, not manual setup
```

### Path-scoped sections

Once your `SIDECAR.md` grows past ~5 KB, the whole file starts eating context budget on every turn — even when the agent is editing a UI file and the API notes are irrelevant. Path-scoped sections fix this.

Add an HTML comment with glob patterns immediately under any section heading:

```markdown
## API Routes
<!-- @paths: packages/api/src/routes/**, packages/api/src/middleware/** -->
Routes follow the pattern in `src/routes/health.ts`. Use the `requireAuth` middleware
for every protected endpoint. Input validation goes through the Zod schema at the top
of each route file.

## Database
<!-- @paths: packages/api/src/db/**, migrations/** -->
Raw SQL via `pg`. Query files in `src/db/queries/`; use named parameters only.
Never write inline SQL in route handlers.
```

Sections without a sentinel inject on every turn (`always` priority). Sections with a sentinel inject only when the active editor file or a path mentioned in your message matches the glob. This keeps the system prompt tight on small-context local models.

Glob syntax: `**` matches any depth, `*` matches a non-slash segment, trailing `/` expands to `/**`.

If your file has 20+ sections and path routing is still too coarse, switch to retrieval mode:

```json
"sidecar.sidecarMd.mode": "retrieval"
```

In retrieval mode, `always`-priority sections inject verbatim and all other sections compete in the RRF fusion pipeline by semantic similarity to your query. SideCar embeds each section body with MiniLM-L6-v2 and persists the index to `.sidecar/cache/sidecarMd/`.

---

## Step 2: Enable the Project Knowledge Index

The Project Knowledge Index (PKI) gives the agent symbol-level semantic search across your codebase. Instead of reading whole files, it can run `project_knowledge_search("authentication token validation")` and get back the exact functions — plus their callers via a symbol-graph walk — scored by cosine similarity.

### What it does

On first activation, SideCar uses tree-sitter to parse every source file in your workspace and extracts function and class declarations. Each symbol's body is embedded with MiniLM-L6-v2 (384 dimensions) and stored in `.sidecar/cache/`. Subsequent activations only re-embed symbols whose content changed.

When the agent needs to understand how something works across the codebase, it calls `project_knowledge_search`. The retriever scores against the vector store, then walks the symbol graph outward from each hit (callers, dependents) to surface dependency-coupled context that pure embedding search misses.

### Enabling it

PKI is on by default (`sidecar.projectKnowledge.enabled: true`). To trigger an immediate full index, open the Command Palette and run `SideCar: Rebuild Project Knowledge Index`. Incremental updates happen automatically as you save files.

### Settings that matter

```json
"sidecar.projectKnowledge.enabled": true,
"sidecar.projectKnowledge.graphWalkDepth": 2,
"sidecar.projectKnowledge.maxGraphHits": 10,
"sidecar.projectKnowledge.maxSymbolsPerFile": 500
```

`graphWalkDepth: 2` means the retriever follows call edges two hops out from each hit. On a large codebase, `1` keeps results tighter; on a small one, `2` surfaces useful coupling. `maxSymbolsPerFile: 500` prevents auto-generated files (OpenAPI clients, protobuf outputs) from monopolising the embedder queue — combine this with `.sidecarignore` (see Step 4) to exclude generated directories entirely.

Enable the Merkle index (on by default) to speed up large-codebase searches:

```json
"sidecar.merkleIndex.enabled": true
```

The Merkle tree prunes candidate files by comparing mean-pooled subtree embeddings before scoring individual symbols — significant speedup when your workspace has thousands of source files.

For query quality, the default `"rule"` rewrite mode strips preambles and expands camelCase before embedding. If you want higher recall at the cost of one extra LLM call per turn, try `"expand"`:

```json
"sidecar.retrieval.queryRewrite": "expand"
```

---

## Step 3: Pin critical context

Pinning is for files the agent needs on every single turn, regardless of what it's working on: your central types file, your auth module, your error taxonomy. Pinned entries inject into the system prompt before the RAG budget is applied and survive context compaction.

### Three ways to pin

**`sidecar.pinnedContext` in settings** — files and folders always included in workspace context:

```json
"sidecar.pinnedContext": [
  "src/types.ts",
  "src/errors.ts",
  "packages/shared/src/index.ts"
]
```

**`@pin:` in chat** — pin a file for the current session and all future sessions without leaving chat:

```
@pin:src/auth/middleware.ts

Now add rate limiting to the /api/login route.
```

**`/memories` panel** — the Pinned Memory sidebar lets you pin files with optional heading filters and a boost value. The boost controls injection order: a pin with `boost: 2.0` lands before one at the default `1.0`.

### When to use each

| Mechanism | Best for |
|-----------|----------|
| `sidecar.pinnedContext` | Team-wide shared files; check into `.vscode/settings.json` |
| `@pin:` in chat | Files you realize mid-session should always be present |
| `/memories` panel | Per-entry boost tuning; pinning specific H2 sections of a large file |

### Pinned Memory vs. SIDECAR.md

Use `SIDECAR.md` for instructions and conventions — prose that tells the agent how to behave. Use pinned memory for content — actual source code, type definitions, schema files — that the agent needs to read, not just follow. A good test: if you'd quote it directly in a prompt ("here's the auth interface — now..."), pin it. If you'd describe it as a rule ("always use X pattern"), put it in `SIDECAR.md`.

### Example: pin the types file

Your central types file is referenced in nearly every task. Pin it:

```
@pin:src/types.ts
```

Now every turn starts with the full type catalog in context. The agent will use your existing types instead of inventing new ones.

### Example: pin with a heading filter

If your shared utilities file is large but only one section is universally relevant, pin just that section:

Open the `/memories` panel → Add Pin → enter `src/utils.ts` → under Heading filter, enter the H2 heading name (e.g., `Error Handling`). Only that section injects.

---

## Step 4: Configure context scope

### File patterns

By default, SideCar indexes 25+ file extensions. If your repo has types SideCar doesn't know (`.graphql`, `.prisma`, custom DSLs), add them:

```json
"sidecar.filePatterns": [
  "**/*.ts", "**/*.tsx", "**/*.js",
  "**/*.graphql", "**/*.prisma",
  "**/*.py", "**/*.go"
]
```

`maxFiles` controls how many files land in workspace context per turn (default 10). On a large codebase with good PKI coverage, you can lower this and let semantic search do the heavy lifting:

```json
"sidecar.maxFiles": 6
```

### .sidecarignore

Create `.sidecarignore` in your workspace root using `.gitignore` syntax to exclude build artifacts, generated code, and dependencies from indexing:

```
# Build outputs
dist/
build/
.next/
out/
coverage/

# Generated files — never let the agent edit these
src/generated/
packages/*/src/generated/
proto-generated/

# Dependencies
node_modules/
.pnpm-store/
venv/
__pycache__/

# Large assets
**/*.jpg
**/*.png
**/*.mp4
public/fonts/
```

Patterns here merge with SideCar's built-in excludes (`.git`, `.sidecar`, `node_modules`). The exclusion applies to both context inclusion and PKI indexing — so generated files don't flood your semantic search results either.

### Monorepo: focus with workspaceRoots

In a large monorepo, SideCar indexes every workspace folder by default. If you're working on one package for an extended period, tell SideCar to focus:

```json
"sidecar.workspaceRoots": [
  "/absolute/path/to/your/repo/packages/api",
  "/absolute/path/to/your/repo/packages/shared"
]
```

This restricts file indexing, context inclusion, and PKI embedding to the listed roots. The agent can still read files outside these roots on demand — it just won't proactively include them.

### Large file handling

Files over 50 KB use summary mode (first 50 + last 30 lines) instead of full content. You can tune the threshold or raise the absolute cap:

```json
"sidecar.streamingReadThreshold": 51200,
"sidecar.maxFileSizeBytes": 204800
```

Raise `maxFileSizeBytes` only if you have large files the agent genuinely needs to read in full (e.g., a 200 KB schema file). Most large files are better handled via PKI symbol search than full inclusion.

### Depth limiting

On projects with deep nesting (e.g., deeply nested monorepo `node_modules` or test fixture trees), lower the traversal depth to cut startup time and reduce noise:

```json
"sidecar.maxTraversalDepth": 6
```

---

## Step 5: Set your safety level

### Agent mode

`sidecar.agentMode` controls how much the agent can do without asking you first:

| Mode | Behavior | Use when |
|------|----------|----------|
| `cautious` (default) | Asks before file writes and shell commands | New codebases; exploratory tasks |
| `autonomous` | Executes without interruption | You trust the task; want hands-off runs |
| `manual` | Asks before every single tool call | Auditing agent behavior; learning a codebase |
| `review` | Buffers all file writes in memory; presents a diff at the end | Batch changes you want to review before anything lands |
| `plan` | Generates a written plan for approval before executing any tools | Complex multi-file changes; want to verify scope first |

For most development work, start with `cautious`. Switch to `autonomous` once you've seen the agent handle your codebase well.

### Shadow Workspaces for risky tasks

For tasks that touch many files or make structural changes, enable Shadow Workspaces:

```json
"sidecar.shadowWorkspace.mode": "opt-in"
```

In `opt-in` mode, you select shadow isolation per task from the command palette or chat. In `always` mode, every agent task runs in a shadow. Either way, the agent writes to an ephemeral git worktree at `.sidecar/shadows/<task-id>/` off your current `HEAD`. Your main tree is untouched until you explicitly accept the diff at the end.

Use `always` for:
- Refactors that touch 20+ files
- Dependency upgrades
- Automated mode tasks you're running unattended

Use `opt-in` for:
- Normal development where you want shadow isolation on demand
- Any task you're not sure about before running it

```json
"sidecar.shadowWorkspace.mode": "always",
"sidecar.shadowWorkspace.autoCleanup": true
```

### Completion gate

The completion gate is on by default and does one thing: it refuses to let the agent declare a task done if it edited a file without running the colocated tests or lint. This catches the most common failure mode — the model says "done" after editing code it never validated.

```json
"sidecar.completionGate.enabled": true
```

If you're on a project where tests and lint are slow, the gate still fires — but it caps at two injections per turn to prevent loops.

### Regression guards

For stronger guarantees, add regression guards. Guards run shell commands after file writes and block the turn when they fail:

```json
"sidecar.regressionGuards": [
  {
    "name": "lint",
    "command": "npm run lint",
    "trigger": "post-write",
    "mode": "blocking",
    "scope": ["src/**/*.ts", "src/**/*.tsx"],
    "maxAttempts": 5
  },
  {
    "name": "typecheck",
    "command": "npm run typecheck",
    "trigger": "pre-completion",
    "mode": "blocking",
    "scope": [],
    "maxAttempts": 3
  }
]
```

`post-write` guards fire after every file write. `pre-completion` guards fire when the agent tries to wrap up. `blocking` mode injects a reprompt when the command fails; `advisory` logs but lets the turn continue.

### Auto-fix diagnostics

Enable `autoFixOnFailure` to feed VS Code diagnostics back to the model automatically after edits:

```json
"sidecar.autoFixOnFailure": true,
"sidecar.autoFixMaxRetries": 3
```

This is complementary to regression guards — guards run your custom commands, auto-fix responds to language-server diagnostics (TypeScript errors, ESLint inline errors).

---

## Checklist

Use this to verify your workspace setup is complete before running your first real agent task.

- [ ] `SIDECAR.md` exists at `.sidecar/SIDECAR.md` or the workspace root with build commands, conventions, and no-go paths filled in
- [ ] All section headings in `SIDECAR.md` that apply to specific directories have `<!-- @paths: glob -->` sentinels
- [ ] `sidecar.projectKnowledge.enabled` is `true` and you've run `SideCar: Rebuild Project Knowledge Index` at least once
- [ ] `.sidecarignore` excludes `dist/`, `build/`, generated directories, and any large binary assets
- [ ] `sidecar.pinnedContext` includes your central types file and any always-needed interfaces
- [ ] `sidecar.filePatterns` includes any project-specific extensions (`.graphql`, `.prisma`, etc.)
- [ ] `sidecar.workspaceRoots` is set if you're in a monorepo and want to focus on specific packages
- [ ] `sidecar.agentMode` is set to the level of autonomy you want (`cautious` is the safe default)
- [ ] `sidecar.completionGate.enabled` is `true`
- [ ] `sidecar.shadowWorkspace.mode` is `opt-in` or `always` for any task that modifies more than a handful of files
