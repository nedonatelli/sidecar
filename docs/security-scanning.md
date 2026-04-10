---
title: Security Scanning
layout: docs
nav_order: 7
---

# Security Scanning

SideCar automatically scans files for secrets and vulnerabilities after every agent write operation. No configuration needed — it's built in.

## Secrets detection

SideCar detects the following secret patterns in code:

- **AWS keys** — access key IDs and secret access keys
- **GitHub tokens** — personal access tokens (`ghp_`, `gho_`, `ghs_`)
- **API keys** — generic API key patterns
- **Private keys** — RSA, DSA, EC private key headers
- **JWTs** — JSON Web Tokens (`eyJ...`)
- **Connection strings** — database connection URIs with credentials
- **Anthropic/OpenAI keys** — `sk-ant-`, `sk-` prefixed keys

When a secret is detected, SideCar flags it in the tool result and warns the agent, which can then redact or remove it.

## Vulnerability scanning

SideCar also flags common vulnerability patterns:

| Pattern | Risk |
|---------|------|
| SQL string concatenation | SQL injection |
| `child_process.exec` with variables | Command injection |
| `innerHTML` assignment | Cross-site scripting (XSS) |
| `eval()` usage | Code injection |
| `http://` URLs (non-localhost) | Insecure transport |

## Diagnostics integration

Security findings are included in the `get_diagnostics` tool output alongside compiler errors and warnings. This means the agent loop can detect and fix security issues automatically during its verification step.

## Pre-commit scanning

Scan staged files before committing:

- Type `/scan` in the chat
- Or run `SideCar: Scan Staged Files for Secrets` from the command palette

This reads the staged version of each file (via `git show`) and reports any findings in a markdown panel. Use it as a final check before pushing code.

## What gets skipped

To reduce false positives, SideCar skips:

- Comments and documentation strings
- `node_modules/` and other dependency directories
- Lock files (`package-lock.json`, `yarn.lock`, etc.)
- Minified files

## Workspace trust

SideCar warns once per session when workspace-level settings define potentially dangerous configurations. This protects against supply-chain attacks where a malicious `.vscode/settings.json` is committed to a repository.

Trust warnings appear for:

- **MCP server configs** (`sidecar.mcpServers`) — can spawn arbitrary processes
- **Tool permission overrides** (`sidecar.toolPermissions`) — can auto-allow dangerous tools like `write_file`
- **Hook commands** (`sidecar.hooks`) — execute shell commands on tool invocations

When prompted, choose **Allow** to trust the workspace config for this session, or **Block** to ignore the workspace-level settings and fall back to your user-level defaults. The decision is remembered for the session — you won't be asked again until you restart VS Code.

## Path traversal protection

`@file:` and `@folder:` references in chat messages are validated to ensure they resolve within the workspace root. Paths containing `../` that would escape the workspace are blocked with a warning. This prevents prompt injection attacks from tricking the agent into reading sensitive files outside the project.

## Tool approval defaults

When no explicit confirmation function is available (e.g., headless or programmatic usage), tool calls default to **deny**. This ensures tools that require approval (file writes, shell commands, git operations) are never auto-approved without a UI to confirm them.

## SVG sanitization

Mermaid diagrams and any SVG content rendered in chat are sanitized using a DOM parser with an allowlist of safe SVG elements. Dangerous elements (`<script>`, `<animate>`, `<set>`) are removed. `<style>` tags are preserved (needed for diagram theming) but `@import` and `url()` directives are stripped. Links (`<a>`) are restricted to fragment-only (`#`) hrefs.
