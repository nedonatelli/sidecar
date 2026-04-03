export interface OllamaMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface OllamaStreamChunk {
  model: string;
  message: OllamaMessage;
  done: boolean;
}
