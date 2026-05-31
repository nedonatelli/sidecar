---
title: Security Scanning
layout: docs
nav_order: 7
nav_section: "Agent"
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

## Dependency Drift Alerts

SideCar scans your manifest files for outdated dependencies and known vulnerabilities.

### What gets scanned

| Manifest | Ecosystem |
|----------|-----------|
| `package.json` | npm |
| `requirements*.txt` | PyPI |
| `Cargo.toml` | crates.io |
| `go.mod` | Go modules |

### How it works

1. **Version check** — fetches the latest stable version from the upstream registry (npm registry, PyPI, crates.io, Go proxy) using a 1-hour in-memory cache to avoid hammering the APIs on every save.
2. **Vulnerability check** — batches a `POST` to the [OSV API](https://osv.dev) (`api.osv.dev/v1/querybatch`) with every resolved version. Returns CVE/GHSA IDs and severity ratings.
3. **Problems panel** — findings surface under `source: sidecar-deps` alongside compiler errors:
   - `Error` — Critical vulnerabilities
   - `Warning` — High / Medium vulnerabilities, or packages with any vulnerability
   - `Information` — Outdated packages (no known vulnerability)

### Triggering a scan

- **Automatic** — a file watcher rescans any manifest 2 seconds after it is saved
- **On startup** — SideCar runs an initial workspace-wide scan when the extension activates
- **On demand** — `SideCar: Scan Dependencies for Drift & Vulnerabilities` from the Command Palette
- **Via the agent** — call `check_dependencies` (optionally with `ecosystem: "npm"` to filter, or `checkVulnerabilities: false` for a fast offline check)

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `sidecar.deps.enabled` | `true` | Master toggle |
| `sidecar.deps.checkVulnerabilities` | `true` | OSV API lookups (disable offline) |

## SVG sanitization

Mermaid diagrams and any SVG content rendered in chat are sanitized using a DOM parser with an allowlist of safe SVG elements. Dangerous elements (`<script>`, `<animate>`, `<set>`) are removed. `<style>` tags are preserved (needed for diagram theming) but `@import` and `url()` directives are stripped. Links (`<a>`) are restricted to fragment-only (`#`) hrefs.
