# SideCar Agent Loop Architecture

## High-Level Flow

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   User Input    │───▶│   Chat Handler  │───▶│   Agent Loop    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                               │
                                               ▼
                                    ┌─────────────────┐
                                    │   LLM Request   │
                                    │   (with tools)  │
                                    └─────────────────┘
                                               │
                                               ▼
                                    ┌─────────────────┐
                                    │   Tool Execution│
                                    │   (parallel)    │
                                    └─────────────────┘
                                               │
                                               ▼
                                    ┌─────────────────┐
                                    │   Tool Results  │
                                    │   (feedback)    │
                                    └─────────────────┘
                                               │
                                               ▼
                                    ┌─────────────────┐
                                    │   Agent Loop    │
                                    │   (continue)    │
                                    └─────────────────┘
                                               │
                                               ▼
                                    ┌─────────────────┐
                                    │   Final Output  │
                                    │   (to user)     │
                                    └─────────────────┘
```

## Detailed Agent Loop Steps

### 1. Initialization
- Load chat history and context
- Initialize tool registry
- Set up abort signal for cancellation
- Configure iteration limits and token budgets

### 2. Context Management
- Check token budget and compress context if needed
- Summarize conversation history when approaching limits
- Truncate old tool results to maintain context window

### 3. LLM Interaction
- Send conversation history to LLM
- Include available tools in the request
- Stream response from LLM
- Parse text-based tool calls if structured tool_use not provided

### 4. Tool Execution
- Execute tools in parallel for better performance
- Handle special cases like `spawn_agent`
- Apply approval modes (ask/allow/deny) for tool execution
- Collect tool output and errors

### 5. Feedback Loop
- Add tool results to conversation history
- Auto-fix errors after file operations
- Continue loop if tools were used
- Stop when no more tools or iteration limit reached

### 6. Termination
- Return final conversation history
- Log completion metrics
- Handle user cancellation