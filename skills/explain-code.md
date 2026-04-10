---
name: Explain Code
description: Explain how code works with clear annotations, data flow, and key design decisions
---

# Explain Code

The user wants to understand how a piece of code works. Provide a clear, layered explanation.

## Process

1. Read the file(s) the user is asking about
2. Identify the key components: entry points, data flow, dependencies, side effects
3. Explain at multiple levels:

### High-Level Summary (2-3 sentences)
What does this code do? What problem does it solve?

### Key Components
For each major function/class/module:
- **Purpose** — what it does in one line
- **Inputs/Outputs** — what goes in, what comes out
- **Side effects** — files written, network calls, state mutations

### Data Flow
Trace the flow of data through the code: where it enters, how it's transformed, where it exits. Use a numbered sequence or mermaid diagram if helpful.

### Design Decisions
Explain non-obvious choices: why this pattern, why this library, what are the tradeoffs.

### Gotchas
Call out anything surprising: implicit dependencies, hidden state, performance cliffs, known limitations.

## Style

- Use the user's experience level as a guide — if they're asking basic questions, explain fundamentals; if advanced, focus on architecture and tradeoffs
- Reference specific line numbers with `file:line` format
- Use code snippets to illustrate key points
- If the code has issues, mention them briefly but keep the focus on explanation
