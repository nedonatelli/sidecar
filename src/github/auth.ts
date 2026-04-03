import { authentication } from 'vscode';

export async function getGitHubToken(): Promise<string> {
  const session = await authentication.getSession('github', ['repo'], { createIfNone: true });
  if (!session) {
    throw new Error('GitHub sign-in is required. Please try again.');
  }
  return session.accessToken;
}
