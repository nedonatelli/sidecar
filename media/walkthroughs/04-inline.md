## Inline editing and the lightbulb

SideCar brings AI coding directly into your editor without interrupting your workflow.

### Inline chat — `⌘I` / `Ctrl+I`

With your cursor in any file, hit `⌘I` to open an inline prompt. Type what you want — `"rename this function to fooBar"`, `"add error handling"`, `"write jsdoc for this block"` — and SideCar will stream a diff you can accept or reject without leaving the line you're on.

### Code actions on diagnostics

When VS Code shows a red or yellow squiggle on a line, click the 💡 lightbulb (or press `⌘.` / `Ctrl+.`). Alongside the built-in Quick Fix suggestions you'll see:

- **Fix with SideCar** — ships the diagnostic and surrounding code to the agent, which proposes a repair
- **Explain this error with SideCar** — explains the error message in context
- **Refactor with SideCar** — appears in the Refactor submenu on any selection

These wire into the same code actions provider VS Code uses for `tsc` and `eslint`, so they feel exactly like native fixes.

### Editor context menu

Right-click in any file with a selection to access **Explain Selection**, **Fix Selection**, and **Refactor Selection** directly.
