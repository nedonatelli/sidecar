---
name: agent-dx-cli-scale
description: A scoring scale for evaluating how well a CLI is designed for AI agents, based on the "Rewrite Your CLI for AI Agents" principles.
source: google-labs-code/design.md
---

# Agent DX CLI Scale

Use this skill to **evaluate any CLI** against the principles of agent-first design. Score each axis from 0–3, then sum for a total between 0–21.

> Human DX optimizes for discoverability and forgiveness.
> Agent DX optimizes for predictability and defense-in-depth.

---

## Scoring Axes

### 1. Machine-Readable Output
| Score | Criteria |
| ----- | -------- |
| 0 | Human-only output (tables, color codes, prose). No structured format. |
| 1 | `--output json` exists but is incomplete or inconsistent. |
| 2 | Consistent JSON output across all commands including errors. |
| 3 | NDJSON streaming for paginated results; structured output is default in non-TTY. |

### 2. Raw Payload Input
| Score | Criteria |
| ----- | -------- |
| 0 | Only bespoke flags. No way to pass structured input. |
| 1 | Accepts `--json` or stdin for some commands. |
| 2 | All mutating commands accept a raw JSON payload mapping to the API schema. |
| 3 | Raw payload is first-class alongside convenience flags; zero translation loss. |

### 3. Schema Introspection
| Score | Criteria |
| ----- | -------- |
| 0 | Only `--help` text. No machine-readable schema. |
| 1 | `--help --json` for some surfaces, but incomplete. |
| 2 | Full schema introspection for all commands as JSON. |
| 3 | Live, runtime-resolved schemas including scopes, enums, and nested types. |

### 4. Context Window Discipline
| Score | Criteria |
| ----- | -------- |
| 0 | Returns full API responses with no field limiting or pagination. |
| 1 | `--fields` or field masks on some commands. |
| 2 | Field masks on all read commands; pagination with `--page-all`. |
| 3 | Streaming pagination; explicit guidance on field mask usage; actively protects against token waste. |

### 5. Input Hardening
| Score | Criteria |
| ----- | -------- |
| 0 | No input validation beyond basic type checks. |
| 1 | Some validation, but misses agent-specific hallucination patterns. |
| 2 | Rejects path traversals (`../`), percent-encoded segments, embedded query params in resource IDs. |
| 3 | All of the above plus output path sandboxing to CWD and explicit "agent is not a trusted operator" posture. |

### 6. Safety Rails
| Score | Criteria |
| ----- | -------- |
| 0 | No dry-run mode. No response sanitization. |
| 1 | `--dry-run` exists for some mutating commands. |
| 2 | `--dry-run` for all mutating commands. |
| 3 | Dry-run plus response sanitization to defend against prompt injection in API data. |

### 7. Agent Knowledge Packaging
| Score | Criteria |
| ----- | -------- |
| 0 | Only `--help` and a docs site. No agent-specific context files. |
| 1 | A `CONTEXT.md` or `AGENTS.md` with basic usage guidance. |
| 2 | Structured skill files (YAML frontmatter + Markdown) per command/surface. |
| 3 | Comprehensive skill library with agent-specific guardrails, versioned and discoverable. |

---

## Interpreting the Total

| Range | Rating | Description |
| ----- | ------ | ----------- |
| 0–5 | **Human-only** | Agents will struggle with parsing, hallucinate inputs, lack safety rails. |
| 6–10 | **Agent-tolerant** | Usable but wastes tokens and requires heavy prompt engineering. |
| 11–15 | **Agent-ready** | Solid structured I/O and validation; a few gaps remain. |
| 16–21 | **Agent-first** | Full introspection, input hardening, safety rails, and packaged knowledge. |

---

## Bonus: Multi-Surface Readiness

- [ ] **MCP (stdio JSON-RPC)** — typed tool invocation, no shell escaping
- [ ] **Extension / plugin install** — agent treats the CLI as a native capability
- [ ] **Headless auth** — env vars for tokens/credentials, no browser redirect
