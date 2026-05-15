/**
 * Pure message-builder helpers for the chat webview lifecycle.
 *
 * Extracted from ChatViewProvider.resolveWebviewView / pushUiSettings so
 * the construction logic is testable without instantiating ChatViewProvider
 * (which requires a live WebviewView + all its deps).
 */

import * as path from 'path';
import type { ExtensionMessage } from './chatWebview.js';

/** Config keys whose changes should trigger a UI settings push. */
export const UI_CONFIG_KEYS = ['sidecar.chatDensity', 'sidecar.chatFontSize', 'sidecar.chatAccentColor'] as const;

export function buildUiSettingsMessage(cfg: {
  chatDensity: 'compact' | 'normal' | 'comfortable';
  chatFontSize: number;
  chatAccentColor: string;
}): ExtensionMessage {
  return {
    command: 'uiSettings',
    chatDensity: cfg.chatDensity,
    chatFontSize: cfg.chatFontSize,
    chatAccentColor: cfg.chatAccentColor,
  };
}

export function buildAgentModeMessage(cfg: {
  agentMode: string;
  customModes: { name: string; description: string }[];
}): ExtensionMessage {
  return {
    command: 'setAgentMode',
    agentMode: cfg.agentMode,
    customModes: cfg.customModes,
  };
}

/**
 * Build the activeFileChanged message.
 * Pass the absolute file path when an editor is focused, or undefined to
 * clear the active-file bar.
 */
export function buildActiveFileMessage(filePath: string | undefined): ExtensionMessage {
  if (!filePath) return { command: 'activeFileChanged', fileName: undefined };
  return {
    command: 'activeFileChanged',
    fileName: path.basename(filePath),
    filePath,
  };
}
