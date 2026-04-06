---
title: MCP Servers
layout: default
nav_order: 5
---

# MCP Servers

SideCar supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io) for connecting to external tools and data sources.

## What is MCP?

MCP is an open protocol that lets AI assistants call external tools — databases, APIs, file systems, and custom scripts. MCP tools appear alongside SideCar's built-in tools and go through the same approval flow.

## Configuration

Add MCP servers via the `sidecar.mcpServers` setting:

```json
"sidecar.mcpServers": {
  "server-name": {
    "command": "executable",
    "args": ["arg1", "arg2"]
  }
}
```

SideCar uses stdio transport to communicate with MCP servers.

## Examples

### Filesystem server

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

## How MCP tools work

- MCP tools are **discovered automatically** when the server starts
- They appear in the agent's tool list alongside built-in tools
- Tool calls go through the same **approval flow** (cautious/autonomous/manual)
- **Tool permissions** (`sidecar.toolPermissions`) apply to MCP tools by name
- Settings changes trigger **automatic reconnection**

## Troubleshooting

- Verify the MCP server is installed: run the command manually in your terminal
- Check the "SideCar Agent" output channel for connection errors
- Ensure `npx` is in your PATH if using npx-based servers
