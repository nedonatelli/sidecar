// SideCar webview — GitHub card rendering.
// Extracted from chat.js as a first step toward splitting the monolith.
// Loaded via its own <script> tag; attaches to window.SideCar.githubCards
// so chat.js can call renderGitHubResult from its postMessage handler.

(function () {
  const ns = (window.SideCar = window.SideCar || {});

  function ghDiv(className, text) {
    const el = document.createElement('div');
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function ghStatePill(text, stateClass) {
    const span = document.createElement('span');
    span.className = 'gh-state' + (stateClass ? ' ' + stateClass : '');
    span.textContent = text;
    return span;
  }
  function ghLink(vscode, url, label) {
    const link = document.createElement('span');
    link.className = 'gh-link';
    link.textContent = label !== undefined ? label : url;
    link.addEventListener('click', () => {
      vscode.postMessage({ command: 'openExternal', url });
    });
    return link;
  }
  function ghCardTitle(text, pill) {
    const title = ghDiv('gh-card-title', text);
    if (pill) {
      title.appendChild(document.createTextNode(' '));
      title.appendChild(pill);
    }
    return title;
  }
  function ghAuthorMeta(author, createdAt) {
    return ghDiv('gh-meta', 'by ' + author + ' - ' + new Date(createdAt).toLocaleDateString());
  }
  function ghPrefix(action) {
    return action === 'listPRs' || action === 'getPR' || action === 'createPR' ? 'PR' : 'Issue';
  }

  /**
   * Render the assistant-side card for a GitHub-related action result.
   * Returns the container div ready to append into the message list.
   *
   * @param {object} deps - shared helpers from chat.js
   * @param {object} deps.vscode - the webview API handle (postMessage)
   * @param {function} deps.renderContent - markdown renderer for `diff` output
   * @param {boolean} deps.currentModelSupportsTools
   * @param {string} action - GitHubAction value
   * @param {unknown} data - action-specific payload
   */
  function renderGitHubResult(deps, action, data) {
    const { vscode, renderContent, currentModelSupportsTools } = deps;
    const container = ghDiv('message assistant gh-result');

    if (action === 'listPRs' || action === 'listIssues') {
      const items = data;
      if (!items || items.length === 0) {
        container.textContent = action === 'listPRs' ? 'No pull requests found.' : 'No issues found.';
        return container;
      }
      const prefix = ghPrefix(action);
      for (const item of items) {
        const card = ghDiv('gh-card');
        card.appendChild(
          ghCardTitle(prefix + ' #' + item.number + ': ' + item.title, ghStatePill(item.state, item.state)),
        );
        card.appendChild(ghAuthorMeta(item.author, item.createdAt));
        card.appendChild(ghLink(vscode, item.url));
        container.appendChild(card);
      }
      return container;
    }

    if (action === 'getPR' || action === 'getIssue') {
      const item = data;
      const prefix = ghPrefix(action);
      const card = ghDiv('gh-card');
      card.appendChild(
        ghCardTitle(prefix + ' #' + item.number + ': ' + item.title, ghStatePill(item.state, item.state)),
      );
      card.appendChild(ghAuthorMeta(item.author, item.createdAt));

      if (item.body) {
        card.appendChild(ghDiv('gh-body', item.body.slice(0, 500) + (item.body.length > 500 ? '...' : '')));
      }
      if (action === 'getPR' && item.head && item.base) {
        card.appendChild(ghDiv('gh-meta', item.head + ' \u2192 ' + item.base));
      }
      if (item.labels && item.labels.length > 0) {
        card.appendChild(ghDiv('gh-meta', 'Labels: ' + item.labels.join(', ')));
      }
      card.appendChild(ghLink(vscode, item.url));
      container.appendChild(card);
      return container;
    }

    if (action === 'createPR' || action === 'createIssue') {
      const item = data;
      const prefix = ghPrefix(action);
      container.textContent = prefix + ' #' + item.number + ' created: ' + item.title;
      container.appendChild(ghLink(vscode, item.url, ' ' + item.url));
      return container;
    }

    if (action === 'log') {
      const commits = data;
      if (!commits || commits.length === 0) {
        container.textContent = 'No commits found.';
        return container;
      }
      for (const c of commits) {
        const row = document.createElement('div');
        row.className = 'gh-commit';
        const hash = document.createElement('span');
        hash.className = 'gh-commit-hash';
        hash.textContent = c.hash;
        const msg = document.createTextNode('  ' + c.message + '  ');
        const meta = document.createElement('span');
        meta.className = 'gh-meta-inline';
        meta.textContent = '(' + c.author + ', ' + c.date + ')';
        row.appendChild(hash);
        row.appendChild(msg);
        row.appendChild(meta);
        container.appendChild(row);
      }
      return container;
    }

    if (action === 'diff') {
      const result = data;
      const summary = document.createElement('div');
      summary.className = 'gh-meta';
      summary.textContent = result.summary;
      container.appendChild(summary);
      if (result.diff && result.diff !== 'No diff output.') {
        container.appendChild(renderContent('```diff\n' + result.diff + '\n```', currentModelSupportsTools));
      }
      return container;
    }

    if (action === 'browse') {
      const files = data;
      if (!files || files.length === 0) {
        container.textContent = 'No files found.';
        return container;
      }
      for (const f of files) {
        const row = document.createElement('div');
        row.className = 'gh-file-item';
        const icon = f.type === 'dir' ? '\uD83D\uDCC1 ' : '\uD83D\uDCC4 ';
        const link = document.createElement('span');
        link.className = 'gh-link';
        link.textContent = icon + f.name;
        link.addEventListener('click', () => {
          vscode.postMessage({ command: 'openExternal', url: f.url });
        });
        row.appendChild(link);
        container.appendChild(row);
      }
      return container;
    }

    if (action === 'listReleases') {
      const releases = data;
      if (!releases || releases.length === 0) {
        container.textContent = 'No releases found.';
        return container;
      }
      for (const r of releases) {
        const card = ghDiv('gh-card');
        const title = ghCardTitle(r.name || r.tagName, ghStatePill(r.tagName, 'open'));
        if (r.draft) {
          title.appendChild(document.createTextNode(' '));
          title.appendChild(ghStatePill('draft', 'closed'));
        }
        if (r.prerelease) {
          title.appendChild(document.createTextNode(' '));
          title.appendChild(ghStatePill('pre-release'));
        }
        card.appendChild(title);

        let metaText = r.publishedAt ? new Date(r.publishedAt).toLocaleDateString() : 'unpublished';
        if (r.assets && r.assets.length > 0) {
          metaText += ' \u2022 ' + r.assets.length + ' asset' + (r.assets.length === 1 ? '' : 's');
        }
        card.appendChild(ghDiv('gh-meta', metaText));
        card.appendChild(ghLink(vscode, r.url));
        container.appendChild(card);
      }
      return container;
    }

    if (action === 'getRelease') {
      const r = data;
      const card = ghDiv('gh-card');
      card.appendChild(ghCardTitle((r.name || r.tagName) + ' (' + r.tagName + ')'));
      card.appendChild(
        ghDiv('gh-meta', r.publishedAt ? 'Published ' + new Date(r.publishedAt).toLocaleDateString() : 'Draft'),
      );

      if (r.body) {
        card.appendChild(ghDiv('gh-body', r.body.slice(0, 800) + (r.body.length > 800 ? '...' : '')));
      }

      if (r.assets && r.assets.length > 0) {
        const assetsText =
          'Assets: ' +
          r.assets
            .map(function (a) {
              const mb = (a.size / (1024 * 1024)).toFixed(1);
              return a.name + ' (' + mb + ' MB, ' + a.downloadCount + ' downloads)';
            })
            .join(', ');
        card.appendChild(ghDiv('gh-meta', assetsText));
      }

      card.appendChild(ghLink(vscode, r.url));
      container.appendChild(card);
      return container;
    }

    if (action === 'createRelease') {
      const r = data;
      container.textContent = 'Release created: ' + (r.name || r.tagName);
      container.appendChild(ghLink(vscode, r.url, ' ' + r.url));
      return container;
    }

    if (action === 'deleteRelease') {
      container.textContent = typeof data === 'string' ? data : 'Release deleted.';
      return container;
    }

    // Fallback: plain text
    container.textContent = typeof data === 'string' ? data : JSON.stringify(data);
    return container;
  }

  ns.githubCards = { renderGitHubResult };
})();
