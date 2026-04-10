---
name: Debug Issue
description: Systematically diagnose and fix a bug using error messages, logs, and code analysis
---

# Debug an Issue

The user has a bug or error. Diagnose it systematically.

## Process

1. **Gather information**
   - What's the error message or unexpected behavior?
   - Read the relevant file(s) with `read_file`
   - Check `get_diagnostics` for compiler/linter errors
   - If it's a runtime error, look at the stack trace to identify the file and line

2. **Reproduce the context**
   - Search for related code with `grep` to understand how the failing code is called
   - Read test files to understand expected behavior
   - Check recent changes with `git diff` or `git log` if the bug is a regression

3. **Form a hypothesis**
   - Based on the error and code, explain what you think is wrong and why
   - If unsure, list 2-3 possible causes ranked by likelihood

4. **Fix the root cause**
   - Edit the source code (not the test) to fix the actual bug
   - After fixing, run `get_diagnostics` to check for new errors
   - Run `run_tests` to verify the fix

5. **Verify and explain**
   - Confirm the fix resolves the issue
   - Explain what was wrong and why the fix works
   - If the bug could recur, suggest a preventive measure (test, assertion, type guard)

## Rules

- Fix the root cause, not the symptom
- Don't modify tests to make them pass — fix the source code
- If you can't reproduce or identify the bug, say so and suggest next steps
- Search the web with `web_search` if the error message is unfamiliar
