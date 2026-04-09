# SideCar Tool System Architecture

## Tool Registry Structure

```
┌─────────────────────────────────────────────────────────────────┐
│                        Tool Registry                            │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────┐  │
│  │  Built-in   │  │  Custom     │  │   MCP       │  │  Spawn  │  │
│  │   Tools     │  │   Tools     │  │   Tools     │  │  Agent  │  │
│  │             │  │             │  │             │  │         │  │
│  │  - read_file│  │  - custom_  │  │  - mcp_     │  │  - spawn│  │
│  │  - write_   │  │    name     │  │    name     │  │    agent│  │
│  │  - edit_    │  │             │  │             │  │         │  │
│  │  - search_  │  │             │  │             │  │         │  │
│  │  - grep     │  │             │  │             │  │         │  │
│  │  - run_     │  │             │  │             │  │         │  │
│  │  - list_    │  │             │  │             │  │         │  │
│  │  - git_     │  │             │  │             │  │         │  │
│  │  ...        │  │             │  │             │  │         │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────────────────┐
                    │   Tool Definition Schema    │
                    │                             │
                    │  {                          │
                    │    name: string,            │
                    │    description: string,     │
                    │    input_schema: {          │
                    │      type: "object",        │
                    │      properties: { ... },   │
                    │      required: [ ... ]      │
                    │    }                        │
                    │  }                          │
                    └─────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────────────────┐
                    │   Tool Executor Function    │
                    │                             │
                    │  async function (input,     │
                    │    context?: ToolContext)   │
                    │    Promise<string>          │
                    └─────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────────────────┐
                    │   Tool Execution Pipeline   │
                    │                             │
                    │  ┌─────────────────────┐    │
                    │  │  Approval Check     │    │
                    │  └─────────────────────┘    │
                    │        │                    │
                    │        ▼                    │
                    │  ┌─────────────────────┐    │
                    │  │  Security Scan      │    │
                    │  └─────────────────────┘    │
                    │        │                    │
                    │        ▼                    │
                    │  ┌─────────────────────┐    │
                    │  │  Tool Execution     │    │
                    │  │  (VS Code API)      │    │
                    │  └─────────────────────┘    │
                    │        │                    │
                    │        ▼                    │
                    │  ┌─────────────────────┐    │
                    │  │  Output Capture     │    │
                    │  └─────────────────────┘    │
                    └─────────────────────────────┘
```

## Tool Categories

### 1. File Operations
- `read_file` - Read file contents
- `write_file` - Create/overwrite files
- `edit_file` - Replace text in files
- `search_files` - Find files by pattern
- `grep` - Search text in files

### 2. System Operations
- `run_command` - Execute shell commands
- `list_directory` - List directory contents
- `get_diagnostics` - Get code analysis results
- `run_tests` - Execute test suites

### 3. Git Operations
- `git_diff` - Show git differences
- `git_status` - Show working tree status
- `git_stage` - Stage files for commit
- `git_commit` - Create commits
- `git_log` - Show commit history
- `git_push` - Push changes
- `git_pull` - Pull changes
- `git_branch` - Manage branches
- `git_stash` - Stash changes

### 4. Custom Tools
- Configurable via settings
- Execute arbitrary shell commands
- Can access input via environment variables

### 5. MCP Integration
- External tool servers
- Dynamic tool discovery
- Protocol-based communication

### 6. Sub-agent Spawning
- `spawn_agent` - Create parallel agent instances
- For complex tasks that can be broken down
- Inherits same toolset and context

### 7. Diagram Display
- `display_diagram` - Extract and display diagrams from markdown files
- Parses markdown files to find diagram code blocks (mermaid, graphviz, plantuml, etc.)
- Returns specified diagram by index for display in the chat interface

## Approval System

```
┌─────────────────────────────────────────────────────────────────┐
│                        Tool Execution                           │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Approval Mode                            ││
│  │                                                             ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           ││
│  │  │   Ask       │  │   Allow     │  │   Deny      │           ││
│  │  │  (prompt)   │  │  (auto)     │  │  (skip)     │           ││
│  │  └─────────────┘  └─────────────┘  └─────────────┘           ││
│  └─────────────────────────────────────────────────────────────┘│
│        │                    │                    │           │
│        ▼                    ▼                    ▼           │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Tool Execution                           ││
│  │                                                             ││
│  │  ┌─────────────────────────────────────────────────────────┐│
│  │  │                    Security Scan                        ││
│  │  └─────────────────────────────────────────────────────────┘│
│  │                                                             ││
│  │  ┌─────────────────────────────────────────────────────────┐│
│  │  │                    VS Code API                          ││
│  │  │  - File operations                                      ││
│  │  │  - Git operations                                       ││
│  │  │  - Terminal commands                                    ││
│  │  │  - Language diagnostics                                 ││
│  │  └─────────────────────────────────────────────────────────┘│
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Tool Execution Pipeline

1. **Approval Check** - Determine if tool requires user approval
2. **Security Scan** - Scan for potential security issues (especially file operations)
3. **Tool Execution** - Run the tool with appropriate context
4. **Output Capture** - Collect and format tool results
5. **Result Processing** - Add results to conversation history