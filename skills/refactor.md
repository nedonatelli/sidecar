---
name: Refactor Code
description: Refactor code for better readability, maintainability, or performance without changing behavior
---

# Refactor Code

Improve code structure without changing external behavior.

## Principles

1. **Preserve behavior** — refactoring must not change what the code does. Run tests before and after.
2. **One thing at a time** — make focused changes, not sweeping rewrites
3. **Verify with tests** — if tests exist, run them after each change. If not, suggest adding them first.

## Process

1. Read the target file(s)
2. Identify the refactoring opportunity:
   - **Extract** — pull duplicated logic into a shared function
   - **Rename** — improve unclear names across all usage sites
   - **Simplify** — reduce nesting, remove dead code, flatten conditionals
   - **Reorganize** — move related code together, split large files
   - **Modernize** — update to current language idioms (async/await, destructuring, etc.)
3. Explain what you'll change and why before making edits
4. Make the changes with `edit_file`
5. Run `get_diagnostics` to check for errors
6. Run tests if available with `run_tests`
7. Summarize what changed

## Rules

- Do NOT add features or fix bugs during a refactor — that's a separate task
- Do NOT change public APIs unless explicitly asked
- Do NOT refactor code you haven't read — always read first
- Keep the diff minimal — only change what's needed
- If the refactoring is risky, suggest a plan and wait for approval
