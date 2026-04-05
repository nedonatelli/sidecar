import type { Memento } from 'vscode';
import type { ChatMessage } from '../ollama/types.js';
import { getContentText } from '../ollama/types.js';

export interface SavedSession {
  id: string;
  name: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'sidecar.sessions';

export class SessionManager {
  constructor(private globalState: Memento) {}

  save(name: string, messages: ChatMessage[]): SavedSession {
    const sessions = this.list();
    // Strip images for storage
    const cleanMessages = messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : getContentText(m.content),
    }));

    const session: SavedSession = {
      id: `session_${Date.now()}`,
      name,
      messages: cleanMessages,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    sessions.push(session);
    this.globalState.update(STORAGE_KEY, sessions);
    return session;
  }

  list(): SavedSession[] {
    return this.globalState.get<SavedSession[]>(STORAGE_KEY, []);
  }

  load(id: string): SavedSession | undefined {
    return this.list().find(s => s.id === id);
  }

  delete(id: string): void {
    const sessions = this.list().filter(s => s.id !== id);
    this.globalState.update(STORAGE_KEY, sessions);
  }
}
