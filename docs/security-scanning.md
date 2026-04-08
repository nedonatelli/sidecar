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
