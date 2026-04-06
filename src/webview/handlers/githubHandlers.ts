import { window, Uri } from 'vscode';
import * as path from 'path';
import type { ChatState } from '../chatState.js';
import type { WebviewMessage } from '../chatWebview.js';
import { GitCLI } from '../../github/git.js';
import { GitHubAPI } from '../../github/api.js';
import { getGitHubToken } from '../../github/auth.js';

export async function handleGitHubCommand(state: ChatState, msg: WebviewMessage): Promise<void> {
  try {
    switch (msg.action) {
      case 'clone': {
        if (!msg.url) {
          state.postMessage({ command: 'error', content: 'Please provide a repository URL.' });
          return;
        }
        const targetUris = await window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Clone Here',
        });
        if (!targetUris || targetUris.length === 0) return;
        const repoName =
          msg.url
            .replace(/\.git$/, '')
            .split('/')
            .pop() || 'repo';
        const targetDir = path.join(targetUris[0].fsPath, repoName);
        state.postMessage({ command: 'githubResult', githubAction: 'clone', githubData: 'Cloning...' });
        const git = new GitCLI(targetUris[0].fsPath);
        const result = await git.clone(msg.url, targetDir);
        state.postMessage({ command: 'githubResult', githubAction: 'clone', githubData: result });
        const openChoice = await window.showInformationMessage(`Cloned ${repoName}. Open in VSCode?`, 'Open', 'Cancel');
        if (openChoice === 'Open') {
          const vsc = await import('vscode');
          await vsc.commands.executeCommand('vscode.openFolder', Uri.file(targetDir));
        }
        break;
      }
      case 'push': {
        const git = new GitCLI();
        const result = await git.push();
        state.postMessage({ command: 'githubResult', githubAction: 'push', githubData: result });
        break;
      }
      case 'pull': {
        const git = new GitCLI();
        const result = await git.pull();
        state.postMessage({ command: 'githubResult', githubAction: 'pull', githubData: result });
        break;
      }
      case 'log': {
        const git = new GitCLI();
        const commits = await git.log(msg.count || 10);
        state.postMessage({ command: 'githubResult', githubAction: 'log', githubData: commits });
        break;
      }
      case 'diff': {
        const git = new GitCLI();
        const diff = await git.diff(msg.ref1, msg.ref2);
        state.postMessage({ command: 'githubResult', githubAction: 'diff', githubData: diff });
        break;
      }
      case 'listPRs':
      case 'getPR':
      case 'createPR':
      case 'listIssues':
      case 'getIssue':
      case 'createIssue':
      case 'browse': {
        const token = await getGitHubToken();
        const api = new GitHubAPI(token);

        let owner: string;
        let repo: string;

        if (msg.repo) {
          const parsed = GitHubAPI.parseRepo(msg.repo);
          if (!parsed) {
            state.postMessage({ command: 'error', content: 'Invalid repo format. Use owner/repo or a GitHub URL.' });
            return;
          }
          ({ owner, repo } = parsed);
        } else {
          const git = new GitCLI();
          const remoteUrl = await git.getRemoteUrl();
          if (!remoteUrl) {
            state.postMessage({
              command: 'error',
              content: 'No GitHub remote found. Specify a repo like: /prs owner/repo',
            });
            return;
          }
          const parsed = GitHubAPI.parseRepo(remoteUrl);
          if (!parsed) {
            state.postMessage({ command: 'error', content: 'Could not parse remote URL as a GitHub repo.' });
            return;
          }
          ({ owner, repo } = parsed);
        }

        if (msg.action === 'listPRs') {
          const prs = await api.listPRs(owner, repo);
          state.postMessage({ command: 'githubResult', githubAction: 'listPRs', githubData: prs });
        } else if (msg.action === 'getPR') {
          const pr = await api.getPR(owner, repo, msg.number!);
          state.postMessage({ command: 'githubResult', githubAction: 'getPR', githubData: pr });
        } else if (msg.action === 'createPR') {
          if (!msg.title || !msg.head || !msg.base) {
            state.postMessage({ command: 'error', content: 'Usage: /create pr "title" base-branch head-branch' });
            return;
          }
          const pr = await api.createPR(owner, repo, msg.title, msg.head, msg.base, msg.body);
          state.postMessage({ command: 'githubResult', githubAction: 'createPR', githubData: pr });
        } else if (msg.action === 'listIssues') {
          const issues = await api.listIssues(owner, repo);
          state.postMessage({ command: 'githubResult', githubAction: 'listIssues', githubData: issues });
        } else if (msg.action === 'getIssue') {
          const issue = await api.getIssue(owner, repo, msg.number!);
          state.postMessage({ command: 'githubResult', githubAction: 'getIssue', githubData: issue });
        } else if (msg.action === 'createIssue') {
          if (!msg.title) {
            state.postMessage({ command: 'error', content: 'Usage: /create issue "title" ["body"]' });
            return;
          }
          const issue = await api.createIssue(owner, repo, msg.title, msg.body);
          state.postMessage({ command: 'githubResult', githubAction: 'createIssue', githubData: issue });
        } else if (msg.action === 'browse') {
          const files = await api.listRepoContents(owner, repo, msg.ghPath);
          state.postMessage({ command: 'githubResult', githubAction: 'browse', githubData: files });
        }
        break;
      }
    }
  } catch (err) {
    state.postMessage({
      command: 'error',
      content: `GitHub error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
