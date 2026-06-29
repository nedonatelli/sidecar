// Pure helpers for the "What's New on update" feature. No VS Code imports so
// the extraction + rendering logic is unit-testable in isolation; the activation
// wiring (globalState, notification, webview) lives in whatsNewSetup.ts.

/**
 * Decide whether to auto-show the "What's New" toast on activation. Pure so the
 * (slightly fiddly) first-install logic is unit-tested without VS Code.
 *
 * Rules:
 * - Off when disabled, when there's no current version, or when the user has
 *   already seen this exact version.
 * - On only for an **existing** user: one who has either recorded a version
 *   before (`lastSeen` defined) OR has other SideCar state in globalState
 *   (`hadPriorState` — they ran a build from before this feature existed).
 * - A truly fresh install has neither, and gets the getting-started walkthrough
 *   instead of a changelog popup.
 *
 * The `hadPriorState` arm is what lets an existing user see the notes the first
 * time they update into a What's-New-bearing build, instead of being silently
 * treated like a brand-new install.
 */
export function shouldPromptWhatsNew(opts: {
  currentVersion: string;
  lastSeen: string | undefined;
  hadPriorState: boolean;
  enabled: boolean;
}): boolean {
  if (!opts.enabled || !opts.currentVersion) return false;
  if (opts.lastSeen === opts.currentVersion) return false;
  return opts.lastSeen !== undefined || opts.hadPriorState;
}

/**
 * Extract the changelog body for a single version. Matches a `## [<version>]`
 * heading (the Keep-a-Changelog format used by CHANGELOG.md) and returns
 * everything up to the next `## [` heading, trimmed. Returns null when the
 * version has no section (e.g. an unreleased dev build).
 */
export function extractVersionSection(changelog: string, version: string): string | null {
  const lines = changelog.split('\n');
  // Heading looks like: "## [0.114.47] - 2026-06-28"
  const headingPrefix = `## [${version}]`;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(headingPrefix)) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## [')) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Minimal, safe Markdown→HTML for the subset CHANGELOG.md actually uses:
 * `### headings`, `- ` list items, `**bold**`, `` `code` ``, and `[text](url)`
 * links. Everything is HTML-escaped first, so raw `<`/`>`/`&` in entries can't
 * inject markup; only the whitelisted patterns are then re-expanded.
 */
export function changelogMarkdownToHtml(markdown: string): string {
  const inline = (text: string): string =>
    escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // [label](url) — link text is $1, destination is $2.
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|[^):\s]+)\)/g, '<a href="$2">$1</a>');

  const out: string[] = [];
  let inList = false;
  const closeList = (): void => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('### ')) {
      closeList();
      out.push(`<h3>${inline(line.slice(4))}</h3>`);
    } else if (line.startsWith('## ')) {
      closeList();
      out.push(`<h2>${inline(line.slice(3))}</h2>`);
    } else if (/^[-*] /.test(line)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('\n');
}

/** Full webview HTML document for a version's release notes. */
export function buildWhatsNewHtml(version: string, sectionMarkdown: string | null, cspSource: string): string {
  const body =
    sectionMarkdown && sectionMarkdown.length > 0
      ? changelogMarkdownToHtml(sectionMarkdown)
      : `<p>Release notes for v${escapeHtml(version)} aren't bundled in this build. See the <a href="https://github.com/nedonatelli/sidecar/blob/main/CHANGELOG.md">full changelog</a>.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} https:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>What's New in SideCar</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); line-height: 1.5; padding: 0 24px 32px; max-width: 760px; }
  h1 { font-size: 1.5rem; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px; }
  h2 { font-size: 1.15rem; margin-top: 1.6em; }
  h3 { font-size: 1rem; color: var(--vscode-textLink-foreground); margin-top: 1.4em; }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
  a { color: var(--vscode-textLink-foreground); }
  li { margin: 6px 0; }
  ul { padding-left: 22px; }
</style>
</head>
<body>
<h1>What's New in SideCar v${escapeHtml(version)}</h1>
${body}
</body>
</html>`;
}
