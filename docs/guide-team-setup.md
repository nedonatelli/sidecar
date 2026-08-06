---
title: Team Setup
layout: docs
nav_order: 5
nav_section: 'Guides'
---

# Team Setup

This guide is for the person setting up SideCar across a team of 3–10 developers. It covers what to check into the repo, what to keep per-machine, and how to distribute skills, facets, and policy to every developer automatically.

## What you can and cannot share

Some SideCar configuration belongs in the repo and flows to every developer via git. Other configuration is per-machine and must never be committed.

**Check into the repo — every developer gets it automatically:**

| Path                        | What it does                                        |
| --------------------------- | --------------------------------------------------- |
| `.sidecar/SIDECAR.md`       | Project instructions injected into every agent turn |
| `.sidecar/skills/*.md`      | Project-scoped slash-command skills                 |
| `.sidecar/facets/*.md`      | Specialist sub-agents for this project              |
| `.sidecar/team-memory/*.md` | Shared context injected as `## Team Memory`         |
| `.sidecar/policy.json`      | Tool restrictions that apply to every developer     |

**Per-machine only — never commit:**

- API keys (stored in VS Code's SecretStorage, never written to `settings.json`)
- `sidecar.model`, `sidecar.baseUrl`, `sidecar.provider` — each developer picks their own backend
- `sidecar.agentMode` preference
- `sidecar.dailyBudget` / `sidecar.weeklyBudget` — personal cost controls
- `.vscode/settings.json` if it contains `sidecar.apiKey` (migrate away from this immediately — see [API key storage](configuration#api-key-storage-secretstorage))

The `.sidecar/` directory top-level is tracked. Ephemeral subdirs — `cache/`, `memory/`, `sessions/`, `logs/`, `scratchpad/`, `shadows/` — are gitignored by default and should stay that way.

---

## Shared project instructions (SIDECAR.md)

The most impactful thing you can do for your team is write a good `.sidecar/SIDECAR.md` and commit it. Every developer who opens the repo gets the same agent behavior without any setup.

Create the file:

```bash
mkdir -p .sidecar
touch .sidecar/SIDECAR.md
```

Or generate a starter with `SideCar: Generate SIDECAR.md` from the Command Palette — it scaffolds sections from your existing `README.md` and package manifests.

### Sections every team should include

**Build and test commands** — tell the agent exactly how to build, lint, and test in this repo:

```markdown
## Build

npm run build # compile + bundle
npm run check # compile + lint + test (full CI check)
npx vitest run # run tests only
```

**PR and commit conventions** — stops the agent from doing the wrong thing silently:

```markdown
## PR Conventions

- Branch names: feat/<ticket>-<slug>, fix/<ticket>-<slug>
- Commit messages follow Conventional Commits (feat, fix, chore, docs, test, refactor)
- Every PR needs a test that would have caught the bug or covers the new code path
- Never force-push to main. Open a PR.
```

**No-go paths** — files the agent should read but never write:

```markdown
## No-go Paths

- `src/generated/**` — auto-generated, do not edit by hand
- `migrations/**` — write new migrations, never edit existing ones
- `.env*` — never write or read secrets files
```

**Architecture notes** — key decisions the agent needs to respect:

```markdown
## Architecture

- All API calls go through `src/lib/apiClient.ts`. Do not use `fetch` directly.
- State is managed with Zustand. Do not introduce Redux or Context for state.
- Database queries use Kysely. Do not write raw SQL outside of migration files.
- Error boundaries are in `src/components/ErrorBoundary.tsx`. Wrap new top-level routes.
```

### Path-scoped sections (v0.67+)

For larger codebases, scope sections to specific file patterns so the agent only receives relevant context. Add a `<!-- @paths: glob -->` sentinel immediately below the heading:

```markdown
## API Layer

<!-- @paths: src/api/**, src/lib/apiClient.ts -->

All server communication flows through `apiClient.ts`. Use the typed wrappers
in `src/api/` rather than calling `apiClient` directly.

## Database

<!-- @paths: src/db/**, migrations/**, knexfile.ts -->

Use Kysely for all queries. Migration files live in `migrations/` and are
numbered sequentially. Never edit an existing migration.
```

Sections without a sentinel are always included. Sections with a `<!-- @paths: -->` sentinel inject only when the active file or a mentioned path matches the glob. Set `sidecar.sidecarMd.mode` to `retrieval` for files with 20+ sections — SideCar will score sections semantically rather than by path match.

---

## Shared skills

Skills are markdown files that inject into the system prompt when a developer types `/skill-name` in chat. Project-scoped skills live in `.sidecar/skills/*.md` and are loaded automatically for every developer who has the repo open.

Create `.sidecar/skills/review-code.md`:

```markdown
---
name: Review Code
description: Review code against our team checklist
guards: lint-clean, tests-pass
preferred-model: claude-sonnet-4-6
allowed-tools: read_file, grep, list_directory, run_tests
---

Review the code in the current context against this team checklist:

**Correctness**

- All error paths handled explicitly — no silent swallows
- Null/undefined checked before use
- No off-by-one errors on slice/splice/index operations

**Security**

- No secrets or credentials in strings or comments
- User input validated before it reaches SQL, shell, or file paths
- Auth checks present on any new route or endpoint

**Consistency**

- Follows the patterns in src/lib/ — no new abstractions for problems we've already solved
- Named and structured like adjacent code in the same directory
- JSDoc on exported functions

Output: bullet list grouped by severity (Critical / Warning / Note).
```

The `guards:` frontmatter activates the `lint-clean` and `tests-pass` built-in guards for the duration of this skill's agent turn, so the agent won't declare the review done if lint or tests are failing. `allowed-tools` restricts the agent to read-only tools — this skill can never write files.

### Creating skills

Create a skill by writing a markdown file with the frontmatter shown below — for project-scoped skills, save it under `.sidecar/skills/`. (Related palette commands: `SideCar: Pick Skill`, `Sync Skill Registries`, `Publish Skill to Registry`, `Browse Skill Marketplace`.)

### Skills 2.0 frontmatter fields

```markdown
---
name: My Skill
description: Shown in the slash-command picker and autocomplete
preferred-model: claude-sonnet-4-6 # pin a model for this skill's run
allowed-tools: read_file, grep, edit_file # restrict what the agent can call
disable-model-invocation: false # set true to inject prompt only, no agent loop
guards: lint-clean, tests-pass # run built-in guards after every write
---
```

`allowed-tools` is especially useful for review or analysis skills where you want the agent to read but never write.

---

## Skills registry (v0.112+)

Starting in v0.112, you can distribute skills via a git repository rather than committing them into every project. This is the right choice for skills shared across multiple repos, or for user-level defaults you want consistent across machines.

### Set up a team skill repo

Create a new git repo (e.g. `github.com/your-org/sidecar-skills`) and add skills as `.agent.md` files:

```
sidecar-skills/
  review-code.agent.md
  write-tests.agent.md
  explain-error.agent.md
  squash-commits.agent.md
```

Commit and push. Standard git auth applies — SSH keys or HTTPS tokens.

### Point developers at the registry

In workspace settings (`.vscode/settings.json`) or user settings:

```json
{
  "sidecar.skills.teamRegistries": ["git@github.com:your-org/sidecar-skills.git"],
  "sidecar.skills.autoPull": "on-start",
  "sidecar.skills.trustedRegistries": ["git@github.com:your-org/sidecar-skills.git"]
}
```

`teamRegistries` is an array — you can have multiple registries (e.g. one for the whole org, one for a specific team). Skills from each registry are tagged by origin in the Skills Picker UI so developers know where a skill came from.

`trustedRegistries` skips the first-install consent prompt for registries your team controls. Leave it empty if you want every developer to be prompted before a new registry's skills load for the first time — that prompt shows the full frontmatter and source link.

`autoPull: "on-start"` refreshes every registry on VS Code activation. Set it to `"manual"` if you want developers to run `SideCar: Sync Skill Registries` explicitly — useful in air-gapped environments or when you want to control when updates propagate.

For air-gapped CI or environments with no outbound internet access:

```json
{
  "sidecar.skills.offline": true
}
```

This disables all registry sync network calls. The loader reads only from whatever was cached on the last successful pull.

---

## Shared facets

Facets are specialist sub-agents — each one runs the full agent loop with its own model, tool allowlist, and system prompt inside an isolated Shadow Workspace. Project-local facets live in `.sidecar/facets/*.md`.

Use facets when you want the specialist's constraints enforced, not just a different voice in the prompt. A facet configured with `toolAllowlist: ["read_file", "grep"]` physically cannot write files — the dispatcher enforces it.

### Example: security reviewer facet

Create `.sidecar/facets/security-reviewer.md`:

```markdown
---
id: security-reviewer
displayName: Security Reviewer
preferredModel: claude-sonnet-4-6
toolAllowlist: ['read_file', 'grep', 'list_directory', 'web_search']
dependsOn: []
---

You are a security reviewer for this codebase. Your scope:

**Always check:**

- Authentication and authorization: missing auth checks, privilege escalation paths
- Input handling: SQL injection, path traversal, shell injection via unsanitized inputs
- Secrets: hardcoded credentials, API keys in source, keys committed to git
- Dependency vulnerabilities: check imports against the OSV database
- Cryptography: weak algorithms (MD5, SHA1 for passwords), short key lengths, ECB mode

**Our threat model:**

- This is a multi-tenant web app. Each tenant's data must be isolated.
- Auth is handled in `src/middleware/auth.ts`. Any new route that bypasses this middleware is a finding.
- The database user has write access. SQL injection means full data breach.

**Output format:**
Each finding: severity (Critical / High / Medium / Low), location (file:line), description, recommended fix.
End with a summary table.
```

This facet overrides the built-in `security-reviewer` with your team's specific threat model. Since `id: security-reviewer` matches a built-in facet ID, it replaces the built-in for everyone who opens this repo.

To dispatch it: `SideCar: Facets: Dispatch Specialists` from the Command Palette, select `Security Reviewer`, enter the task.

### Combining facets

You can dispatch multiple facets in one batch. Create `.sidecar/facets/api-contract-tester.md`:

```markdown
---
id: api-contract-tester
displayName: API Contract Tester
preferredModel: claude-haiku-4-5
toolAllowlist: ['read_file', 'grep', 'run_tests', 'edit_file', 'write_file']
dependsOn: ['security-reviewer']
---

You are an API contract tester. Run after the security reviewer.

For every changed route handler:

1. Diff the OpenAPI schema against the previous version
2. Identify any backward-incompatible changes (removed fields, changed types, new required params)
3. Write or update contract tests in `tests/contracts/` that would catch these breaks

Use the patterns in `tests/contracts/` as your template.
```

`dependsOn: ["security-reviewer"]` means this facet only starts after the security reviewer finishes. The dispatcher walks the DAG in topological order, running independent facets in parallel and dependents after their prerequisites.

---

## Team memory

Team memory is the simplest shared configuration: markdown files in `.sidecar/team-memory/` that inject into every agent turn as a `## Team Memory` block in the system prompt. No frontmatter, no schema — just plain markdown.

```bash
mkdir -p .sidecar/team-memory
```

The files are sorted alphabetically by filename, so the injection order is stable and readable in diffs. Name files to reflect their content:

```
.sidecar/team-memory/
  01-onboarding.md
  02-architecture-decisions.md
  03-known-footguns.md
  04-vendor-quirks.md
```

### What to put in team memory

**Onboarding decisions** — choices that are non-obvious to someone new to the codebase:

```markdown
# Onboarding Decisions

- We use `pnpm`, not `npm`. Always run `pnpm install`, not `npm install`.
- Tests run with `pnpm test`. The CI script is `pnpm run check`.
- `src/generated/` is auto-generated by `pnpm run codegen`. Never edit by hand.
- The staging environment is at https://staging.example.com. Deploys happen automatically on merge to `main`.
```

**Architecture rationale** — the _why_ behind decisions, not just the _what_:

```markdown
# Architecture Decisions

- **No class components.** We migrated away from them in 2023. All new components use hooks.
- **Zustand over Redux.** Redux was removed in v2.0 because the boilerplate outweighed the benefits for our scale.
- **Kysely over raw SQL.** Type-safe queries caught three production bugs during the migration. Keep all queries in `src/db/`.
- **No default exports.** We switched to named exports in 2022 for better tree-shaking and refactoring tools support.
```

**Known footguns** — bugs or sharp edges that have bitten the team before:

```markdown
# Known Footguns

- `UserService.getUser()` returns null for system users (id < 0). Always null-check.
- The Redis client auto-reconnects, but `get()` can return null during reconnect. Treat null as a cache miss, not an error.
- `dateUtils.formatDate()` assumes UTC input. If you pass a local-timezone Date you'll get the wrong output.
- Running `db.migrate.latest()` in tests clears all data. Use `db.seed.run()` to restore fixtures after migrations.
```

Team memory entries are injected verbatim — keep them factual and actionable. The agent treats them like instructions. Avoid entries that are already obvious from the codebase.

---

## Repo-level policy

`.sidecar/policy.json` restricts which tools the agent can use in this repo. Restrictions apply to every developer and every agent mode — they cannot be overridden by per-developer settings. Policy files are checked into the repo and loaded automatically on activation.

The policy file uses `version: 1` and a `toolPermissions` map:

```json
{
  "version": 1,
  "toolPermissions": {
    "git_push": "deny",
    "run_command": "ask",
    "delete_file": "ask",
    "web_search": "allow"
  }
}
```

Permission levels:

| Level   | Behavior                                                           |
| ------- | ------------------------------------------------------------------ |
| `allow` | Always permitted without prompting                                 |
| `ask`   | Requires per-call approval (same as the default cautious behavior) |
| `deny`  | Never permitted — the tool is removed from the agent's tool list   |

Policy permission levels are **additive with the user's settings**: the more restrictive level always wins. If a developer's user settings have `git_push: ask` but the policy says `deny`, the effective level is `deny`.

### Example: safe defaults for a team repo

For a repo where junior developers are onboarding and you want the agent to stop before destructive operations:

```json
{
  "version": 1,
  "toolPermissions": {
    "git_push": "deny",
    "git_commit": "ask",
    "delete_file": "ask",
    "run_command": "ask",
    "db_execute": "deny",
    "db_migrate_up": "deny"
  }
}
```

This lets the agent read, write, and propose git commits (with a prompt), but blocks it from pushing to remote or running database mutations.

### Example: CI-safe policy

For a repo where SideCar runs in CI (e.g. via the MCP server) and should never have shell access:

```json
{
  "version": 1,
  "toolPermissions": {
    "run_command": "deny",
    "run_tests": "deny",
    "git_push": "deny",
    "delete_file": "deny",
    "db_execute": "deny",
    "db_migrate_up": "deny"
  }
}
```

The `$(shield)` icon in the status bar lights up when a policy file is active so developers know restrictions are in effect.

---

## Per-developer settings

Each developer should configure their own backend, model, and personal preferences in user settings (`Cmd+,` → open settings JSON → choose User tab). Keep these out of workspace `.vscode/settings.json` so they don't pollute the repo.

**Recommended user settings template for a team developer:**

```json
{
  "sidecar.provider": "anthropic",
  "sidecar.model": "claude-sonnet-4-6",
  "sidecar.editorModel": "claude-haiku-4-5",
  "sidecar.agentMode": "cautious",
  "sidecar.dailyBudget": 10,
  "sidecar.completionGate.enabled": true,
  "sidecar.autoFixOnFailure": true,
  "sidecar.agentMaxIterations": 25
}
```

The API key goes in SecretStorage, not here. Run `SideCar: Set / Refresh API Key` from the Command Palette after configuring the backend.

**For developers using local Ollama:**

```json
{
  "sidecar.provider": "ollama",
  "sidecar.model": "qwen3-coder:30b",
  "sidecar.agentMode": "autonomous",
  "sidecar.dailyBudget": 0,
  "sidecar.completionGate.enabled": true
}
```

**Settings that belong in workspace `.vscode/settings.json`** (shared, non-sensitive):

```json
{
  "sidecar.regressionGuards": [
    {
      "name": "tests",
      "command": "npm test",
      "trigger": "pre-completion",
      "mode": "blocking",
      "maxAttempts": 3
    }
  ],
  "sidecar.completionGate.enabled": true,
  "sidecar.agentMaxIterations": 30
}
```

Regression guards in workspace settings are workspace-trust-gated — VS Code prompts the developer to accept workspace trust before they activate. This is correct behavior; it prevents a cloned malicious repo from running arbitrary shell commands as guards.

---

## Dev Container / remote SSH setup

SideCar works correctly in Dev Containers, GitHub Codespaces, and VS Code Remote SSH. Agent shell commands (`run_command`, `run_tests`) execute inside the container or remote host via VS Code's shell-integration API — the agent sees the container's filesystem, tools, and environment variables, not the host machine's.

### devcontainer.json configuration

Forward the necessary VS Code settings into the container via `customizations`:

```json
{
  "name": "My Project Dev Container",
  "image": "mcr.microsoft.com/devcontainers/typescript-node:22",
  "customizations": {
    "vscode": {
      "extensions": ["nedonatelli.sidecar-ai"],
      "settings": {
        "sidecar.completionGate.enabled": true,
        "sidecar.terminalExecution.enabled": true,
        "sidecar.terminalExecution.fallbackToChildProcess": true,
        "sidecar.terminalExecution.shellIntegrationTimeoutMs": 4000
      }
    }
  }
}
```

Increase `shellIntegrationTimeoutMs` to 4000 ms or more in containers — the shell takes longer to initialize than on a local machine. The fallback to `child_process` is a safety net; leave it enabled.

### API keys in containers

API keys live in VS Code's SecretStorage on the host machine and are **not** automatically available inside the container. Each developer must run `SideCar: Set / Refresh API Key` after opening the Dev Container for the first time.

If the team uses Anthropic and wants the key available without per-developer setup, pass it via the container's environment:

```json
{
  "remoteEnv": {
    "ANTHROPIC_API_KEY": "${localEnv:ANTHROPIC_API_KEY}"
  }
}
```

Then configure SideCar to read from the environment variable rather than SecretStorage — add to workspace settings:

```json
{
  "sidecar.baseUrl": "https://api.anthropic.com",
  "sidecar.provider": "anthropic",
  "sidecar.model": "claude-sonnet-4-6"
}
```

SideCar will fall back to `process.env.ANTHROPIC_API_KEY` when SecretStorage has no key set. This is acceptable for Dev Containers where the key is sourced from the developer's local environment, not committed to the container image.

### Remote SSH

No special configuration is needed for Remote SSH — SideCar installs in the remote VS Code server and executes commands on the remote host. Set your API key with `SideCar: Set / Refresh API Key` after connecting; SecretStorage is per-machine (remote host), not synced from your local machine.

If the remote host has Ollama installed, point `sidecar.baseUrl` at `http://localhost:11434` — the connection goes through VS Code's port forwarding and doesn't require external network access.

---

## Quick-start checklist

When onboarding a new developer to a repo that already has SideCar set up:

1. Clone the repo — `.sidecar/SIDECAR.md`, skills, facets, team memory, and policy load automatically.
2. Run `SideCar: Set / Refresh API Key` for their chosen backend (Anthropic, OpenRouter, etc.) or confirm Ollama is running locally.
3. Set personal preferences in user settings: `sidecar.model`, `sidecar.agentMode`, `sidecar.dailyBudget`.
4. Type `/review-code` in chat to confirm project skills loaded, or open `SideCar: Facets: Dispatch Specialists` to confirm project facets are available.
5. Check the `$(shield)` status bar item — if it shows, `.sidecar/policy.json` is active and tool restrictions are in effect.
