## Discover every action via the Command Palette

Press `⌘⇧P` (Mac) or `Ctrl+Shift+P` and type **`SideCar:`**. Every user-facing action is surfaced there with a consistent `SideCar: <name>` format and appropriate icons.

**Most useful commands:**

| Command | What it does |
|---------|---|
| `SideCar: Toggle Chat` | Open or hide the chat sidebar |
| `SideCar: Inline Chat` | Inline prompt in the editor |
| `SideCar: Set / Refresh API Key` | Paste or rotate your key |
| `SideCar: Switch Backend` | Pick Ollama, Anthropic, OpenAI, or Kickstand |
| `SideCar: Show Session Spend` | Breakdown of tokens & $ for paid backends |
| `SideCar: Review Changes` | Get an AI review of your working tree |
| `SideCar: Summarize Pull Request` | Fetch a PR and generate a summary |
| `SideCar: Generate Commit Message` | Stage files first, then let SideCar write the message |
| `SideCar: Scan Staged Files for Secrets` | Pre-commit secret scan |

### Problems panel integration

When SideCar's security scanner detects a leaked secret or a stub in code it just wrote, the finding shows up in the **Problems** panel (`⌘⇧M`) with the source tag `sidecar-secrets`, `sidecar-vulns`, or `sidecar-stubs`. Click the entry to jump to the offending line.

### Pending changes

In `review` mode, any file the agent proposes to change gets a **P** badge in the Explorer and the editor tabs, matching how git marks modified files. The **Pending Agent Changes** view in the sidebar shows the full list — accept or discard individually or in bulk.

### Advanced features

- **Slash commands** — `/init`, `/help`, `/doc`, `/spec`, `/insight`, `/scan`, `/usage`, `/context`, `/test`, `/lint`, `/deps`, `/scaffold`, `/commit`, `/verbose`, `/prompt`, `/audit`, `/insights`, `/mcp`, `/bg`, `/move`, `/clone`, `/skills`, `/releases`, `/release`
- **Background agents** — `/bg <task>` to run tasks in parallel
- **MCP integration** — connect external tools via Model Context Protocol
- **Custom skills** — create your own AI capabilities with markdown files

---

**You're set.** SideCar's settings live under `SideCar:` in the VS Code Settings UI. If you ever need to revisit this walkthrough, open the Command Palette and run `SideCar: Open Walkthrough`.

### Need help?

- Visit [SideCar Documentation](https://nedonatelli.github.io/sidecar/)
- Report issues on [GitHub Issues](https://github.com/nedonatelli/sidecar/issues)
- Browse the source on [GitHub](https://github.com/nedonatelli/sidecar)
