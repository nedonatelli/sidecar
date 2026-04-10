import { authentication } from 'vscode';

/**
 * Get a GitHub access token via VS Code's built-in GitHub authentication.
 * Requests `repo` scope because SideCar creates PRs, issues, and releases
 * which requires full repo access for private repositories.
 * Falls back gracefully: tries existing session first, only prompts if needed.
 */
export async function getGitHubToken(): Promise<string> {
  // Try to reuse an existing session without prompting
  let session = await authentication.getSession('github', ['repo'], { createIfNone: false });
  if (session) return session.accessToken;

  // No existing session — prompt the user
  session = await authentication.getSession('github', ['repo'], { createIfNone: true });
  if (!session) {
    throw new Error('GitHub sign-in is required. Please try again.');
  }
  return session.accessToken;
}
