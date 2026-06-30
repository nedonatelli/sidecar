---
title: Architecture Decision Records
layout: docs
nav_order: 22
---

# Architecture Decision Records

Lightweight records of significant architectural decisions made in SideCar.
Format based on [Michael Nygard's ADR template](https://github.com/joelparkerhenderson/architecture-decision-record).

## Index

| ADR                                          | Title                                                                      | Status   | Date    |
| -------------------------------------------- | -------------------------------------------------------------------------- | -------- | ------- |
| [ADR-001](001-local-first-architecture.md)   | Local-first architecture via Ollama                                        | Accepted | 2024-09 |
| [ADR-002](002-agent-loop-over-chat.md)       | Stateful tool-calling agent loop                                           | Accepted | 2024-10 |
| [ADR-003](003-shadow-workspace-isolation.md) | Git worktree shadow workspaces for agent isolation                         | Accepted | 2025-01 |
| [ADR-004](004-flat-vector-store.md)          | FlatVectorStore over dedicated vector DB                                   | Accepted | 2025-02 |
| [ADR-005](005-typed-facets.md)               | Typed sub-agent facets for specialist dispatch                             | Accepted | 2025-03 |
| [ADR-006](006-external-benchmarks.md)        | External standard benchmarks (BFCL / SWE-bench) for tool-use + coding loop | Proposed | 2026-06 |

## Template

```markdown
# ADR-NNN: Title

**Date**: YYYY-MM
**Status**: Proposed | Accepted | Superseded by ADR-NNN | Deprecated

## Context

What is the background and the problem being addressed?

## Decision

What decision was made and why?

## Consequences

What are the positive and negative outcomes? What becomes easier or harder?
```
