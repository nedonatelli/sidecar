import { describe, it, expect } from 'vitest';
import { isGenericClarification, CANNED_CLARIFICATION } from './genericClarification.js';

describe('isGenericClarification', () => {
  it('matches the observed lost-model questions', () => {
    // Live from the v0.119 dogfood pass: llama3.2 on a bare "hi".
    expect(isGenericClarification('What do you want me to do?')).toBe(true);
    expect(isGenericClarification('What would you like me to do?')).toBe(true);
    expect(isGenericClarification('How can I help you today?')).toBe(true);
    expect(isGenericClarification('What should I do next?')).toBe(true);
    expect(isGenericClarification('What can I help with?')).toBe(true);
    expect(isGenericClarification('Please provide more details.')).toBe(true);
    expect(isGenericClarification('Could you clarify?')).toBe(true);
    expect(isGenericClarification("What's your request?")).toBe(true);
    expect(isGenericClarification('')).toBe(true);
  });

  it('NEVER matches task-specific questions — a false positive destroys real clarification', () => {
    expect(isGenericClarification('Which of the two greet functions should I rename?')).toBe(false);
    expect(isGenericClarification('Which auth flow should the callback use?')).toBe(false);
    expect(isGenericClarification('Should I update the tests in fs.test.ts too?')).toBe(false);
    expect(isGenericClarification('Do you want the port changed in config/app.json or .env?')).toBe(false);
    expect(isGenericClarification('The file has three clamp functions — which one?')).toBe(false);
    expect(isGenericClarification('What do you want the new function to return?')).toBe(false);
    expect(isGenericClarification('What should I do about the failing test in loop.test.ts?')).toBe(false);
  });

  it('treats long questions as specific regardless of phrasing', () => {
    const long = 'What do you want me to do about the circular dependency between loop.ts and executor.ts here?';
    expect(isGenericClarification(long)).toBe(false);
  });
});

describe('CANNED_CLARIFICATION', () => {
  it('fits the ask_user card constraints (≤5 short options, custom allowed)', () => {
    expect(CANNED_CLARIFICATION.options.length).toBeLessThanOrEqual(5);
    expect(CANNED_CLARIFICATION.allowCustom).toBe(true);
    for (const o of CANNED_CLARIFICATION.options) {
      expect(o.length).toBeLessThanOrEqual(30);
    }
  });
});
