import { describe, it, expect } from 'vitest';
import type { ApiBackend } from './backend.js';

describe('ApiBackend interface', () => {
  it('defines the expected shape for backend implementations', () => {
    // Verify the interface can be implemented
    const mock: ApiBackend = {
      streamChat: async function* () {
        yield { type: 'text' as const, text: 'hello' };
      },
      complete: async () => 'response',
    };
    expect(mock.streamChat).toBeDefined();
    expect(mock.complete).toBeDefined();
  });
});
