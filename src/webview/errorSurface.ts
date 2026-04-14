import { window, commands, type MessageItem } from 'vscode';
import { healthStatus } from '../ollama/healthStatus.js';

/**
 * High-severity errors that warrant a native VS Code toast in addition
 * to the inline chat message. The set is deliberately narrow: we only
 * promote errors where the user has a clear recovery action to take.
 * Tool failures, validation errors, and transient hiccups stay in-chat
 * so we don't bury the user under toast spam.
 */
const TOAST_ERROR_TYPES = new Set<string>(['auth', 'connection', 'model']);

export interface ClassifiedError {
  errorType?: string;
  errorAction?: string;
  errorActionCommand?: string;
}

export interface ToastAction {
  label: string;
  /** VS Code command ID to execute when the user clicks this action. */
  command: string;
  /** Optional arguments forwarded to the command. */
  args?: unknown[];
}

/**
 * Map a classified chat error to the native actions we want to offer.
 * The first action is the most likely recovery; actions render as
 * buttons in the `showErrorMessage` toast in the order returned.
 */
export function actionsForError(classified: ClassifiedError): ToastAction[] {
  switch (classified.errorType) {
    case 'auth':
      return [
        { label: 'Set API Key', command: 'sidecar.setApiKey' },
        { label: 'Switch Backend', command: 'sidecar.switchBackend' },
      ];
    case 'connection':
      return [
        { label: 'Switch Backend', command: 'sidecar.switchBackend' },
        { label: 'Set API Key', command: 'sidecar.setApiKey' },
      ];
    case 'model':
      return [
        { label: 'Open Model Picker', command: 'sidecar.discoverModels' },
        { label: 'Switch Backend', command: 'sidecar.switchBackend' },
      ];
    default:
      return [];
  }
}

/**
 * Trim an error message to something fit for a toast title. VS Code
 * truncates long toast bodies awkwardly, so we cap the message and
 * drop stack traces / request IDs that the user can't act on.
 */
function formatForToast(message: string): string {
  // Strip common noise: "Anthropic API request failed: 401 Unauthorized — {...}"
  // becomes "Anthropic: 401 Unauthorized".
  const cleaned = message
    .replace(/\s*—\s*\{[^}]*\}\s*$/, '')
    .replace(/API request failed:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
  return cleaned.length > 200 ? cleaned.slice(0, 197) + '...' : cleaned;
}

/**
 * Show a native error toast for a classified chat error, if the error
 * type is in the promotion set. Action buttons execute real VS Code
 * commands, so clicking "Set API Key" opens the same prompt as the
 * command palette entry — users get a guided recovery path instead of
 * a dead-end "Cannot connect" message.
 *
 * Returns true if a toast was shown, false otherwise. Callers should
 * still post the inline chat error regardless; the toast is additive.
 */
export async function surfaceNativeToast(rawMessage: string, classified: ClassifiedError): Promise<boolean> {
  if (!classified.errorType || !TOAST_ERROR_TYPES.has(classified.errorType)) {
    return false;
  }
  // Record health before awaiting the toast so the status bar turns
  // red immediately — the user shouldn't have to dismiss a modal to
  // see that SideCar is down.
  const pretty = formatForToast(rawMessage);
  healthStatus.setError(pretty, rawMessage);

  const actions = actionsForError(classified);
  const items: MessageItem[] = actions.map((a) => ({ title: a.label }));
  const body = `SideCar — ${pretty}`;
  const picked = await window.showErrorMessage(body, ...items);
  if (!picked) return true;
  const match = actions.find((a) => a.label === picked.title);
  if (match) {
    void commands.executeCommand(match.command, ...(match.args ?? []));
  }
  return true;
}

/**
 * Promote a plain-string error to a native toast with an inferred
 * recovery action. Used by non-chat handlers (model list load,
 * provider reachability checks) that don't go through the full
 * classifyError pipeline but still know the error kind.
 */
export async function surfaceProviderError(message: string, kind: 'auth' | 'connection' | 'model'): Promise<void> {
  await surfaceNativeToast(message, { errorType: kind });
}
