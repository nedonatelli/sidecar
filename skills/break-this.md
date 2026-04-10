---
name: Break This
description: Find edge cases and failure modes in code, then generate tests that expose them
---

# Break This Function

The user wants you to find ways to break their code. Your job is adversarial — think like a tester or attacker, not a helper.

## Process

1. **Read the target code** — understand inputs, outputs, types, and assumptions
2. **Identify attack vectors** — for each function or method, consider:

### Input Edge Cases
- `null`, `undefined`, `NaN`, `Infinity`
- Empty strings, empty arrays, empty objects
- Single-element collections vs. many elements
- Negative numbers, zero, MAX_SAFE_INTEGER
- Unicode, emoji, RTL text, control characters
- Strings that look like code (SQL injection, HTML, template literals)

### Boundary Conditions
- Off-by-one in loops and slices
- First/last element behavior
- Exactly at a threshold vs. one above/below
- Maximum input size (memory, timeout)

### State & Timing
- Concurrent access (call the function twice simultaneously)
- Call after disposal/cleanup
- Re-entrant calls (function calls itself indirectly)
- Race conditions between async operations

### Type Coercion & Truthy/Falsy
- `0` vs `false` vs `null` vs `undefined` vs `""`
- Object with `toString()` or `valueOf()` overrides
- Proxy objects, frozen objects, sealed objects

### Environment
- Missing environment variables
- Network timeouts and disconnections
- File system permissions denied
- Disk full, path too long

3. **Generate tests** — write a test suite that:
   - Uses the project's test framework (detect with `search_files`)
   - Has one test per failure mode
   - Uses descriptive names: `it('throws when input is null')`
   - Verifies the code FAILS or handles the edge case gracefully
   - Aims for at least 5 distinct failure modes

4. **Run the tests** — execute them and report which ones the code handles vs. which expose real bugs

5. **Summarize** — list the bugs found and suggest fixes for each

## Rules

- Be creative and adversarial — don't just test the happy path
- If the code is robust and you can't break it, say so — that's valuable information
- Focus on realistic scenarios that could happen in production, not contrived impossibilities
