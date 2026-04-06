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
  state.messages = session.messages;
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
