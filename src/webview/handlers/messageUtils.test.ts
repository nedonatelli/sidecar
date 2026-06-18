import { describe, it, expect } from 'vitest';
import {
  resolveToolTier,
  isRepoReviewRequest,
  isArchReviewAccept,
  isArchReviewDecline,
  classifyReviewFacet,
  runReviewLabel,
  RUN_ARCH_REVIEW_LABEL,
  ANSWER_INLINE_LABEL,
} from './messageUtils.js';

describe('classifyReviewFacet', () => {
  it('routes whole-repo architecture/design reviews to architecture-reviewer', () => {
    expect(classifyReviewFacet('review the design and architecture of this project')?.facetId).toBe(
      'architecture-reviewer',
    );
    expect(classifyReviewFacet('review this codebase')?.facetId).toBe('architecture-reviewer');
  });

  it('routes security audits of the codebase to security-reviewer', () => {
    expect(classifyReviewFacet('audit this codebase for security vulnerabilities')?.facetId).toBe('security-reviewer');
    expect(classifyReviewFacet('review the repo for injection and auth holes')?.facetId).toBe('security-reviewer');
  });

  it('prefers security over architecture when both could match', () => {
    expect(classifyReviewFacet('review the security of this codebase')?.facetId).toBe('security-reviewer');
  });

  it('returns null for single-file or non-review requests', () => {
    expect(classifyReviewFacet('review src/agent/loop.ts')).toBeNull();
    expect(classifyReviewFacet('what is the architecture?')).toBeNull();
    expect(classifyReviewFacet('/review this repo')).toBeNull();
  });

  it('runReviewLabel builds an accept-matching button label', () => {
    const label = runReviewLabel('Security Reviewer');
    expect(label).toContain('Security Reviewer');
    expect(isArchReviewAccept(label)).toBe(true);
  });
});

describe('arch-review offer accept/decline', () => {
  it('accepts natural-language run requests', () => {
    expect(isArchReviewAccept('run the architecture reviewer specialist')).toBe(true);
    expect(isArchReviewAccept('yes')).toBe(true);
    expect(isArchReviewAccept('go ahead')).toBe(true);
    expect(isArchReviewAccept('run it')).toBe(true);
  });

  it('accepts the run button label and declines the inline button label', () => {
    expect(isArchReviewAccept(RUN_ARCH_REVIEW_LABEL)).toBe(true);
    expect(isArchReviewDecline(ANSWER_INLINE_LABEL)).toBe(true);
  });

  it('declines inline / negative replies', () => {
    expect(isArchReviewDecline('no, just answer inline')).toBe(true);
    expect(isArchReviewDecline('nah')).toBe(true);
    expect(isArchReviewAccept('no, just answer inline')).toBe(false);
  });

  it('treats unrelated replies as neither', () => {
    expect(isArchReviewAccept('what is the capital of France?')).toBe(false);
    expect(isArchReviewDecline('what is the capital of France?')).toBe(false);
  });
});

describe('isRepoReviewRequest', () => {
  it('fires for whole-repo review prompts', () => {
    expect(isRepoReviewRequest('review the design and architecture of this project')).toBe(true);
    expect(isRepoReviewRequest('Review this codebase')).toBe(true);
    expect(isRepoReviewRequest('audit the whole codebase')).toBe(true);
    expect(isRepoReviewRequest('evaluate the overall architecture')).toBe(true);
    expect(isRepoReviewRequest('assess the structure of the repo')).toBe(true);
  });

  it('does not fire when a specific file or symbol is named', () => {
    expect(isRepoReviewRequest('review src/agent/loop.ts')).toBe(false);
    expect(isRepoReviewRequest('review this function')).toBe(false);
    expect(isRepoReviewRequest('review the design of the auth class')).toBe(false);
  });

  it('does not fire without a whole-repo scope', () => {
    expect(isRepoReviewRequest('review how auth works')).toBe(false);
    expect(isRepoReviewRequest('what is the architecture?')).toBe(false);
  });

  it('does not fire on slash commands or empty input', () => {
    expect(isRepoReviewRequest('/review this repo')).toBe(false);
    expect(isRepoReviewRequest('')).toBe(false);
  });
});

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
