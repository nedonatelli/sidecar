import { window, commands, workspace, ViewColumn, type ExtensionContext, type WebviewPanel } from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../system/logger.js';
import { extractVersionSection, buildWhatsNewHtml, shouldPromptWhatsNew } from './whatsNew.js';

const LAST_SEEN_KEY = 'sidecar.lastSeenVersion';

/**
 * "What's New on update" — on activation, detect a version bump (via globalState)
 * and offer release notes; also registers `sidecar.whatsNew` so users can open
 * them any time. Reads the bundled CHANGELOG.md and renders the current
 * version's section in a webview. Gated by `sidecar.whatsNew.enabled` (default
 * true) for the auto-prompt; the command always works.
 */
export function initWhatsNew(context: ExtensionContext): void {
  const currentVersion: string = context.extension?.packageJSON?.version ?? '';

  let panel: WebviewPanel | undefined;
  const open = (): void => {
    if (panel) {
      panel.reveal(ViewColumn.Active);
      return;
    }
    panel = window.createWebviewPanel('sidecar.whatsNew', "What's New in SideCar", ViewColumn.Active, {
      enableScripts: false,
      retainContextWhenHidden: false,
    });
    panel.onDidDispose(() => {
      panel = undefined;
    });
    const changelog = readBundledChangelog(context.extensionPath);
    const section = changelog ? extractVersionSection(changelog, currentVersion) : null;
    panel.webview.html = buildWhatsNewHtml(currentVersion, section, panel.webview.cspSource);
  };

  context.subscriptions.push(commands.registerCommand('sidecar.whatsNew', open));

  // Auto-prompt on a version change for an existing user, never on a truly
  // fresh install (they get the getting-started walkthrough instead). "Existing"
  // = a recorded version OR any other SideCar globalState — the latter catches
  // users updating in from a build that predates this feature. Capture prior
  // state BEFORE writing our own key so it doesn't count itself.
  const lastSeen = context.globalState.get<string>(LAST_SEEN_KEY);
  const hadPriorState = context.globalState.keys().some((k) => k !== LAST_SEEN_KEY);
  const enabled = workspace.getConfiguration('sidecar').get<boolean>('whatsNew.enabled', true);

  if (currentVersion && lastSeen !== currentVersion) {
    void context.globalState.update(LAST_SEEN_KEY, currentVersion);
  }
  if (shouldPromptWhatsNew({ currentVersion, lastSeen, hadPriorState, enabled })) {
    void window
      .showInformationMessage(`SideCar updated to v${currentVersion}.`, "See what's new")
      .then((choice) => {
        if (choice === "See what's new") open();
      });
  }
}

/** Read the packaged CHANGELOG.md, tolerating either casing across platforms. */
function readBundledChangelog(extensionPath: string): string | null {
  for (const name of ['CHANGELOG.md', 'changelog.md']) {
    try {
      return fs.readFileSync(path.join(extensionPath, name), 'utf-8');
    } catch {
      // try next casing
    }
  }
  logger.warn("[SideCar] What's New: CHANGELOG.md not found in the packaged extension");
  return null;
}
