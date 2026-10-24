import { describe, it, expect } from 'vitest';
import { getToolDefinitionsForTier } from '../../src/agent/tools.js';
import { getConfig } from '../../src/config/settings.js';
import { sweToolCatalog, SWE_EXCLUDED_TOOLS } from './toolCatalog.js';

describe('sweToolCatalog', () => {
  const product = getToolDefinitionsForTier('full', undefined, getConfig());
  const swe = sweToolCatalog(product);

  it('offers no web search: a public upstream bug can be looked up, which is contamination', () => {
    expect(product.some((t) => t.name === 'web_search')).toBe(true); // the product offers it...
    expect(swe.some((t) => t.name === 'web_search')).toBe(false); // ...the benchmark must not
  });

  it('still removes run_tests', () => {
    expect(swe.some((t) => t.name === 'run_tests')).toBe(false);
  });

  // #318: django-13964 committed and then pushed to github.com/django/django.
  it('offers no git writes or GitHub writes, and keeps the read-only git tools', () => {
    for (const name of [
      'git_push',
      'git_pull',
      'git_stash',
      'git_commit',
      'git_branch',
      'reply_pr_comment',
      'submit_pr_review',
      'create_pr_review',
      'mark_pr_ready',
    ]) {
      expect(
        product.some((t) => t.name === name),
        `${name} in the product`,
      ).toBe(true);
      expect(
        swe.some((t) => t.name === name),
        `${name} in the SWE catalog`,
      ).toBe(false);
    }
    for (const name of ['git_status', 'git_diff', 'git_log']) {
      expect(
        swe.some((t) => t.name === name),
        `${name} kept`,
      ).toBe(true);
    }
  });

  it('removes only what it names, and says why for each', () => {
    expect(product.length - swe.length).toBe(
      [...SWE_EXCLUDED_TOOLS.keys()].filter((n) => product.some((t) => t.name === n)).length,
    );
    for (const reason of SWE_EXCLUDED_TOOLS.values()) expect(reason.length).toBeGreaterThan(40);
  });
});
