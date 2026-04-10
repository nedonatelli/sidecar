---
name: Code Review
description: Review code changes for bugs, security issues, performance problems, and style consistency
---

# Code Review

Review the specified code or recent changes for quality issues.

## What to Check

1. **Bugs** — logic errors, off-by-one, null/undefined access, race conditions, unhandled errors
2. **Security** — injection vulnerabilities, path traversal, secrets in code, XSS, unsafe eval
3. **Performance** — unnecessary allocations, N+1 patterns, missing caching, blocking operations on hot paths
4. **Readability** — unclear naming, overly complex logic, missing error context, dead code
5. **Edge cases** — empty inputs, large inputs, concurrent access, error paths

## Process

1. If the user specifies files, read them with `read_file`
2. If no files specified, run `git diff` to see recent uncommitted changes
3. For each file, analyze the code against the checklist above
4. Report findings grouped by severity: **Critical**, **Warning**, **Suggestion**
5. For each finding, include the file path, line reference, and a concrete fix

## Output Format

```
## Review: <file or scope>

### Critical
- **[file:line]** Issue description. Fix: ...

### Warnings
- **[file:line]** Issue description. Fix: ...

### Suggestions
- **[file:line]** Suggestion. Rationale: ...
```

Keep findings actionable — every issue should include a fix or clear recommendation.
