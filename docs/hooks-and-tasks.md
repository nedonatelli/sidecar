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

Run a shell command immediately before (`pre`) or after (`post`) any tool execution. Keys are tool names or `*` to match all tools. The command runs through a shell (`$SHELL`, or `/bin/bash`; `cmd.exe` on Windows) with SideCar's environment plus the variables below.

The examples on this page use POSIX shell syntax. On Windows, where hooks run under `cmd.exe`, write the command for `cmd.exe`, or start it with `bash -c "…"` when Git Bash is installed.

```json
"sidecar.hooks": {
  "write_file": {
    "post": "npx prettier --write \"$(node -p 'JSON.parse(process.env.SIDECAR_INPUT).path')\""
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
| `SIDECAR_OUTPUT` | post only | Tool execution result (string, first 10,000 characters) |

Tool hooks get no `SIDECAR_FILE` variable. To act on the file a tool touched, read `path` out of `SIDECAR_INPUT`, as the `write_file` example above does.

### Hook execution order

Only one hook runs per phase. When a tool has its own entry for that phase, it replaces the `*` entry; `*` runs only for tools (or phases) with no specific hook. `pre` runs before the tool, `post` runs after.

A non-zero exit code (or a timeout) from a `pre` hook **cancels the tool call** and returns an error such as `Hook failed with exit code 1` — useful for enforcing pre-conditions. A non-zero exit from a `post` hook is logged as a warning but does not affect the tool result already returned to the agent.

### Recipes

**Auto-format after every write:**
```json
"sidecar.hooks": {
  "write_file": { "post": "npx prettier --write \"$(node -p 'JSON.parse(process.env.SIDECAR_INPUT).path')\" 2>/dev/null || true" },
  "edit_file":  { "post": "npx prettier --write \"$(node -p 'JSON.parse(process.env.SIDECAR_INPUT).path')\" 2>/dev/null || true" }
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
| `onSave` | Any file is saved (Cmd+S or auto-save) | Workspace-relative path of saved file |
| `onCreate` | A new file is created | Workspace-relative path of new file |
| `onDelete` | A file is deleted | Workspace-relative path of deleted file |

Event hooks receive `$SIDECAR_FILE` (the affected file's path relative to the workspace root, e.g. `src/app.ts`) and `$SIDECAR_EVENT` (the event name: `onSave`, `onCreate`, `onDelete`). The command runs in the workspace root.

### Recipe — keep an index file in sync

Regenerate a barrel export whenever a TypeScript file is saved in `src/components/`:

```json
"sidecar.eventHooks": {
  "onSave": "if [[ \"$SIDECAR_FILE\" == src/components/*.ts ]]; then node scripts/gen-barrel.js; fi"
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
    "prompt": "A TypeScript file under src/ was just saved. Run the linter on the files changed since the last commit and fix any new warnings.",
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
| `enabled` | boolean | Yes | Must be `true` for the task to run. A task with `enabled` missing or `false` is skipped and is not listed by **Run Scheduled Task Now** |
| `intervalMinutes` | number | No | Run every N minutes (minimum 1). Ignored when `cron` is set |
| `cron` | string | No | 5-field cron expression. Takes precedence over `intervalMinutes` |
| `onSave` | string[] | No | Run when a saved file matches any of these globs. Write globs relative to the workspace folder (`src/**/*.ts`); a bare name pattern (`*.ts`, `package.json`) matches in any directory. See [The `onSave` file trigger](#the-onsave-file-trigger) |
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

A glob must match the whole path it is tested against. Each one is tested against three forms of the saved file's path, all with forward slashes, and the task fires if any of them matches:

- the path relative to the workspace folder that holds the file (`src/agent/x.ts`), which in a single-folder workspace is the path event hooks get in `$SIDECAR_FILE`
- the absolute path (`/home/me/proj/src/agent/x.ts`)
- the bare file name (`x.ts`)

So `src/**/*.ts` matches TypeScript files anywhere under `src/`, including `src/x.ts`, and `*.ts` or `package.json` match by name in any directory. A file saved outside every workspace folder has no relative path, so only absolute and name patterns can match it. In a multi-root workspace, a relative glob is matched within each folder, without the folder's name in front.

The prompt is sent exactly as written: the saved file's path is not passed to the agent, and `$SIDECAR_FILE` in a prompt stays literal text. Write the prompt so it doesn't depend on knowing which file was saved:

```json
{
  "name": "update-snapshots",
  "onSave": ["src/**/*.test.ts"],
  "prompt": "A test file under src/ was saved. Run the test suite with --updateSnapshot to refresh any outdated snapshots, then stage the updated snapshot files.",
  "enabled": true
}
```

### Protecting writes with Shadow Workspaces

When `targetPaths` is set and any of those files are open with unsaved changes, the task runs inside a Shadow Workspace — the agent's writes land in an isolated `git worktree`, not your files. There is no accept/reject step: the changes are saved as a patch at `.sidecar/scheduled-patches/<task-name>-<timestamp>.patch`, the run is recorded as not applied, and you apply the patch yourself with `git apply`.

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
  "prompt": "Run 'npm audit'. If there are high-severity vulnerabilities, create a GitHub issue listing them and assign it to me.",
  "enabled": true
}
```

**Keep API docs in sync with route changes:**
```json
{
  "name": "openapi-sync",
  "onSave": ["src/routes/**/*.ts"],
  "prompt": "A route file under src/routes/ was saved. Regenerate the OpenAPI spec and update docs/api/ accordingly.",
  "enabled": true
}
```

**Bundle size watchdog (every 2 hours):**
```json
{
  "name": "bundle-watchdog",
  "intervalMinutes": 120,
  "prompt": "Build the project and check the bundle size. If it exceeds 500KB, identify the largest contributors and open a GitHub issue.",
  "enabled": true
}
```

---

## Custom tools

Register any command as an agent tool. Custom tools appear in the agent's tool catalog alongside built-ins and go through the same approval flow.

```json
"sidecar.customTools": [
  {
    "name": "deploy_staging",
    "description": "Deploy a branch to the staging environment. Pass the branch name as input. Use after tests pass to get feedback before production.",
    "command": "node scripts/deploy-staging.mjs"
  },
  {
    "name": "send_slack",
    "description": "Send a message to the #dev Slack channel. Pass the message text as input.",
    "command": "node scripts/send-slack.mjs"
  },
  {
    "name": "db_migrate",
    "description": "Run pending database migrations in the development environment. Pass the migration name as input.",
    "command": "sh -c 'npx prisma migrate dev --name \"$SIDECAR_INPUT\"'"
  }
]
```

Each script reads its argument from the environment, e.g. `const branch = process.env.SIDECAR_INPUT;`. `send-slack.mjs` has to get the webhook URL some other way (a file it reads, for instance), because custom tools don't inherit variables like `SLACK_WEBHOOK` (see below). The `sh -c` form works where `sh` is on `PATH` (macOS, Linux, Git Bash on Windows).

### Field reference

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Tool identifier — becomes `custom_<name>` in the agent catalog |
| `description` | Yes | What the tool does. The model reads this to decide when to call it — write it clearly |
| `command` | Yes | Program and arguments, run without a shell. Nothing in it is substituted; the agent's string argument arrives as the `SIDECAR_INPUT` environment variable |

### How `$SIDECAR_INPUT` works

When the agent calls `custom_deploy_staging("main")`, `SIDECAR_INPUT` is set to `main` in the child process environment. The input string passes through `redactSecrets()` before being set, so hallucinated credentials can't leak via environment variables.

`command` is split into a program and its arguments (quotes group words) and started with `execFile`, without a shell. A `$SIDECAR_INPUT` written into `command` reaches the program as those literal characters, and so do other `$VARS`, pipes, redirects and `&&`. On Windows, a bare `npm`, `npx`, `yarn`, `pnpm` or `bun` is started through `cmd.exe`, which still does not expand `$SIDECAR_INPUT`.

The child process gets a minimal environment: `SIDECAR_INPUT`, plus `PATH`, `HOME`, `TMPDIR`, `TEMP`, `TMP`, `TERM`, `LANG`, `LC_ALL` and `SHELL` when they are set. Nothing else from your environment, including API keys and webhook URLs, is passed. The command runs in the workspace root with a 30-second timeout; stdout (then stderr) becomes the tool result.

### Approval behavior

Custom tools are marked as requiring approval, like the built-in tools that change things. In Cautious and Manual modes the agent asks before every call. Autonomous mode runs them without asking, and so does a `sidecar.toolPermissions` entry of `"custom_<name>": "allow"`. Set `"custom_<name>": "ask"` to keep the prompt in every mode.

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
    "write_file": { "post": "npx prettier --write \"$(node -p 'JSON.parse(process.env.SIDECAR_INPUT).path')\" 2>/dev/null || true" }
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
      "command": "sh -c 'linear create --title \"$SIDECAR_INPUT\" --team ENG --status Backlog'"
    }
  ]
}
```
