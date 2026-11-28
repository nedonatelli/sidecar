/**
 * Pure message-builder helpers for the chat webview lifecycle.
 *
 * Extracted from ChatViewProvider.resolveWebviewView / pushUiSettings so
 * the construction logic is testable without instantiating ChatViewProvider
 * (which requires a live WebviewView + all its deps).
 */

import * as path from 'path';
import type { ExtensionMessage } from './chatWebview.js';
import { detectProvider, type SideCarConfig } from '../config/settings.js';

/** Config keys whose changes should trigger a UI settings push. */
export const UI_CONFIG_KEYS = [
  'sidecar.chatDensity',
  'sidecar.chatFontSize',
  'sidecar.chatAccentColor',
  'sidecar.voice.enabled',
] as const;

export function buildUiSettingsMessage(cfg: {
  chatDensity: 'compact' | 'normal' | 'comfortable';
  chatFontSize: number;
  chatAccentColor: string;
  voiceEnabled: boolean;
}): ExtensionMessage {
  return {
    command: 'uiSettings',
    chatDensity: cfg.chatDensity,
    chatFontSize: cfg.chatFontSize,
    chatAccentColor: cfg.chatAccentColor,
    voiceEnabled: cfg.voiceEnabled,
  };
}

/**
 * Config keys whose changes should re-sync the header's Thinking switch: its
 * value, and the backend that decides whether the switch is shown at all.
 */
export const THINKING_CONFIG_KEYS = ['sidecar.ollama.disableThinking', 'sidecar.baseUrl', 'sidecar.provider'] as const;

/**
 * The header's Thinking switch state. Shown only when the active backend is
 * Ollama, the one backend that reads `ollama.disableThinking`; on means the
 * setting is false.
 */
export function buildThinkingStateMessage(
  cfg: Pick<SideCarConfig, 'baseUrl' | 'provider' | 'ollamaDisableThinking'>,
): ExtensionMessage {
  return {
    command: 'thinkingState',
    thinkingSupported: detectProvider(cfg.baseUrl, cfg.provider) === 'ollama',
    thinkingEnabled: cfg.ollamaDisableThinking !== true,
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
