import { GitHubAPI } from './api.js';
import { getGitHubToken } from './auth.js';

/**
 * The GitHubAPI a command should use: the injected one (tests), or a new one
 * built from the user's GitHub token.
 *
 * A declined or failed sign-in is reported through `showError` and returned as
 * `{ errorMessage }` instead of thrown, so the command ends with its own error
 * outcome rather than a raw exception (#227, from #118). Commands used to write
 * `deps.api ?? new GitHubAPI(await getGitHubToken())`, which threw past every
 * handler below it.
 */
export async function githubApiForCommand(
  injected: GitHubAPI | undefined,
  showError: (message: string) => void,
): Promise<{ api: GitHubAPI } | { errorMessage: string }> {
  if (injected) return { api: injected };
  try {
    return { api: new GitHubAPI(await getGitHubToken()) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showError(`GitHub authentication failed: ${message}`);
    return { errorMessage: message };
  }
}
