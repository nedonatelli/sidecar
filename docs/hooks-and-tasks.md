---
title: Hooks & Scheduled Tasks
layout: default
nav_order: 9
---

# Hooks, Scheduled Tasks & Custom Tools

## Tool hooks

Run shell commands before or after any tool execution:

```json
"sidecar.hooks": {
  "write_file": { "post": "npm run lint --fix" },
  "edit_file": { "post": "npm run lint --fix" },
  "*": { "pre": "echo \"Tool: $SIDECAR_TOOL\"" }
}
```

- Keys are tool names or `*` for all tools
- `"pre"` runs before the tool executes
- `"post"` runs after the tool executes

### Environment variables

| Variable | Available | Description |
|----------|-----------|-------------|
| `SIDECAR_TOOL` | pre, post | Name of the tool being executed |
| `SIDECAR_INPUT` | pre, post | JSON string of tool input parameters |
| `SIDECAR_OUTPUT` | post only | Tool execution result |

### Use cases

- Auto-format files after writes: `"post": "npx prettier --write $SIDECAR_INPUT"`
- Log all tool usage: `"*": { "pre": "echo $SIDECAR_TOOL >> /tmp/sidecar.log" }`
- Run tests after edits: `"edit_file": { "post": "npm test" }`

## Event hooks

Trigger shell commands on file system events:

```json
"sidecar.eventHooks": {
  "onSave": "npm run lint --fix",
  "onCreate": "echo 'New file created'",
  "onDelete": "echo 'File deleted'"
}
```

| Event | Triggers when |
|-------|---------------|
| `onSave` | A file is saved |
| `onCreate` | A new file is created |
| `onDelete` | A file is deleted |

## Scheduled tasks

Run recurring agent tasks on an interval:

```json
"sidecar.scheduledTasks": [
  {
    "name": "Lint check",
    "intervalMinutes": 30,
    "prompt": "Run the linter and fix any issues",
    "enabled": true
  },
  {
    "name": "Test suite",
    "intervalMinutes": 60,
    "prompt": "Run all tests and report failures",
    "enabled": true
  }
]
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Display name for the task |
| `intervalMinutes` | number | Yes | How often to run (in minutes) |
| `prompt` | string | Yes | The prompt sent to the agent |
| `enabled` | boolean | No | Whether the task is active (default: `true`) |

Scheduled tasks run **autonomously** and log output to the "SideCar Agent" output channel (`View > Output > SideCar Agent`).

## Custom tools

Register shell commands as agent tools:

```json
"sidecar.customTools": [
  {
    "name": "deploy_staging",
    "description": "Deploy the application to the staging environment",
    "command": "npm run deploy:staging"
  },
  {
    "name": "db_migrate",
    "description": "Run pending database migrations",
    "command": "npx prisma migrate dev"
  }
]
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Tool name (used by the agent) |
| `description` | string | Yes | What the tool does (shown to the model) |
| `command` | string | Yes | Shell command to execute |

Custom tools:
- Appear alongside built-in tools in the agent's tool list
- Go through the same approval flow (respects agent mode and tool permissions)
- Can be controlled via `sidecar.toolPermissions`
