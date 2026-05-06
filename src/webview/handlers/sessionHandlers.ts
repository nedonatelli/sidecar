import { window } from 'vscode';
import type { ChatState } from '../chatState.js';

export function handleSaveSession(state: ChatState, name: string): void {
  state.sessionManager.save(name, state.messages);
  window.showInformationMessage(`Session "${name}" saved.`);
  handleListSessions(state);
}

export function handleLoadSession(state: ChatState, id: string): void {
  const session = state.sessionManager.load(id);
  if (!session) return;
  state.autoSave(); // Save current conversation before switching
  // Abort any in-flight run and cancel its pending flush-timer so stale
  // assistant-message chunks cannot inject into the newly loaded session.
  state.abort();
  state.cancelCallbacks?.();
  state.abortController = null;
  state.cancelCallbacks = null;
  // Bump the generation so the chatGeneration guard in handleUserMessage
  // fires if the aborted loop completes its final turn before the abort
  // signal propagates through the stream (the loop would return normally
  // and call postLoopProcessing, overwriting the just-loaded session).
  state.chatGeneration++;
  // Tear down the steer listener immediately so an onChange callback can't
  // fire steerEnabled:true into the newly-loaded session before the aborted
  // loop's finally block runs (that block would also clean up, but it runs
  // asynchronously after the next await in the loop).
  state.currentSteerDisposer?.();
  state.currentSteerDisposer = null;
  state.currentSteerQueue = null;
  state.postMessage({ command: 'steerQueueUpdate', steerQueue: [], steerEnabled: false });
  state.messages = session.messages;
  state.currentSessionId = session.id;
  state.saveHistory();
  state.postMessage({ command: 'chatCleared' });
  state.postMessage({ command: 'init', messages: state.messages });
}

export function handleDeleteSession(state: ChatState, id: string): void {
  state.sessionManager.delete(id);
  handleListSessions(state);
}

export function handleListSessions(state: ChatState): void {
  const sessions = state.sessionManager.list();
  const data = sessions.map((s) => ({ id: s.id, name: s.name, createdAt: s.createdAt }));
  state.postMessage({ command: 'sessionList', content: JSON.stringify(data) });
}
