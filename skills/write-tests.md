---
name: Write Tests
description: Generate unit or integration tests for existing code, matching the project's test framework and patterns
---

# Write Tests

Generate tests for the specified code, following the project's existing test conventions.

## Process

1. **Detect test framework** — search for existing test files with `search_files` to identify:
   - Framework: Jest, Vitest, Mocha, pytest, Go test, etc.
   - File naming: `*.test.ts`, `*.spec.ts`, `*_test.go`, `test_*.py`
   - Test location: co-located, `__tests__/`, `test/`, `tests/`
   - Import patterns, assertion style, mock setup

2. **Read the source code** — understand what to test:
   - Public API surface (exported functions, class methods)
   - Input types and edge cases
   - Error conditions and error types
   - Side effects (file I/O, network, state mutations)

3. **Read existing tests** — match the project's style:
   - Describe/it nesting pattern
   - Setup/teardown patterns (beforeEach, fixtures)
   - Mock/stub patterns
   - Assertion library (expect, assert, chai)

4. **Generate tests covering:**
   - Happy path (normal inputs produce expected outputs)
   - Edge cases (empty, null, undefined, boundary values)
   - Error cases (invalid inputs, thrown errors)
   - If applicable: async behavior, timeout handling

5. **Write the test file** with `write_file`
6. **Run the tests** with `run_tests` to verify they pass
7. Fix any failures — the tests should pass against the current code

## Rules

- Match the project's existing test style exactly
- Don't test private/internal functions unless there's no public API
- Prefer testing behavior over implementation details
- Each test should be independent — no order dependencies
- Use descriptive test names that explain the scenario and expected outcome
