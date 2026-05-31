---
title: Keyboard Shortcuts
layout: docs
nav_order: 16
---

# Keyboard Shortcuts

All registered SideCar shortcuts are listed below. Every shortcut can be rebound — see [Customizing shortcuts](#customizing-shortcuts) at the bottom of this page.

## Chat Panel

| Action | Mac | Windows / Linux | When |
|--------|-----|-----------------|------|
| Toggle chat panel | `⌘⇧I` | `Ctrl+Shift+I` | Always |
| Clear chat | `⌘L` | `Ctrl+L` | Always |
| Undo all AI changes | `⌘⇧U` | `Ctrl+Shift+U` | Always |
| Export chat as Markdown | `⌘⇧E` | `Ctrl+Shift+E` | Always |

## Inline Edit

| Action | Mac | Windows / Linux | When |
|--------|-----|-----------------|------|
| Open inline chat | `⌘I` | `Ctrl+I` | Editor focused |
| Dismiss inline edit | `Escape` | `Escape` | Editor focused, inline edit pending |

## Agent Actions

| Action | Mac | Windows / Linux | When |
|--------|-----|-----------------|------|
| Undo all AI changes | `⌘⇧U` | `Ctrl+Shift+U` | Always |
| Rename session | `F2` | `F2` | Sessions view focused, item selected |
| Load session | `Enter` | `Enter` | Sessions view focused, item selected |

## Completions

| Action | Mac | Windows / Linux | When |
|--------|-----|-----------------|------|
| Accept next word of inline suggestion | `⌘→` | `Ctrl+Right` | Inline suggestion visible, editor not readonly |

---

## Customizing shortcuts

Open the VS Code keyboard shortcuts editor with `⌘K ⌘S` (Mac) or `Ctrl+K Ctrl+S` (Windows / Linux), then type **SideCar** in the search box to filter to all SideCar bindings. Click the pencil icon next to any entry to rebind it.

To edit `keybindings.json` directly, press `⌘K ⌘S` and click the **Open Keyboard Shortcuts (JSON)** icon in the top-right corner of the editor. Example entry:

```json
[
  {
    "key": "ctrl+shift+i",
    "command": "sidecar.toggleChat"
  },
  {
    "key": "cmd+i",
    "command": "sidecar.inlineChat",
    "when": "editorTextFocus"
  },
  {
    "key": "ctrl+shift+u",
    "command": "sidecar.undoChanges"
  },
  {
    "key": "ctrl+shift+e",
    "command": "sidecar.exportChat"
  },
  {
    "key": "ctrl+l",
    "command": "sidecar.clearChat"
  }
]
```

The full list of bindable SideCar command IDs:

| Command ID | Default action |
|------------|----------------|
| `sidecar.toggleChat` | Toggle chat panel |
| `sidecar.inlineChat` | Open inline chat |
| `sidecar.clearChat` | Clear chat |
| `sidecar.undoChanges` | Undo all AI changes |
| `sidecar.exportChat` | Export chat as Markdown |
| `sidecar.rejectInlineEdit` | Dismiss pending inline edit |
| `sidecar.acceptInlineEdit` | Accept pending inline edit (no default binding) |
| `sidecar.sessions.rename` | Rename session |
| `sidecar.sessions.load` | Load session |
| `sidecar.explainSelection` | Explain selection in chat |
| `sidecar.fixSelection` | Fix selection with agent |
| `sidecar.refactorSelection` | Refactor selection with agent |
