---
title: Hooks & Scheduled Tasks
layout: docs
nav_order: 4
nav_section: "Configuration"
---

# Hooks, Scheduled Tasks & Custom Tools

SideCar provides four extensibility surfaces that run shell commands or agent tasks in response to tool calls, file-system events, schedules, or file saves — all without writing TypeScript or building a VS Code extension.

> **Trust gate:** All four features (`sidecar.hooks`, `sidecar.eventHooks`, `sidecar.scheduledTasks`, `sidecar.customTools`) are workspace-trust-gated. When a repository defines them in `.vscode/settings.json`, SideCar surfaces a one-time confirmation prompt before activating them. User-level settings (`~/.config/Code/User/settings.json`) are always trusted.

---

## Tool hooks

Run a shell command immediately before (`pre`) or after (`post`) any tool execution. Keys are tool names or `*` to match all tools.

```json
"sidecar.hooks": {
  "write_file": {
    "post": "npx prettier --write \"$SIDECAR_FILE\""
  },
  "edit_file": {
    "post": "npx prettier --write \"$SIDECAR_FILE\""
  },
  "git_commit": {
    "pre": "npm run lint --silent"
  },
  "*": {
    "pre": "echo \"$SIDECAR_TOOL $SIDECAR_INPUT\" >> /tmp/sidecar-audit.log"
  }
}
```

### Environment variables

| Variable | Available | Description |
|----------|-----------|-------------|
| `SIDECAR_TOOL` | pre, post | Tool name being executed (e.g. `write_file`) |
| `SIDECAR_INPUT` | pre, post | JSON-encoded input parameters |
| `SIDECAR_FILE` | pre, post | Value of the `path` input field, if the tool has one |
| `SIDECAR_OUTPUT` | post only | Tool execution result (string) |

### Hook execution order

When a tool matches both a specific key and `*`, the specific hook runs first, then `*`. For each key, `pre` runs before the tool, `post` runs after.

A non-zero exit code from a `pre` hook **cancels the tool call** and returns the hook output as an error — useful for enforcing pre-conditions. A non-zero exit from a `post` hook is logged as a warning but does not affect the tool result already returned to the agent.

### Recipes

**Auto-format after every write:**
```json
"sidecar.hooks": {
  "write_file": { "post": "npx prettier --write \"$SIDECAR_FILE\" 2>/dev/null || true" },
  "edit_file":  { "post": "npx prettier --write \"$SIDECAR_FILE\" 2>/dev/null || true" }
}
```

**Require lint to pass before any commit:**
```json
"sidecar.hooks": {
  "git_commit": { "pre": "npm run lint --silent" }
}
```

**Audit log of every tool the agent calls:**
```json
"sidecar.hooks": {
  "*": { "pre": "echo \"$(date -u +%Y-%m-%dT%H:%M:%SZ) $SIDECAR_TOOL\" >> .sidecar/logs/tool-audit.log" }
}
```

**Block pushes to main branch:**
```json
"sidecar.hooks": {
  "git_push": { "pre": "branch=$(git rev-parse --abbrev-ref HEAD); [ \"$branch\" != 'main' ] || (echo 'Direct push to main blocked.' && exit 1)" }
}
```

---

## Event hooks

Run a shell command when VS Code fires a file-system event. Unlike tool hooks, these fire on *any* save or create — even edits the user makes manually, not just agent actions.

```json
"sidecar.eventHooks": {
  "onSave":   "npx eslint --fix \"$SIDECAR_FILE\" --quiet 2>/dev/null || true",
  "onCreate": "echo \"New file: $SIDECAR_FILE\" >> .sidecar/logs/created.log",
  "onDelete": "git rm --cached \"$SIDECAR_FILE\" 2>/dev/null || true"
}
```

| Event | Triggers when | `$SIDECAR_FILE` value |
|-------|---------------|-----------------------|
| `onSave` | Any file is saved (Cmd+S or auto-save) | Absolute path of saved file |
| `onCreate` | A new file is created | Absolute path of new file |
| `onDelete` | A file is deleted | Absolute path of deleted file |

Event hooks receive `$SIDECAR_FILE` (the absolute path of the affected file) and `$SIDECAR_TOOL` (the event name: `onSave`, `onCreate`, `onDelete`).

### Recipe — keep an index file in sync

Regenerate a barrel export whenever a TypeScript file is saved in `src/components/`:

```json
"sidecar.eventHooks": {
  "onSave": "if [[ \"$SIDECAR_FILE\" == */src/components/*.ts ]]; then node scripts/gen-barrel.js; fi"
}
```

---

## Scheduled tasks

Run an agent task on a recurring interval, a cron schedule, or whenever a matching file is saved. Each task fires a full agent loop with the configured `prompt`.

```json
"sidecar.scheduledTasks": [
  {
    "name": "daily-standup-prep",
    "cron": "0 8 * * 1-5",
    "prompt": "Review the last 24 hours of git commits. Write a concise standup summary to .sidecar/standup.md: what was done, what's blocked, what's next.",
    "enabled": true
  },
  {
    "name": "lint-on-ts-save",
    "onSave": ["src/**/*.ts", "src/**/*.tsx"],
    "prompt": "The file $SIDECAR_FILE was just saved. Run the linter and fix any new warnings introduced in this file only.",
    "enabled": true
  },
  {
    "name": "hourly-test-pulse",
    "intervalMinutes": 60,
    "prompt": "Run npm test. If any tests are failing, identify the root cause and create a GitHub issue with the failure details.",
    "enabled": false
  }
]
```

### Field reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique display name — also used as the lock key to prevent overlapping runs |
| `prompt` | string | Yes | Natural-language prompt sent to the agent |
| `enabled` | boolean | No | `true` by default. Set `false` to pause without removing the entry |
| `intervalMinutes` | number | No | Run every N minutes (minimum 1). Ignored when `cron` is set |
| `cron` | string | No | 5-field cron expression. Takes precedence over `intervalMinutes` |
| `onSave` | string[] | No | Run when a saved file matches any of these globs |
| `targetPaths` | string[] | No | Files the task will write. When set, tasks with unsaved changes in these paths run in a Shadow Workspace |

Exactly one trigger type should be set per task. If both `cron` and `intervalMinutes` are present, `cron` wins.

### Cron expression syntax

```
┌─── minute (0-59)
│  ┌── hour (0-23)
│  │  ┌─ day of month (1-31)
│  │  │  ┌ month (1-12)
│  │  │  │  ┌ day of week (0-7, 0 and 7 = Sunday)
│  │  │  │  │
*  *  *  *  *
```

| Expression | Meaning |
|------------|---------|
| `0 9 * * 1-5` | Weekdays at 09:00 |
| `*/30 * * * *` | Every 30 minutes |
| `0 0 * * 0` | Sunday midnight |
| `0 8,17 * * 1-5` | Weekdays at 08:00 and 17:00 |
| `0 */4 * * *` | Every 4 hours |

### Running a task immediately

Without waiting for the next scheduled fire:

```
Cmd+Shift+P → SideCar: Run Scheduled Task Now
```

A QuickPick lists all enabled tasks by name. Selecting one fires it immediately.

### The `onSave` file trigger

When `onSave` globs are set, the task fires within a few seconds of a matching file being saved — useful for reactive agents that keep derived artifacts in sync.

The saved file path is injected into the prompt as `$SIDECAR_FILE`:

```json
{
  "name": "update-snapshots",
  "onSave": ["src/**/*.test.ts"],
  "prompt": "The test file $SIDECAR_FILE was saved. Run its tests with --updateSnapshot to refresh any outdated snapshots, then stage the updated snapshot files."
}
```

### Protecting writes with Shadow Workspaces

When `targetPaths` is set and any of those files have unsaved local changes, the task runs inside a Shadow Workspace — the agent's writes land in an isolated `git worktree` until you accept or reject the result.

```json
{
  "name": "weekly-changelog",
  "cron": "0 9 * * 5",
  "prompt": "Generate a CHANGELOG entry for the week's commits and prepend it to CHANGELOG.md.",
  "targetPaths": ["CHANGELOG.md"],
  "enabled": true
}
```

### Practical examples

**Daily dependency audit (Mon–Fri 09:00):**
```json
{
  "name": "dep-audit",
  "cron": "0 9 * * 1-5",
  "prompt": "Run 'npm audit'. If there are high-severity vulnerabilities, create a GitHub issue listing them and assign it to me."
}
```

**Keep API docs in sync with route changes:**
```json
{
  "name": "openapi-sync",
  "onSave": ["src/routes/**/*.ts"],
  "prompt": "The route file $SIDECAR_FILE was saved. Regenerate the OpenAPI spec for that route and update docs/api/ accordingly."
}
```

**Bundle size watchdog (every 2 hours):**
```json
{
  "name": "bundle-watchdog",
  "intervalMinutes": 120,
  "prompt": "Build the project and check the bundle size. If it exceeds 500KB, identify the largest contributors and open a GitHub issue."
}
```

---

## Custom tools

Register any shell command as an agent tool. Custom tools appear in the agent's tool catalog alongside built-ins and go through the same approval flow.

```json
"sidecar.customTools": [
  {
    "name": "deploy_staging",
    "description": "Deploy the current branch to the staging environment. Use after tests pass to get feedback before production.",
    "command": "npm run deploy:staging -- --branch $SIDECAR_INPUT"
  },
  {
    "name": "send_slack",
    "description": "Send a message to the #dev Slack channel. Pass the message text as input.",
    "command": "curl -s -X POST $SLACK_WEBHOOK -d '{\"text\":\"'\"$SIDECAR_INPUT\"'\"}'"
  },
  {
    "name": "db_migrate",
    "description": "Run pending database migrations in the development environment.",
    "command": "npx prisma migrate dev --name $SIDECAR_INPUT"
  }
]
```

### Field reference

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Tool identifier — becomes `custom_<name>` in the agent catalog |
| `description` | Yes | What the tool does. The model reads this to decide when to call it — write it clearly |
| `command` | Yes | Shell command. `$SIDECAR_INPUT` is replaced with the agent's string argument |

### How `$SIDECAR_INPUT` works

When the agent calls `custom_deploy_staging("main")`, `$SIDECAR_INPUT` is set to `main` in the child process environment. The input string passes through `redactSecrets()` before being set, so hallucinated credentials can't leak via environment variables.

### Approval behavior

Custom tools **always require user approval** per call — there is no way to auto-allow them via `sidecar.toolPermissions`. This is intentional: custom tools have arbitrary shell access and the consequence of a wrong call cannot be bounded by SideCar.

The approval prompt shows both the tool name and the full command with `$SIDECAR_INPUT` substituted so you see exactly what will run before confirming.

### Trust gating

Custom tools in `.vscode/settings.json` require workspace trust. A cloned repository cannot inject `custom_exfiltrate` silently — the user must accept the workspace trust prompt first. User-level custom tools are always active.

---

## Putting it together

These four surfaces compose cleanly:

- **Tool hooks** react to the agent's tool calls, synchronously, in the same process context as the agent turn.
- **Event hooks** react to the file system independently of whether the agent is running.
- **Scheduled tasks** run a full autonomous agent loop on a timer or file-save trigger.
- **Custom tools** give the agent new capabilities defined by your team.

A complete workspace automation setup might combine all four:

```json
{
  "sidecar.hooks": {
    "write_file": { "post": "npx prettier --write \"$SIDECAR_FILE\" 2>/dev/null || true" }
  },
  "sidecar.eventHooks": {
    "onSave": "[ \"${SIDECAR_FILE##*.}\" = 'ts' ] && npx eslint --fix \"$SIDECAR_FILE\" --quiet 2>/dev/null || true"
  },
  "sidecar.scheduledTasks": [
    {
      "name": "morning-pr-review",
      "cron": "0 9 * * 1-5",
      "prompt": "List all open PRs. For each one, run /review and post the findings as a GitHub review comment.",
      "enabled": true
    }
  ],
  "sidecar.customTools": [
    {
      "name": "open_ticket",
      "description": "Create a Linear ticket for a bug or task. Pass the title as input.",
      "command": "linear create --title \"$SIDECAR_INPUT\" --team ENG --status Backlog"
    }
  ]
}
```
