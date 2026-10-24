import type { ToolDefinition } from '../../src/ollama/types.js';

/**
 * Tools the SWE harness removes from the agent's catalog, with why. Removed,
 * not discouraged: negative instructions do not hold at a 27K-token context
 * (the prompt said "NOT run_tests" and the model used it on the first task).
 * A tool that is not offered also cannot run -- the loop's catalog gate.
 */
export const SWE_EXCLUDED_TOOLS: ReadonlyMap<string, string> = new Map([
  [
    'run_tests',
    'Its runner auto-detection picked npm in repos that also ship a package.json: on django it ran ' +
      '`pretest > eslint ...` -- linting JavaScript, not running Python tests -- and reported ok.',
  ],
  [
    'web_search',
    'Contamination. Every task is a fixed, public upstream bug, so a search can find the fix itself: ' +
      '6 runs in the last two matrices searched, e.g. "sphinx autodoc annotation only member superclass ' +
      'undocumented fix". The benchmark measures solving from the repository, not finding the answer online.',
  ],
  // Git writes and remotes (#318). The patch is the working tree against the
  // task's base commit; none of these help it, and some act on the real
  // upstream. On 2026-10-21 django-13964 committed and then pushed to the
  // clone's remote, github.com/django/django (denied only for lack of
  // permission); nemotron-3-super runs spent turns on git_commit too.
  [
    'git_push',
    "An outward network write to the task repository's real upstream (django-13964 pushed to github.com/django/django).",
  ],
  ['git_pull', "A network fetch from the real upstream that can move the checkout off the task's base commit."],
  [
    'git_stash',
    "Moves the agent's changes out of the working tree, which is what the patch is captured from: a stash loses the patch.",
  ],
  ['git_commit', 'Scores nothing (the patch is the working tree against base_commit) and costs turns.'],
  ['git_branch', "Switching or creating branches can move the working tree off the task's base commit."],
  // GitHub writes: outward actions on real pull requests, never part of a task.
  ['reply_pr_comment', 'Posts a comment to a real pull request on GitHub, an outward action no task needs.'],
  ['submit_pr_review', 'Submits a review to a real pull request on GitHub, an outward action no task needs.'],
  ['create_pr_review', 'Creates a review on a real pull request on GitHub, an outward action no task needs.'],
  ['mark_pr_ready', "Changes a real pull request's state on GitHub, an outward action no task needs."],
]);

/** The SWE agent's tool catalog: the product's, minus SWE_EXCLUDED_TOOLS. */
export function sweToolCatalog(defs: ToolDefinition[]): ToolDefinition[] {
  return defs.filter((t) => !SWE_EXCLUDED_TOOLS.has(t.name));
}
