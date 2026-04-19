# Contributing to SideCar

## Development setup

```bash
git clone https://github.com/nedonatelli/sidecar.git
cd sidecar
npm install
npm run compile   # TypeScript compilation
npm run test      # Run all tests
```

## Project structure

```
src/
  agent/          # Agent loop, tool executor, sub-agents, memory, skills
  config/         # Settings, workspace index, constants, trust, reachability
  ollama/         # LLM backends (Ollama, Anthropic, OpenAI, Kickstand)
  webview/        # Chat UI handlers, state management, webview HTML
  terminal/       # Shell session management
  github/         # GitHub API and auth
  edits/          # Diff preview, inline edit providers
media/
  chat.js         # Webview frontend (vanilla JS)
  chat.css        # Webview styles
  mermaid.min.js  # Mermaid diagram renderer
skills/           # Built-in skill definitions (markdown)
docs/             # Documentation site (GitHub Pages)
scripts/          # Automation scripts
```

## Key internal modules

| Module | Purpose |
|--------|---------|
| `config/constants.ts` | Centralized magic numbers (token estimation, context budgets, limits) |
| `config/workspaceTrust.ts` | Per-session trust decisions for workspace-level configs |
| `config/providerReachability.ts` | Health check for all LLM provider types |
| `agent/tools/` | Tool registry, definitions, and executors — `tools.ts` is a thin composer over per-subsystem files (`fs`, `search`, `shell`, `git`, `diagnostics`, `knowledge`, `settings`) |
| `agent/executor.ts` | Tool approval flow, permission checks, special tool routing |
| `agent/loop.ts` + `agent/loop/` | Main agent iteration loop. `loop.ts` is a thin 255-line orchestrator; every responsibility (state, compression, streaming, cycle detection, tool execution, policies, finalization) lives in a focused helper under `agent/loop/` |

## Running tests

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
npm run check         # Compile + lint + test
```

## Version bumping

Use the automated bump script to update the version across all files:

```bash
npm run bump 0.40.0 "brief summary of what changed"
```

This script:
1. Runs the test suite and captures pass counts
2. Counts tools and skills from source code
3. Updates `package.json`, `CHANGELOG.md`, `ROADMAP.md`, `README.md`
4. Updates `docs/index.html` (landing page stats), `docs/agent-mode.md`, `docs/troubleshooting.md`
5. Prints a summary for review before committing

After running the script, review the CHANGELOG entry and expand it with proper sections (Added, Fixed, etc.) before committing.

## Release checklist

Every version bump is a content change, not just a number change. The bump script handles the mechanical updates (version strings, stat counts, landing-page stats); feature-level documentation sync is manual and must be done **before** tagging. Run through this list in order:

### Content sync (manual — required)

For every feature, config key, command, slash command, or user-visible behavior change shipped in the release, verify each doc is accurate. If the release added a feature to a subsystem the doc covers, update the doc:

| Surface | When to update |
| --- | --- |
| `README.md` "Features" section | Any user-visible capability added or meaningfully changed. Add a dated `*(new in vX.Y)*` bullet rather than silently editing an existing one. |
| `docs/overview.md` | Any headline feature. The overview is the first thing a new user reads — headline features missing from it are invisible. |
| `docs/slash-commands.md` | Any new `/command` or `SideCar: <Command>` palette entry. |
| `docs/agent-mode.md` | Any new agent mode, approval tier, dispatch mechanism, or tool surface. |
| `docs/configuration.md` | Any new `sidecar.*` setting. New config keys without a docs entry are unsupported; list them with defaults, clamp ranges, and a one-line description of what they control. |
| `docs/extending-sidecar.md` | Any new extension surface (a new way for third parties to add skills, facets, tools, MCP servers, hooks, or SDK contributions). |
| `docs/hooks-and-tasks.md` | Any change to `sidecar.hooks`, `sidecar.eventHooks`, or `sidecar.scheduledTasks` semantics. |
| `docs/rag-and-memory.md` | Any retrieval, memory, or context-injection change. |
| `docs/security-scanning.md` | Any secrets-pattern catalog update, new vulnerability detector, or trust-model change. |
| `docs/mcp-servers.md` | Any change to MCP transport handling, lifecycle, or tool surface. |
| `CLAUDE.md` | Any architectural change: new subsystem under `src/`, new major integration point, new config-layer concern. Future AI collaborators read CLAUDE.md before they read any other doc. |
| `ROADMAP.md` | Flip the shipping release entry to `✅ *shipped YYYY-MM-DD*` format with Features shipped / Refactor beat shipped / Coverage ratchet / Tag lines; list deferrals folded into a new `vX.Y deferrals folded into vX.Z+` block. |

### Sanity check (quick)

Before tagging, run:

```bash
grep -l "vX.Y\|<headline feature name>" docs/ README.md CLAUDE.md ROADMAP.md
```

If the headline feature of the release doesn't appear in at least `docs/overview.md`, `README.md`, and the feature's subsystem doc, the release isn't ready to tag.

### Automated checks (CI)

- `npm run check` (compile + lint + test) must pass on main before the release commit.
- The publish workflow (`.github/workflows/publish.yml`) runs on tag push. Don't push the tag until `npm run check` is green locally.
- A format drift in a new test file or doc will cause CI's format-check job to fail even if Publish succeeds — run `npx prettier --check 'src/**/*.ts'` locally before committing.

### Why this matters

In v0.66 the Typed Sub-Agent Facets feature shipped without appearing in `docs/overview.md`, `docs/slash-commands.md`, `docs/agent-mode.md`, or `docs/configuration.md` — a user who only reads the docs would have no idea the feature existed. The docs-sync step is the difference between "we shipped" and "users can find it."

## Building and packaging

```bash
npm run build     # Compile TypeScript + bundle + copy grammars
npm run package   # Build + create .vsix package for distribution
```

## Adding a new tool

1. Define the tool schema in `src/agent/tools.ts` (follow existing patterns)
2. Implement the executor function
3. Add to `TOOL_REGISTRY` array
4. If the tool needs approval, set `requiresApproval: true`
5. If the tool needs special handling (like `ask_user`), add a case in `executor.ts`
6. Add tests in the appropriate `.test.ts` file
7. Update `docs/agent-mode.md` tool table and `README.md` tool registry
8. Run `npm run bump` to update tool counts everywhere

## Code style

- TypeScript strict mode
- No unnecessary abstractions — three similar lines > premature helper
- Use `constants.ts` for magic numbers, not inline values
- Validate at system boundaries (user input, LLM output), trust internal code
- Security: always sanitize paths, never auto-approve tools without UI
