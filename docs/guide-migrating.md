---
title: Migrating from Copilot or Claude Code
layout: docs
nav_order: 8
nav_section: "Guides"
---

# Migrating from Copilot or Claude Code

This guide is for developers who are already using GitHub Copilot or Claude Code and want to switch to SideCar. It maps the concepts you already know to their SideCar equivalents and flags the places where SideCar works differently or goes further.

---

## Migrating from GitHub Copilot

### What maps directly

**Inline completions** — SideCar ships Copilot-style FIM (fill-in-the-middle) completions via Ollama or Anthropic. They are opt-in because most users find the agent mode more useful for whole-task work. Enable them with:

```json
"sidecar.enableInlineCompletions": true
```

Tab to accept, Escape to dismiss — same as Copilot.

**Chat panel** — The SideCar sidebar is the direct equivalent of the Copilot chat panel. Open it with `Cmd+Shift+I` / `Ctrl+Shift+I`. Your active file is included in context automatically, just like Copilot.

**Fix / Explain code actions** — When VS Code shows a red or yellow squiggle, press `Cmd+.` / `Ctrl+.` to see **Fix with SideCar** and **Explain this error with SideCar** alongside the built-in Quick Fix entries. **Refactor with SideCar** appears in the Refactor submenu on any selection. This replaces Copilot's code-action suggestions.

**Inline edit (`Cmd+I`)** — Same shortcut as Copilot's inline chat. Select code, press `Cmd+I`, describe the change. SideCar streams the result and shows a side-by-side diff with Accept / Dismiss before touching anything.

**@sidecar in Copilot Chat** — If you keep the Copilot panel open, SideCar registers as a native VS Code chat participant. Type `@sidecar` in the Copilot Chat panel to route a message through your configured backend (Ollama, Anthropic, etc.) without opening the SideCar sidebar. Slash commands `/review`, `/fix`, `/explain`, and `/commit-message` work from there too.

### What is different

**SideCar has a full agent loop; Copilot is primarily completions + chat.** When you give SideCar a task — "add input validation to the user-create endpoint" — it reads files, edits code, runs tests, and iterates until the task is done. It is closer to Copilot Workspace or Cursor than to Copilot Chat. The `sidecar.agentMode` setting controls how autonomously it acts:

| Mode | Behavior |
|------|----------|
| `cautious` (default) | Asks before destructive operations |
| `autonomous` | Runs without interruption |
| `manual` | Requires approval before every tool call |
| `plan` | Drafts a plan for you to approve, then executes |
| `review` | Buffers all writes in-memory; you review the full diff at the end |
| `audit` | Like review but with atomic flush and deletion coverage |

Start with `cautious` — it is the safest onboarding mode and still runs the full agent.

**No Microsoft account required.** SideCar works with a local Ollama model with zero credentials. If you want cloud models, you bring your own API key for Anthropic, OpenAI, Groq, Fireworks, Google Gemini, or OpenRouter. API keys are stored in the OS keychain via VS Code SecretStorage — never in plaintext settings.

**Model is configurable.** You are not locked to one provider's model. Switch mid-conversation with `/model claude-sonnet-4-6` or use the model dropdown at the top of the chat panel.

**No Copilot Workspace equivalent by name — but SideCar agent mode is more powerful.** Copilot Workspace is a task → plan → multi-file edit flow. SideCar's default agent mode does all of that in a single turn, plus runs tests, checks lint, iterates on failures, and has safety modes (shadow workspaces, review mode, audit mode) Copilot Workspace does not.

**Spending visibility.** Copilot costs are baked into your subscription. SideCar tracks per-session spend on paid backends (`/usage`), lets you set daily and weekly budgets (`sidecar.dailyBudget`, `sidecar.weeklyBudget`), and uses Anthropic prompt caching automatically to reduce input token costs by ~90% on cache hits.

### First steps after switching

**1. Set up a backend.**

For zero-cost local use, install [Ollama](https://ollama.com) and pull a model:

```bash
ollama pull gemma4:e4b
```

SideCar auto-detects Ollama at `http://localhost:11434`. No configuration needed.

For cloud: click the gear icon in the chat header, choose **Anthropic Claude** (or another backend), and paste your API key when prompted.

**2. Disable Copilot inline completions if you want SideCar's instead.**

You can run both side-by-side, but you will get duplicate suggestion popups. To use only SideCar's completions:

```json
"github.copilot.editor.enableAutoCompletions": false,
"sidecar.enableInlineCompletions": true
```

If you prefer to keep Copilot completions and only use SideCar for agent tasks, leave `sidecar.enableInlineCompletions` at its default (`false`).

**3. Try a first agent task.**

Open the chat panel (`Cmd+Shift+I`), describe a real task in your current project, and watch the agent run. Use `cautious` mode for the first few tasks so you can see what it does before it writes anything.

---

## Migrating from Claude Code

### What maps directly

**`CLAUDE.md` → `SIDECAR.md`** — Same purpose: project instructions injected into every agent turn. SideCar reads `CLAUDE.md` as a fallback when no `SIDECAR.md` is present, so your existing file works immediately without changes.

When you are ready to take advantage of SideCar-specific features, rename or copy it:

```bash
cp CLAUDE.md .sidecar/SIDECAR.md
```

The main addition in `SIDECAR.md` is path-scoped sections. You can scope a section to inject only when the active file matches a glob:

```markdown
## API Layer
<!-- @paths: src/api/**, src/routes/** -->

All endpoints must validate input with zod before touching the database.
```

Sections without a `@paths` sentinel behave exactly like a `CLAUDE.md` entry — they always inject. Run `/init` to have SideCar generate a `SIDECAR.md` from scratch by scanning your codebase.

**`.claude/commands/*.md` → `.sidecar/skills/*.md`** — SideCar reads both locations. Your existing `.claude/commands/` skills load immediately, no migration required. SideCar scans in this order:

1. Built-in extension skills
2. `~/.claude/commands/*.md` (user-level, Claude Code compatible)
3. `<workspace>/.claude/commands/*.md` (project-level, Claude Code compatible)
4. `<workspace>/.sidecar/skills/*.md` (SideCar native)

Later sources override earlier on name conflict, and a warning is logged when a workspace-level skill shadows a built-in (to guard against a cloned repo hijacking `/review-code`).

**Slash commands** — The commands you use every day have direct equivalents:

| Claude Code command | SideCar equivalent |
|---------------------|-------------------|
| `/review` | `/review` |
| `/commit-message` | `/commit-message` (copy only) or `/commit` (commit + push) |
| `/help` | `/help` |
| `#<file>` mention | Drag file into chat, or click the file pill above the input |
| `/clear` | `Cmd+L` / `Ctrl+L` |
| `/compact` | `/compact` |
| `/model` | `/model <name>` |
| `/pr` | `/pr` |

SideCar has additional slash commands with no Claude Code equivalent: `/fork`, `/arena`, `/bg`, `/notebook`, `/guards`, `/deps`, `/scan`, and others. See [Slash Commands](slash-commands) for the full reference.

**MCP server config** — SideCar reads `.mcp.json` at the workspace root, the same file Claude Code uses. Your existing MCP server definitions work without changes. You can also configure servers in VS Code `settings.json` under `sidecar.mcpServers` — same JSON structure, different key name:

```json
"sidecar.mcpServers": {
  "github": {
    "type": "http",
    "url": "https://api.github.com/mcp",
    "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
  }
}
```

Run `/mcp` in chat to check connection status for all configured servers.

### What is different

**SideCar runs inside VS Code; Claude Code is a terminal CLI.** This is the core structural difference. You get VS Code UI integration — file decorations on pending changes, an activity-bar badge on files the agent has touched, code actions on diagnostics, the Problems panel for security and lint findings, and Test Explorer integration. You lose the ability to invoke it from an arbitrary terminal.

**Model is configurable to local Ollama.** Claude Code requires an Anthropic account and API credits. SideCar runs entirely offline on a local Ollama model. If you want Claude models, you can use them — point SideCar at `https://api.anthropic.com` and paste your API key — but it is not required.

**Skills 2.0 frontmatter extends Claude Code's skill format.** Claude Code recognizes `allowed-tools` and `disable-model-invocation` in skill frontmatter. SideCar parses those fields for compatibility and adds:

- `guards:` — activate built-in regression guards (`lint-clean`, `tests-pass`, `no-new-todos`) for the skill's run
- `preferred-model:` — pin the skill to a specific model (native SideCar field)
- `max-iterations:` — cap the agent loop iteration count for this skill

Fields Claude Code doesn't understand are ignored when the same file is loaded there, so a frontmatter-augmented skill remains compatible with both tools.

**No `~/.claude/CLAUDE.md` global instructions equivalent by the same path.** Claude Code reads `~/.claude/CLAUDE.md` as a global user instruction file. SideCar does not read that path. If you have useful instructions there, copy them into a SideCar user-level skill at `~/.claude/commands/global-instructions.md` (SideCar scans that path) or configure a `SIDECAR.md` section with no `@paths` sentinel in each project.

**Hooks are not config-file-driven yet.** Claude Code supports `hooks` in `.claude/settings.json` to run shell commands before or after tool calls. SideCar's `sidecar.hooks` setting provides pre/post-tool hooks from `settings.json`, but the full `PolicyHook` interface (in-loop steering, blocking turn completion) is only available to first-party code or forks. If you rely heavily on Claude Code hooks for custom behavior, check [Extending SideCar — Policy hooks](extending-sidecar#policy-hooks) for what is and is not available today.

### Migrating your skills

Your existing `.claude/commands/` skills load in SideCar immediately. Nothing to move or rename.

To verify they loaded, type `/` in the chat input and look for your skill names in the autocomplete dropdown. You can also run `/skills` to list all loaded skills and their source paths.

To add SideCar-specific features to an existing skill, copy it to `.sidecar/skills/` and add frontmatter:

**Before (Claude Code compatible, works in both):**

```markdown
---
name: Refactor Module
description: Refactor a module for clarity and performance
---

Refactor the specified module. Preserve existing tests. ...
```

**After (SideCar-enhanced, still loads in Claude Code without error):**

```markdown
---
name: Refactor Module
description: Refactor a module for clarity and performance
guards: lint-clean, tests-pass
preferred-model: claude-sonnet-4-6
---

Refactor the specified module. Preserve existing tests. ...
```

The `guards:` field activates SideCar's regression guard hooks for the duration of this skill's run — the agent cannot finish until lint passes and tests are green. Claude Code parses the frontmatter and ignores unknown keys.

### Feature comparison table

| Feature | Claude Code | SideCar equivalent |
|---------|-------------|-------------------|
| Agent loop | Yes — multi-turn, tool-using | Yes — same pattern, runs inside VS Code |
| Project instructions | `CLAUDE.md` | `SIDECAR.md` (falls back to `CLAUDE.md`) |
| Slash commands | `/review`, `/commit-message`, `/help`, etc. | All of those plus `/fork`, `/arena`, `/bg`, `/notebook`, `/deps`, and more |
| Custom commands / skills | `.claude/commands/*.md` | `.sidecar/skills/*.md` — same format; `.claude/commands/` read directly |
| MCP servers | `.mcp.json` or CLI flag | `.mcp.json` (same file) or `sidecar.mcpServers` in `settings.json` |
| Hooks | `hooks` in settings.json | `sidecar.hooks` for shell hooks; `PolicyHook` interface for in-loop hooks (first-party only) |
| Shadow workspaces | No | Yes — `sidecar.shadowWorkspace.mode: 'always' \| 'opt-in' \| 'off'` |
| Fork & parallel solve | No | `/fork <task>` — N parallel attempts, pick-the-winner diff review |
| Typed sub-agent facets | No | Facets — named specialists with own tool allowlist + preferred model, dispatched in parallel |
| Review mode | No | Yes — buffers all writes in-memory; per-file diff review before anything lands on disk |
| Audit mode | No | Yes — atomic flush, deletion coverage, rollback on partial failure |
| Local / offline | No (requires Anthropic API) | Yes — Ollama, Kickstand, LM Studio, vLLM, llama.cpp, any OpenAI-compat server |
| Model agnostic | No | Yes — Ollama, Anthropic, OpenAI, Fireworks, OpenRouter, Groq, Gemini, Kickstand |

---

## Common questions during migration

**Q: I already pay for Claude Pro/Max. Can I use those credits with SideCar?**

No. Claude Pro and Max are Claude.ai subscription plans for the web/app interface. SideCar uses the Anthropic API, which is a separate billing system. You need an API key from [platform.claude.com](https://platform.claude.com) and separate API credits. If you want to avoid API costs entirely, use a local Ollama model — `gemma4:e4b` or `qwen3-coder:30b` work well for most tasks.

**Q: My CLAUDE.md has hundreds of lines of instructions. Do I need to rewrite it?**

No. SideCar reads `CLAUDE.md` directly as a fallback when no `SIDECAR.md` is present. You can keep using it as-is. If you want path-scoped sections (so front-end instructions only inject when the active file is under `src/ui/`), copy it to `.sidecar/SIDECAR.md` and add `@paths` sentinels to the relevant sections. Everything else is identical format.

**Q: My `.claude/commands/` skills use `allowed-tools` frontmatter from Claude Code's newer formats. Will they break?**

No. SideCar parses `allowed-tools` and `disable-model-invocation` for compatibility and silently ignores them rather than erroring. Your skills load and run normally. The fields just have no enforcement effect in SideCar today — use SideCar's native facets if you need tool-allowlist enforcement per specialist.

**Q: I relied on Claude Code hooks to run `npm test` after every file edit. How do I replicate that?**

Two options depending on strictness. For a lightweight equivalent, add to `settings.json`:

```json
"sidecar.hooks": {
  "write_file": {
    "post": "npm test"
  }
}
```

For strict enforcement that blocks the agent from finishing until tests pass, enable the completion gate (on by default):

```json
"sidecar.completionGate.enabled": true
```

The completion gate re-prompts the agent if it declares done without having run tests for edited files. You can also declare `guards: tests-pass` in a skill's frontmatter to activate the same check only for that skill's runs.

**Q: I want to run SideCar and Claude Code side-by-side on the same project. Is there a conflict?**

No. SideCar reads but does not write `.claude/commands/` or `CLAUDE.md`. Both tools will read the same files independently. The only overlap is `.mcp.json` — both tools read it, neither owns it. If you make MCP changes while both are running, restart both clients to pick up the new config.

**Q: How do I reproduce Claude Code's `/clear` behavior?**

`Cmd+L` / `Ctrl+L` clears the chat history and starts a fresh context. The equivalent from the command palette is `SideCar: Clear Chat`. If you want to save the current session before clearing, run `/save <name>` first — named sessions persist across VS Code restarts and are browsable via `/sessions`.
