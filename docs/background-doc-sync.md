---
title: Background Doc Sync
layout: docs
nav_order: 14
---

# Background Doc Sync

SideCar watches your source files and surfaces documentation drift as VS Code warning diagnostics — the same surface TypeScript and ESLint use. There's no background indexer, no AI call on save, and no round-trip to an external service: every check runs locally as pure string analysis over the files you're editing.

Two features ship today:

- **[JSDoc staleness diagnostics](#jsdoc-staleness-diagnostics)** — flag orphan and missing `@param` tags on every TS/JS file.
- **[README sync](#readme-sync)** — flag fenced code-block calls in `README.md` whose argument count no longer matches the current workspace-exported function.

Both features are on by default. See [Configuration → Background doc sync](configuration#background-doc-sync) for the setting toggles.

## Why both features exist

When you rename a parameter, add a new one, or drop one, the documentation around that function goes stale in three places:

1. **Inside the function's JSDoc block** — `@param` tags that reference the old parameter names.
2. **Inside the README's usage examples** — fenced code blocks that call the function with the old signature.
3. **Inside external OpenAPI / Swagger specs** — out of scope for now, see the [roadmap](https://github.com/nedonatelli/sidecar/blob/main/ROADMAP.md#agent--workflow) for why.

Both JSDoc sync and README sync treat staleness as a warning diagnostic, with quick fixes that rewrite the documentation to match the current signature. Everything runs on-save/on-open with no disk I/O beyond reading the file itself, so there's no noticeable editor lag.

---

## JSDoc staleness diagnostics

### What it flags

For every top-level function declaration — `function foo(...)`, `async function foo(...)`, `const foo = (...) =>`, `export const foo = async (...) =>`, with or without `export` — SideCar parses the leading JSDoc block and compares its `@param` entries against the parameter list.

Two kinds of mismatch surface as warnings:

**Orphan tags** — a JSDoc `@param name` entry exists but the function signature has no matching parameter.

```typescript
/**
 * @param a first
 * @param b removed last week but the tag is still here
 */
function shrunk(a: number) {
  return a * 2;
}
//         ^ warning: @param b — 'b' is no longer a parameter of shrunk()
```

**Missing tags** — a signature parameter exists but the JSDoc has no matching `@param` entry.

```typescript
/**
 * @param a first
 */
function grew(a: number, b: number) {
  return a + b;
}
// ^ warning: grew() has a parameter 'b' with no matching @param tag
```

### Quick fixes

Each diagnostic offers a one-click fix via the VS Code lightbulb.

- **Remove orphan @param** deletes the offending `@param` line cleanly, collapsing the surrounding JSDoc without leaving a blank row.
- **Add missing @param** inserts a new `@param NAME ` line into the JSDoc block. Placement is smart:
  1. If the JSDoc already has other `@param` tags, the new one appears directly after the last existing tag.
  2. Otherwise, if the JSDoc has a `@returns` / `@return` tag, the new `@param` is inserted immediately before it.
  3. Otherwise, it's inserted on the line before the closing comment terminator.
- Both fixes copy the surrounding indentation and leading `*` prefix from the neighboring line, so the block stays visually aligned even in unusual indentation schemes.

### What it deliberately doesn't do

The analyzer is conservative by design:

- **Class methods, interface methods, and object-literal methods are skipped.** These need a real AST to detect reliably, and the cost of misdiagnosing a method call as a function declaration was judged too high for an MVP.
- **Functions with destructured or rest parameters are never flagged.** The tool can't confidently map `{ host, port }: Opts` or `...args: string[]` onto `@param` tags, so it leaves them alone rather than producing noise.
- **Single-line JSDoc blocks (`/** short */`) are recognized but never produce findings.** They can't hold `@param` tags.
- **Functions with a JSDoc block but no `@param` entries are never flagged.** Devs often write description-only JSDoc, and we don't want to pester them to add tags from scratch. Only *stale* tags get reported — you opt into the check by having at least one `@param` entry.

### How the "is this a real @param tag" check works

A common false-positive source: docstrings that *mention* the `@param` tag format as prose, like "inserts a new `@param NAME` line above the closing comment." The regex requires the tag to appear at the start of a JSDoc line after the `* ` prefix, so mid-sentence mentions in descriptive text are ignored.

```typescript
/**
 * Inserts a new @param NAME line into the JSDoc block.
 * ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 * Not flagged — @param is mid-sentence, not at the start of a JSDoc line.
 */
```

### Stale-edit resilience

If the JSDoc block contains multiple findings and the user applies a quick fix to one of them, the subsequent finding's diagnostic range becomes stale (line numbers shift). The quick-fix builder resolves this by looking up the owning function by *name* — extracted from the diagnostic message — rather than by line number. The second fix still lands correctly.

---

## README sync

### What it flags

On save or open of `README.md` (at the workspace root — subdirectory `README.md` files are not checked), SideCar scans every fenced code block tagged `ts`, `tsx`, `js`, `jsx`, `typescript`, or `javascript`. For each top-level call expression inside those blocks, it checks:

1. Is the callee a top-level function or arrow const exported from any file under `src/`?
2. If yes, does the number of arguments in the call match the number of parameters in the current signature?

Calls that fail the arity check surface as warnings.

```markdown
# Usage

Here's how to call `add`:

​```ts
add(1);
​```
```

If `src/math.ts` has `export function add(a: number, b: number): number`, the above code block produces:

> **Warning:** `add() takes 2 arguments but the README passes 1 argument`

### Quick fix

A single quick fix — "Update call to foo() (N arguments)" — rewrites the call to match the signature:

- **Too many arguments:** the trailing arguments are dropped. `add(1, 2, 3)` → `add(1, 2)`.
- **Too few arguments:** the missing parameter names are appended as placeholders. `add(1)` → `add(1, b)`. The user then replaces `b` with a real value.

The edit replaces the entire call expression (from the function name through the closing `)`) so any surrounding formatting — prose, other code on the same line, markdown list structure — is preserved.

### Trigger conditions

Three events refresh the README check:

1. **README.md save or open** — expected behavior, re-runs the check with the current `README.md` contents.
2. **Source file save under `src/`** — SideCar re-scans the saved file, updates the exported-function index, and re-runs the check on any currently-open `README.md`. This catches "I just renamed a parameter, now my docs are wrong" immediately without requiring the user to touch the README first.
3. **File creation / deletion / external change under `src/`** — a `FileSystemWatcher` keeps the index honest when edits come from outside VS Code (e.g., `git checkout` of another branch, a command-line rename).

### The exported-function index

On activation, SideCar walks `src/**/*.{ts,tsx,js,jsx}` (skipping `node_modules`) once and populates an in-memory map from function name to parameter list. Individual entries are refreshed on save rather than rebuilt wholesale, so the cost after the initial scan is limited to the file you just touched.

When multiple files export the same name, the first-scanned definition wins. This is a deliberate simplification — disambiguating by import path would require tracking imports in the README's code blocks, which is significantly more work for a case that rarely matters in practice.

### What it deliberately doesn't do

- **Method calls are ignored.** `obj.foo(...)`, `this.foo(...)`, and `Math.max(...)` never trigger even if `foo` or `max` is a workspace export, because the dot-prefix means the call isn't resolving to the top-level export.
- **Constructor calls are ignored.** `new Foo(...)` never triggers even if `Foo` is a workspace-exported function (it's almost always a class in that case).
- **Control-flow keywords that look like calls are ignored.** `if (x)`, `while (y)`, `for (let i = 0; i < n; i++)`, `switch (z)`, `return (...)` — none of these should ever produce a finding.
- **Functions with destructured or rest parameters never flag.** Arg counting can't reason about `{ host, port }: Opts` or `...args: string[]`, so they're silently skipped.
- **Nested and multi-line calls are skipped.** The MVP uses a simple per-line regex (`identifier(non-paren-chars)`) that doesn't handle `foo(bar())` or multi-line argument lists. Skipping them silently is a deliberate design choice — false negatives are cheaper than false positives for a tool producing user-facing diagnostics.
- **Inline-backtick code spans (`` `foo(x, y)` ``) are not checked.** Only fenced code blocks.
- **Subdirectory README files are not checked.** Only the workspace-root `README.md`.

### Stale-edit resilience

Same mechanism as JSDoc sync: the quick-fix builder looks up the owning function by name from the diagnostic message rather than by declaration line, so fixes still resolve correctly after an earlier edit in the same file shifted line numbers.

---

## Disabling the features

Both features have individual toggles in VS Code settings:

```json
{
  "sidecar.jsDocSync.enabled": false,
  "sidecar.readmeSync.enabled": false
}
```

Toggling either setting takes effect immediately — no reload required. Diagnostics are cleared from the affected files when the feature is turned off, and re-run on the next save / open when it's turned back on.

## Performance notes

Both analyzers are pure string parsing with no AST, no network calls, and no disk I/O beyond reading the file being analyzed. On a mid-sized file they typically finish in well under a millisecond. The README sync's exported-function index does one workspace scan at activation time, bounded by the `**/node_modules/**` exclusion — expect it to complete in 10–50ms for a typical SideCar-sized project.

## Roadmap

Swagger / OpenAPI sync was the third planned member of this feature family but is deferred. The roadmap's [Background doc sync](https://github.com/nedonatelli/sidecar/blob/main/ROADMAP.md#agent--workflow) line now notes 2/3 complete, with Swagger pending a real-world project using it as a test bed. The mapping from TypeScript function signatures to OpenAPI operations is fundamentally framework-specific (Express / Fastify / NestJS / tsoa / tRPC each express it differently), so a generic implementation is both harder to build and narrower in reach than JSDoc or README sync.
