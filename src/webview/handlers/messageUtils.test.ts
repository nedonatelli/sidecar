import { describe, it, expect } from 'vitest';
import { resolveToolTier } from './messageUtils.js';

describe('resolveToolTier', () => {
  it('returns full for empty input', () => {
    expect(resolveToolTier('')).toBe('full');
  });

  it('returns full for messages longer than 300 chars', () => {
    expect(resolveToolTier('a'.repeat(301))).toBe('full');
  });

  it('returns read for plain what-is questions', () => {
    expect(resolveToolTier('what is the agent loop?')).toBe('read');
    expect(resolveToolTier('what does read_file do?')).toBe('read');
    expect(resolveToolTier('what are the backends?')).toBe('read');
  });

  it('returns read for how-does questions', () => {
    expect(resolveToolTier('how does compression work?')).toBe('read');
    expect(resolveToolTier('how does the MCP server connect?')).toBe('read');
  });

  it('returns read for explain/describe prompts', () => {
    expect(resolveToolTier('explain the tool registry')).toBe('read');
    expect(resolveToolTier('describe the shadow workspace flow')).toBe('read');
  });

  it('returns read for where-is queries', () => {
    expect(resolveToolTier('where is the auth middleware defined?')).toBe('read');
    expect(resolveToolTier('where are the test fixtures?')).toBe('read');
  });

  it('returns read for find/search/list queries', () => {
    expect(resolveToolTier('find all usages of runAgentLoop')).toBe('read');
    expect(resolveToolTier('search for TODO comments')).toBe('read');
    expect(resolveToolTier('list all the registered tools')).toBe('read');
  });

  it('returns full when action words are present even with a question prefix', () => {
    expect(resolveToolTier('how do I fix this bug?')).toBe('full');
    expect(resolveToolTier('what should I add to the config?')).toBe('full');
    expect(resolveToolTier('explain how to refactor this')).toBe('full');
    expect(resolveToolTier('where should I create the new file?')).toBe('full');
  });

  it('returns full for imperative action messages', () => {
    expect(resolveToolTier('fix the failing test')).toBe('full');
    expect(resolveToolTier('add a new endpoint')).toBe('full');
    expect(resolveToolTier('refactor the auth module')).toBe('full');
    expect(resolveToolTier('run the test suite')).toBe('full');
    expect(resolveToolTier('commit the changes')).toBe('full');
  });

  it('returns full for messages with no clear information prefix', () => {
    expect(resolveToolTier('the tests are failing')).toBe('full');
    expect(resolveToolTier('something is broken')).toBe('full');
  });

  it('is case-insensitive', () => {
    expect(resolveToolTier('What is the loop state?')).toBe('read');
    expect(resolveToolTier('HOW DOES the agent work?')).toBe('read');
    expect(resolveToolTier('FIX the bug')).toBe('full');
  });
});
