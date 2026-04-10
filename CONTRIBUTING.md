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
| `agent/tools.ts` | Tool registry, definitions, and executors |
| `agent/executor.ts` | Tool approval flow, permission checks, special tool routing |
| `agent/loop.ts` | Main agent iteration loop with streaming callbacks |

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
