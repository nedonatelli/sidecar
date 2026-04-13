---
title: MCP Servers
layout: docs
nav_order: 5
---

# MCP Servers

SideCar supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io) for connecting to external tools and data sources.

## What is MCP?

MCP is an open protocol that lets AI assistants call external tools — databases, APIs, file systems, and custom scripts. MCP tools appear alongside SideCar's built-in tools and go through the same approval flow.

## Transport types

SideCar supports three transport types:

| Transport | Use case | Configuration |
|-----------|----------|---------------|
| **stdio** (default) | Local processes on your machine | `command` + `args` |
| **http** | Remote servers via Streamable HTTP | `url` |
| **sse** | Remote servers via Server-Sent Events | `url` |

## Configuration

### VS Code settings

Add MCP servers via the `sidecar.mcpServers` setting:

```json
"sidecar.mcpServers": {
  "server-name": {
    "type": "stdio",
    "command": "executable",
    "args": ["arg1", "arg2"],
    "env": { "API_KEY": "your-key" }
  }
}
```

The `type` field defaults to `"stdio"` and can be omitted for local servers.

### `.mcp.json` project file

For team-shared configurations, create a `.mcp.json` file at your workspace root. This format is compatible with Claude Code's project-scope config:

```json
{
  "mcpServers": {
    "my-api": {
      "type": "http",
      "url": "https://mcp.example.com/api",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}"
      }
    },
    "local-tools": {
      "type": "stdio",
      "command": "npx",
      "args": ["my-mcp-server"],
      "env": {
        "DB_URL": "${DATABASE_URL}"
      }
    }
  }
}
```

**Merge behavior**: VS Code settings take precedence over `.mcp.json`. If both define a server with the same name, the VS Code setting wins. This lets individuals override shared project configs.

**Environment variable expansion**: Use `${VAR_NAME}` in `env` values and HTTP `headers`. Variables resolve from `process.env` merged with the server's `env` config. This keeps secrets out of version control.

## Transport examples

### stdio (local process)

```json
"sidecar.mcpServers": {
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
  }
}
```

### HTTP (remote server)

```json
"sidecar.mcpServers": {
  "production-api": {
    "type": "http",
    "url": "https://mcp.mycompany.com/api",
    "headers": {
      "Authorization": "Bearer ${MCP_TOKEN}"
    }
  }
}
```

### SSE (Server-Sent Events)

```json
"sidecar.mcpServers": {
  "streaming-server": {
    "type": "sse",
    "url": "https://mcp.example.com/sse",
    "headers": {
      "X-API-Key": "${SSE_API_KEY}"
    }
  }
}
```

## Common server examples

### Filesystem

Give SideCar access to files outside your workspace:

```json
"sidecar.mcpServers": {
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/directory"]
  }
}
```

### SQLite database

Query a local database:

```json
"sidecar.mcpServers": {
  "sqlite": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-sqlite", "/path/to/database.db"]
  }
}
```

### GitHub

Access GitHub repos, issues, and PRs:

```json
"sidecar.mcpServers": {
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_TOKEN": "your-token"
    }
  }
}
```

## Per-tool configuration

Disable specific tools from a server using the `tools` config:

```json
"sidecar.mcpServers": {
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_TOKEN": "your-token" },
    "tools": {
      "delete_repository": { "enabled": false },
      "delete_branch": { "enabled": false }
    }
  }
}
```

Disabled tools are filtered out during discovery and never appear in the agent's tool list.

## Output size limits

Large MCP tool results can consume excessive context. Control this with `maxResultChars`:

```json
"sidecar.mcpServers": {
  "database": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-sqlite", "large.db"],
    "maxResultChars": 20000
  }
}
```

The default limit is 50,000 characters. Results exceeding the limit are truncated with a message indicating the total size.

## Server status

Use the `/mcp` slash command to check the status of all connected servers:

```
/mcp
```

This shows each server's name, connection status, transport type, tool count, uptime, and any errors.

## Health monitoring

SideCar monitors MCP server health automatically:

- **Connection failures** are reported with specific error messages
- **Automatic reconnection** uses exponential backoff (2s, 5s, 15s)
- **Settings changes** trigger automatic reconnection to all servers
- **Workspace trust** — MCP servers from workspace settings or `.mcp.json` trigger a trust prompt before connecting (since they can spawn processes)

## How MCP tools work

- MCP tools are **discovered automatically** when the server starts
- They appear in the agent's tool list with an `mcp_<server>_<tool>` prefix
- Descriptions are prefixed with `[MCP: <server>]` for clarity
- Tool calls go through the same **approval flow** (cautious/autonomous/manual/review)
- **Tool permissions** (`sidecar.toolPermissions`) apply to MCP tools by their prefixed name
- All MCP tools **require approval** regardless of approval mode

## Building MCP servers

SideCar includes a built-in `/mcp-builder` skill that guides you through creating high-quality MCP servers. It covers:

- TypeScript and Python implementation patterns
- Tool schema design with Zod/Pydantic
- Error handling and pagination
- Transport setup (stdio and HTTP)
- Testing with MCP Inspector
- Evaluation question generation

Type `/mcp-builder` in chat to start, or describe the API you want to wrap.

## Full configuration reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"stdio"` \| `"http"` \| `"sse"` | `"stdio"` | Transport type |
| `command` | string | — | Executable to spawn (stdio) |
| `args` | string[] | `[]` | Command arguments (stdio) |
| `env` | object | `{}` | Environment variables (stdio) or variable source for header expansion |
| `url` | string | — | Server URL (http/sse) |
| `headers` | object | `{}` | HTTP headers (http/sse). Supports `${VAR}` expansion |
| `tools` | object | `{}` | Per-tool config: `{ "tool_name": { "enabled": false } }` |
| `maxResultChars` | number | `50000` | Maximum result size in characters before truncation |

## Troubleshooting

- **Check server status**: run `/mcp` in chat to see connection status and errors
- **Verify installation**: run the MCP server command manually in your terminal
- **Check logs**: open the "SideCar Agent" output channel for connection errors
- **PATH issues**: ensure `npx` and `node` are in your PATH if using npx-based servers
- **Windows**: when using `npx` on Windows, you may need to wrap with `cmd /c npx`
- **HTTP servers**: ensure the URL is reachable and returns valid MCP responses
- **Trust prompts**: if servers from `.mcp.json` don't connect, check if you blocked the workspace trust prompt
