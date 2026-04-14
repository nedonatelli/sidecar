## Open the chat

Press `⌘⇧I` (Mac) or `Ctrl+Shift+I` (Windows/Linux) to toggle the SideCar chat panel. You can also click the SideCar icon in the Activity Bar.

**Things to try in the chat:**

- Ask a plain question: `What does this file do?`
- Reference a file inline: `@file:src/extension.ts summarize this`
- Pin files for persistent context: `@pin:src/config/settings.ts`
- Paste a URL to include the page content as context
- Right-click any message to copy, delete, or re-run

**Agent modes** in the header dropdown control how much autonomy the agent has:

| Mode | Behavior |
|------|----------|
| `cautious` | Asks before destructive tools (default) |
| `autonomous` | Runs every allowed tool without asking |
| `manual` | Asks before every tool |
| `plan` | Generates a plan for approval first, then executes |
| `review` | Queues file edits for your review — nothing hits disk |

Click "Open Chat" below to jump straight in.
