---
name: MCP Server Builder
description: Guide for creating high-quality MCP servers that enable LLMs to interact with external services through well-designed tools
---

# MCP Server Development Guide

Create MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools. The quality of an MCP server is measured by how well it enables LLMs to accomplish real-world tasks.

## Phase 1: Research and Planning

### 1.1 Understand Modern MCP Design

**API Coverage vs. Workflow Tools:**
Balance comprehensive API endpoint coverage with specialized workflow tools. Prioritize comprehensive API coverage when uncertain — it gives agents flexibility to compose operations.

**Tool Naming and Discoverability:**
Use consistent prefixes (e.g., `github_create_issue`, `github_list_repos`) and action-oriented naming. Clear, descriptive names help agents find the right tools quickly.

**Context Management:**
Design tools that return focused, relevant data. Support pagination where applicable. Agents benefit from concise tool descriptions and filtered results.

**Actionable Error Messages:**
Error messages should guide agents toward solutions with specific suggestions and next steps.

### 1.2 Study MCP Protocol

Start with the MCP specification: `https://modelcontextprotocol.io/sitemap.xml`
Fetch specific pages with `.md` suffix (e.g., `https://modelcontextprotocol.io/specification/draft.md`).

Key areas: specification overview, transport mechanisms (streamable HTTP, stdio), tool/resource/prompt definitions.

### 1.3 Plan Implementation

1. Review the service's API documentation (endpoints, auth, data models)
2. List endpoints to implement, starting with the most common operations
3. Choose language: **TypeScript recommended** (better SDK support, good AI code generation, static typing)
4. Choose transport: **Streamable HTTP** for remote servers, **stdio** for local servers

## Phase 2: Implementation

### 2.1 TypeScript Project Setup

```json
// package.json
{
  "name": "mcp-server-example",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true
  },
  "include": ["src"]
}
```

### 2.2 Core Infrastructure

Create shared utilities for:
- API client with authentication
- Error handling helpers with actionable messages
- Response formatting (JSON for structured data, Markdown for human-readable)
- Pagination support

### 2.3 Implement Tools

**TypeScript pattern using `server.registerTool`:**

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({
  name: "my-service",
  version: "1.0.0",
});

server.registerTool(
  "list_items",
  {
    title: "List Items",
    description: "List items with optional filtering",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ query, limit }) => {
    const results = await apiClient.listItems(query, limit ?? 20);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);
```

**For each tool, ensure:**

1. **Input Schema** — Use Zod for validation. Include constraints and clear descriptions with examples in field descriptions.

2. **Output Schema** — Define `outputSchema` where possible for structured data. Use `structuredContent` in tool responses.

3. **Tool Description** — Concise summary, parameter descriptions, return type.

4. **Annotations** — Always set `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.

5. **Error Handling** — Return `isError: true` with actionable message text. Include specific suggestions and next steps.

6. **Pagination** — Support `cursor` or `offset`/`limit` parameters. Return next-page info in results.

### 2.4 Python Alternative (FastMCP)

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("my-service")

@mcp.tool()
async def list_items(query: str = "", limit: int = 20) -> str:
    """List items with optional filtering.
    
    Args:
        query: Search query to filter items
        limit: Maximum number of results (default 20)
    """
    results = await api_client.list_items(query, limit)
    return json.dumps(results, indent=2)
```

### 2.5 Transport Setup

**Stdio (local):**
```typescript
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Streamable HTTP (remote):**
```typescript
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
// Stateless mode recommended for scalability
```

## Phase 3: Quality Review

### 3.1 Code Quality Checklist

- [ ] No duplicated code (DRY)
- [ ] Consistent error handling with actionable messages
- [ ] Full type coverage (no `any`)
- [ ] Clear, concise tool descriptions
- [ ] All tools have annotations set
- [ ] Pagination on list endpoints
- [ ] Input validation with meaningful error messages
- [ ] Output size bounded (large results paginated or truncated)

### 3.2 Build and Test

```bash
# TypeScript
npm run build
npx @modelcontextprotocol/inspector  # Interactive testing

# Python
python -m py_compile your_server.py
```

### 3.3 SideCar Integration

To use with SideCar, add to workspace settings:

```json
{
  "sidecar.mcpServers": {
    "my-service": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

Or add to `.mcp.json` at project root for team sharing:

```json
{
  "mcpServers": {
    "my-service": {
      "type": "stdio",
      "command": "npx",
      "args": ["my-mcp-server"],
      "env": { "API_KEY": "${API_KEY}" }
    }
  }
}
```

## Phase 4: Evaluation

Create 10 evaluation questions to test your MCP server:

1. **Tool Inspection** — List available tools and understand their capabilities
2. **Content Exploration** — Use read-only operations to explore available data
3. **Question Generation** — Create 10 complex, realistic questions requiring multiple tool calls
4. **Answer Verification** — Solve each question yourself to verify answers

**Each question must be:** independent, read-only, complex (multiple tool calls), realistic, verifiable, and stable over time.

**Output format:**
```xml
<evaluation>
  <qa_pair>
    <question>Your complex question here</question>
    <answer>Verified answer</answer>
  </qa_pair>
</evaluation>
```

## Steps

1. Ask the user what service/API they want to build an MCP server for
2. Research the API documentation (use `web_search` if needed)
3. Plan the tool set — list all endpoints to cover
4. Set up the project structure (TypeScript recommended)
5. Implement the API client and shared utilities
6. Implement each tool with proper schemas, annotations, and error handling
7. Add transport setup (stdio for local, HTTP for remote)
8. Build and verify compilation
9. Write the SideCar configuration for testing
10. Create evaluation questions
