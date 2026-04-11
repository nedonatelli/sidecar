---
title: RAG & Agent Memory
layout: docs
nav_order: 8
---

# RAG, Semantic Search & Agent Memory

SideCar uses three intelligent systems to improve accuracy and consistency: **RAG** for documentation discovery, **semantic search** for meaning-based file relevance, and **persistent memory** for learning patterns.

## Semantic Search

SideCar embeds your workspace files using a local ONNX model (all-MiniLM-L6-v2, 384-dimensional) and searches by cosine similarity. This means a query like "authentication logic" finds `src/auth/jwt.ts` even when there's no keyword match in the file path or conversation history.

### How it works

1. **Indexing** — after the workspace index is built, SideCar downloads the embedding model (~23MB, cached in `.sidecar/cache/models/`) and embeds each file's path + first 2048 characters
2. **Caching** — embeddings are stored as a binary Float32Array in `.sidecar/cache/embeddings.bin` with content hashes, so files are only re-embedded when they change
3. **Querying** — each user message is embedded and compared against all file vectors by cosine similarity
4. **Scoring** — semantic similarity is blended with heuristic scoring (path matching, recency, conversation context) using a configurable weight (default 0.6)

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `sidecar.enableSemanticSearch` | `true` | Enable ONNX-based semantic file search |
| `sidecar.semanticSearchWeight` | `0.6` | Blend ratio (0 = keyword only, 1 = embeddings only) |

The model loads lazily in the background. Until it's ready, SideCar falls back to keyword-based scoring with no impact on usability.

## RAG: Automatic Documentation Retrieval

### What It Does

RAG automatically discovers and indexes your project's documentation, then retrieves relevant sections for every user message. This helps the agent understand your project's conventions, architecture, and best practices without requiring you to manually paste documentation into every chat.

### How It Works

1. **Discovery** — On startup, SideCar crawls your workspace for documentation files:
   - `README*` files in the project root
   - All `.md` files in `docs/`, `doc/`, and `wiki/` directories
   
2. **Indexing** — Each markdown file is parsed and indexed by:
   - Headings (h1-h6) — title matches score 3x higher
   - Paragraphs — body text is indexed for keyword search
   
3. **Retrieval** — For every user message:
   - Your message is searched against the index using keyword matching
   - Relevant entries are ranked by relevance score
   - Top matches are injected into the system prompt
   
4. **Context Injection** — Matched documentation is injected after skill injection and before workspace context, respecting the remaining context budget

### Example

**Your documentation** (`docs/AUTHENTICATION.md`):
```markdown
# Authentication

## JWT Tokens

We use JWT tokens for stateless authentication. Tokens are signed with the RS256 algorithm.

- Token format: `Bearer <jwt>`
- Expiration: 24 hours
- Refresh via `/api/auth/refresh` endpoint
```

**Your request**:
> "How should I implement login?"

**What happens**:
1. SideCar searches the docs index for "login" and "authentication"
2. Finds `docs/AUTHENTICATION.md` with high relevance
3. The JWT token section is injected into the system prompt
4. The agent now has context about your authentication scheme and can suggest appropriate code

### Configuration

RAG is enabled by default but fully configurable:

| Setting | Default | Description |
|---------|---------|-------------|
| `sidecar.enableDocumentationRAG` | `true` | Enable/disable RAG feature |
| `sidecar.ragMaxDocEntries` | `5` | Max documentation sections per message (1-20) |
| `sidecar.ragUpdateIntervalMinutes` | `60` | Re-index documentation every N minutes (5-360, or 0 to disable) |

### Tips

- **Keep docs up-to-date**: RAG is only as good as your documentation. Update README and docs/ when conventions change
- **Use headings**: Documentation is indexed by heading level. Use clear, descriptive headings for better retrieval
- **Organize by topic**: Create separate files or sections for different domains (Authentication, API, Database, etc.)
- **Include examples**: Code examples in docs are indexed along with text, helping the agent suggest relevant patterns

## Agent Memory: Persistent Learning

### What It Does

Agent memory learns from your coding patterns and automatically remembers them across sessions. When the agent successfully uses a tool or follows a convention, it records that pattern. On future messages, relevant learned patterns are injected into the context to improve consistency and decision-making.

### How It Works

1. **Recording** — During agent runs, tool executions are automatically recorded:
   - **Successes** are stored as `pattern` memories with tool name and input
   - **Failures** are stored as `failure` memories with error details
   - **Tool chains** — sequences of 3+ tools used together in a session are stored as `toolchain` memories (e.g. `read_file → edit_file → get_diagnostics`)
   - Context metadata is stored (timestamp, relevance category)
   - Entry is persisted to `.sidecar/memory/agent-memories.json`

2. **Searching** — For every user message:
   - Your message is searched against stored patterns
   - Results are ranked by relevance and use-count
   - `recordUse()` is called automatically on retrieved memories, keeping use-counts accurate
   - Top matches are formatted and injected into context

3. **Scoring** — Memories have multiple importance signals:
   - **Use-count**: Automatically incremented each time a memory is retrieved. Frequent patterns score higher
   - **Recency**: Newer patterns are boosted in search results (linear decay over 7 days)
   - **Co-occurrence**: Tool chain memories power `suggestNextTools()`, which recommends likely next tools based on past sequences

4. **Eviction** — When the memory store reaches its limit (default 500 entries):
   - Entries with lowest combined use-count + recency score are evicted first
   - Most-used and most-recent patterns are preserved

### Memory Types

Memories are categorized by type to organize learning:

- **Patterns** — Successful tool uses, common approaches for specific tasks
- **Failures** — Tool executions that produced errors, helping the agent avoid repeating mistakes
- **Tool chains** — Sequences of tools used together successfully (e.g. `read_file → edit_file → get_diagnostics`)
- **Decisions** — Architectural choices, coding conventions, established practices
- **Conventions** — Project-specific naming patterns, folder structures, file organization

Example pattern:
```json
{
  "id": "mem-1234",
  "type": "pattern",
  "category": "tool:edit_file",
  "content": "Successfully used edit_file with search/replace strategy on TypeScript files",
  "context": {
    "timestamp": "2026-04-09T10:30:00Z",
    "useCount": 3
  }
}
```

### Persistence

Agent memory is stored as JSON in:
```
.sidecar/memory/agent-memories.json
```

The file is automatically:
- **Created** on first memory recording
- **Loaded** when SideCar starts (asynchronously)
- **Updated** after every new memory or use-count increment

You can safely delete this file at any time to reset learning. It will be recreated automatically.

### Configuration

Agent memory is enabled by default:

| Setting | Default | Description |
|---------|---------|-------------|
| `sidecar.enableAgentMemory` | `true` | Enable/disable agent memory |
| `sidecar.agentMemoryMaxEntries` | `500` | Max memories to retain (10-500) |

### Tips

- **Let it learn**: Don't worry about memory size — the agent will record patterns automatically as you work
- **Clear if stale**: If you want to reset learned patterns (e.g., after major refactoring), delete `.sidecar/memory/agent-memories.json`
- **Review recordings**: For visibility into what the agent has learned, check the JSON file directly
- **Combine with RAG**: Agent memory works alongside RAG. RAG handles documented knowledge, memory handles learned patterns

## RAG + Memory Together

The two systems work synergistically:

1. **RAG** provides official knowledge from your documentation
2. **Agent Memory** adds learned patterns from actual experience
3. Both are searched and injected for every message
4. The agent can cross-reference documented conventions with learned patterns

### Example Workflow

**Session 1**: You ask the agent to implement a user authentication service

1. RAG retrieves `docs/AUTHENTICATION.md` from your docs
2. Agent reads your JWT documentation
3. Agent writes `src/auth/jwt.ts` successfully
4. A pattern is recorded: "Successfully used JWT for authentication in TypeScript"

**Session 2**: You reload VS Code and ask the agent to add login to a new service

1. RAG retrieves the same `docs/AUTHENTICATION.md` (documented knowledge)
2. Agent memory retrieves the "JWT authentication" pattern (learned experience)
3. Agent now has both the spec and a working example
4. New pattern is recorded: "Used JWT for second authentication service"
5. On future messages, JWT authentication ranks higher in memory search

## Troubleshooting

### RAG isn't finding my documentation

- **Check file locations**: Documentation must be in `README*`, `docs/**`, `doc/**`, or `wiki/**`
- **Check file types**: Only `.md` files are indexed
- **Re-index**: Set `sidecar.ragUpdateIntervalMinutes` to 0 and set to desired value to force a refresh
- **Verify settings**: Check that `sidecar.enableDocumentationRAG` is `true`

### Agent memory seems stale

- **Reset if needed**: Delete `.sidecar/memory/agent-memories.json` to start fresh
- **Check enable setting**: Verify `sidecar.enableAgentMemory` is `true`
- **Watch for eviction**: At 500 entries, older patterns are removed. Increase `sidecar.agentMemoryMaxEntries` if you want to retain more

### Too much/too few results injected

- **RAG**: Adjust `sidecar.ragMaxDocEntries` (default 5) to inject more or fewer documentation sections
- **Memory**: Adjust the search in the code if needed — currently hardcoded to retrieve 5 memory entries
- **Budget**: Both systems respect remaining context budget. If your workspace is large, fewer RAG/memory results fit

## See Also

- [Configuration](configuration.md) — Full settings reference
- [Architecture](architecture.md) — How RAG and memory integrate into the system
- [Large Files & Monorepos](configuration.md#large-files--monorepo-handling) — How streaming reads work alongside RAG
