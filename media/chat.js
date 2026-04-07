// @ts-nocheck
/* eslint-disable */
// SideCar chat webview script — extracted from chatWebview.ts

(function () {
  const vscode = acquireVsCodeApi();
  const messagesContainer = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const attachBtn = document.getElementById('attach-btn');
  const modelBtn = document.getElementById('model-btn');
  const modelName = document.getElementById('model-name');
  const modelPanel = document.getElementById('model-panel');
  const modelList = document.getElementById('model-list');
  const closePanel = document.getElementById('close-panel');
  const installProgress = document.getElementById('install-progress');
  const installText = document.getElementById('install-text');
  const cancelInstall = document.getElementById('cancel-install');
  const fileAttachment = document.getElementById('file-attachment');
  const fileAttachmentName = document.getElementById('file-attachment-name');
  const removeAttachment = document.getElementById('remove-attachment');
  const customModelInput = document.getElementById('custom-model-input');
  const customModelUse = document.getElementById('custom-model-use');

  let isLoading = false;
  let currentAssistantDiv = null;
  let currentAssistantText = '';
  let installingModel = null;
  let pendingFile = null;
  let pendingImages = [];
  const imagePreview = document.getElementById('image-preview');
  let streamStartTime = 0;
  let streamCharCount = 0;
  const streamStats = document.getElementById('stream-stats');

  modelBtn.addEventListener('click', () => {
    modelPanel.classList.toggle('hidden');
  });

  closePanel.addEventListener('click', () => {
    modelPanel.classList.add('hidden');
  });

  cancelInstall.addEventListener('click', () => {
    vscode.postMessage({ command: 'cancelInstall' });
  });

  attachBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'attachFile' });
  });

  removeAttachment.addEventListener('click', () => {
    pendingFile = null;
    fileAttachment.classList.add('hidden');
  });

  customModelUse.addEventListener('click', () => {
    const name = customModelInput.value.trim();
    if (!name) return;
    vscode.postMessage({ command: 'changeModel', model: name });
    customModelInput.value = '';
    modelPanel.classList.add('hidden');
  });

  input.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          const [header, data] = dataUrl.split(',');
          const mediaType = header.match(/data:(.*?);/)[1];
          pendingImages.push({ mediaType, data });
          updateImagePreview();
        };
        reader.readAsDataURL(file);
      }
    }
  });

  function updateImagePreview() {
    if (pendingImages.length === 0) {
      imagePreview.classList.add('hidden');
      imagePreview.innerHTML = '';
      return;
    }
    imagePreview.classList.remove('hidden');
    imagePreview.innerHTML = '';
    for (let i = 0; i < pendingImages.length; i++) {
      const img = document.createElement('img');
      img.src = 'data:' + pendingImages[i].mediaType + ';base64,' + pendingImages[i].data;
      img.className = 'image-thumb';
      const removeBtn = document.createElement('button');
      removeBtn.textContent = '\u00d7';
      removeBtn.className = 'image-remove';
      removeBtn.addEventListener('click', () => {
        pendingImages.splice(i, 1);
        updateImagePreview();
      });
      const wrapper = document.createElement('span');
      wrapper.className = 'image-thumb-wrapper';
      wrapper.appendChild(img);
      wrapper.appendChild(removeBtn);
      imagePreview.appendChild(wrapper);
    }
  }

  const sessionsPanel = document.getElementById('sessions-panel');
  const sessionsList = document.getElementById('sessions-list');
  const sessionsEmpty = document.getElementById('sessions-empty');

  document.getElementById('history-btn').addEventListener('click', () => {
    const isOpen = !sessionsPanel.classList.contains('hidden');
    sessionsPanel.classList.toggle('hidden');
    if (!isOpen) {
      vscode.postMessage({ command: 'listSessions' });
    }
  });

  document.getElementById('close-sessions').addEventListener('click', () => {
    sessionsPanel.classList.add('hidden');
  });

  function renderSessionsList(sessions) {
    sessionsList.innerHTML = '';
    if (!sessions || sessions.length === 0) {
      sessionsEmpty.classList.remove('hidden');
      return;
    }
    sessionsEmpty.classList.add('hidden');
    // Sort newest first
    sessions.sort((a, b) => b.createdAt - a.createdAt);
    for (const s of sessions) {
      const item = document.createElement('div');
      item.className = 'session-item';

      const info = document.createElement('div');
      info.className = 'session-info';

      const name = document.createElement('div');
      name.className = 'session-name';
      name.textContent = s.name;

      const date = document.createElement('div');
      date.className = 'session-date';
      date.textContent = new Date(s.createdAt).toLocaleString();

      info.appendChild(name);
      info.appendChild(date);

      const actions = document.createElement('div');
      actions.className = 'session-actions';

      const loadBtn = document.createElement('button');
      loadBtn.className = 'session-load-btn';
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ command: 'loadSession', text: s.id });
        sessionsPanel.classList.add('hidden');
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'session-delete-btn';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ command: 'deleteSession', text: s.id });
      });

      actions.appendChild(loadBtn);
      actions.appendChild(deleteBtn);

      item.appendChild(info);
      item.appendChild(actions);

      // Clicking the row also loads
      item.addEventListener('click', () => {
        vscode.postMessage({ command: 'loadSession', text: s.id });
        sessionsPanel.classList.add('hidden');
      });

      sessionsList.appendChild(item);
    }
  }

  document.getElementById('new-chat-btn').addEventListener('click', () => {
    vscode.postMessage({ command: 'newChat' });
  });

  document.getElementById('undo-btn').addEventListener('click', () => {
    vscode.postMessage({ command: 'undoChanges' });
  });

  document.getElementById('export-btn').addEventListener('click', () => {
    vscode.postMessage({ command: 'exportChat' });
  });

  document.getElementById('scroll-to-bottom').addEventListener('click', () => {
    forceScrollToBottom();
  });

  document.getElementById('agent-mode-select').addEventListener('change', (e) => {
    const mode = e.target.value;
    vscode.postMessage({ command: 'changeAgentMode', agentMode: mode });
    e.target.className = 'agent-mode-select mode-' + mode;
  });

  customModelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      customModelUse.click();
    }
  });

  // Slash command definitions for autocomplete
  const slashCommands = [
    { cmd: '/help', desc: 'Show available commands' },
    { cmd: '/reset', desc: 'Clear chat' },
    { cmd: '/undo', desc: 'Rollback file changes' },
    { cmd: '/export', desc: 'Export chat as Markdown' },
    { cmd: '/model', desc: 'Switch model' },
    { cmd: '/batch', desc: 'Run multiple tasks' },
    { cmd: '/doc', desc: 'Generate documentation' },
    { cmd: '/spec', desc: 'Spec-driven development' },
    { cmd: '/insight', desc: 'Codebase insight report' },
    { cmd: '/commit', desc: 'Generate commit message & commit' },
    { cmd: '/save', desc: 'Save session' },
    { cmd: '/sessions', desc: 'Browse conversations' },
    { cmd: '/move', desc: 'Move/rename file' },
    { cmd: '/clone', desc: 'Clone repository' },
    { cmd: '/scan', desc: 'Scan staged files for secrets' },
    { cmd: '/usage', desc: 'Token usage & cost dashboard' },
    { cmd: '/context', desc: 'Show context window breakdown' },
    { cmd: '/test', desc: 'Generate tests for active file' },
    { cmd: '/lint', desc: 'Run linter and show results' },
    { cmd: '/deps', desc: 'Analyze project dependencies' },
    { cmd: '/scaffold', desc: 'Generate code from template' },
    { cmd: '/verbose', desc: 'Toggle verbose mode (show agent reasoning)' },
    { cmd: '/prompt', desc: 'Show the current system prompt' },
  ];
  const autocompleteEl = document.getElementById('slash-autocomplete');
  let acSelectedIndex = -1;

  function updateAutocomplete() {
    const text = input.value;
    // Only show when text starts with / and is a single line with no spaces yet (or just the command)
    const match = text.match(/^\/(\S*)$/);
    if (!match) {
      autocompleteEl.classList.add('hidden');
      acSelectedIndex = -1;
      return;
    }
    const query = match[1].toLowerCase();
    const filtered = slashCommands.filter((c) => c.cmd.slice(1).startsWith(query));
    if (filtered.length === 0) {
      autocompleteEl.classList.add('hidden');
      acSelectedIndex = -1;
      return;
    }
    acSelectedIndex = 0;
    autocompleteEl.innerHTML = '';
    filtered.forEach((c, i) => {
      const item = document.createElement('div');
      item.className = 'ac-item' + (i === 0 ? ' ac-selected' : '');
      item.innerHTML = `<span class="ac-cmd">${c.cmd}</span> <span class="ac-desc">${c.desc}</span>`;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectAutocomplete(c.cmd);
      });
      autocompleteEl.appendChild(item);
    });
    autocompleteEl.classList.remove('hidden');
  }

  function selectAutocomplete(cmd) {
    // For commands that take arguments, add a trailing space
    const needsArg = ['/model', '/batch', '/spec', '/save', '/move', '/clone', '/scaffold'].includes(cmd);
    input.value = needsArg ? cmd + ' ' : cmd;
    input.focus();
    autocompleteEl.classList.add('hidden');
    acSelectedIndex = -1;
  }

  // Auto-resize textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    updateAutocomplete();
  });

  // Enter to send, Shift+Enter for newline, arrow keys for autocomplete
  input.addEventListener('keydown', (e) => {
    if (!autocompleteEl.classList.contains('hidden')) {
      const items = autocompleteEl.querySelectorAll('.ac-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        acSelectedIndex = Math.min(acSelectedIndex + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('ac-selected', i === acSelectedIndex));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        acSelectedIndex = Math.max(acSelectedIndex - 1, 0);
        items.forEach((el, i) => el.classList.toggle('ac-selected', i === acSelectedIndex));
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && acSelectedIndex >= 0) {
        e.preventDefault();
        const selected = items[acSelectedIndex]?.querySelector('.ac-cmd')?.textContent;
        if (selected) selectAutocomplete(selected);
        return;
      }
      if (e.key === 'Escape') {
        autocompleteEl.classList.add('hidden');
        acSelectedIndex = -1;
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitMessage();
    }
  });

  sendBtn.addEventListener('click', () => {
    if (isLoading) {
      vscode.postMessage({ command: 'abort' });
      setLoading(false);
    } else {
      submitMessage();
    }
  });

  function tryParseMoveCommand(text) {
    // /move source dest
    const slashMatch = text.match(/^\/move\s+("([^"]+)"|([^\s]+))\s+("([^"]+)"|([^\s]+))\s*$/i);
    if (slashMatch) {
      return { source: slashMatch[2] || slashMatch[3], dest: slashMatch[5] || slashMatch[6] };
    }
    // move file "source" to "dest"  (quotes optional)
    const naturalMatch = text.match(/^move\s+file\s+("([^"]+)"|([^\s]+))\s+to\s+("([^"]+)"|([^\s]+))\s*$/i);
    if (naturalMatch) {
      return { source: naturalMatch[2] || naturalMatch[3], dest: naturalMatch[5] || naturalMatch[6] };
    }
    // rename file "source" to "dest"
    const renameMatch = text.match(/^rename\s+file\s+("([^"]+)"|([^\s]+))\s+to\s+("([^"]+)"|([^\s]+))\s*$/i);
    if (renameMatch) {
      return { source: renameMatch[2] || renameMatch[3], dest: renameMatch[5] || renameMatch[6] };
    }
    return null;
  }

  function tryParseGitHubCommand(text) {
    // /clone <url> or clone repo <url>
    let m = text.match(/^(?:\/clone|clone\s+repo)\s+(.+?)\s*$/i);
    if (m) return { action: 'clone', url: m[1] };

    // /push or push changes
    if (/^(?:\/push|push\s+changes?)\s*$/i.test(text)) return { action: 'push' };

    // /pull or pull changes
    if (/^(?:\/pull|pull\s+changes?)\s*$/i.test(text)) return { action: 'pull' };

    // /log [N] or show commits [N]
    m = text.match(/^(?:\/log|show\s+commits?)(?:\s+(\d+))?\s*$/i);
    if (m) return { action: 'log', count: m[1] ? parseInt(m[1]) : undefined };

    // /diff [ref1] [ref2] or show diff [ref1] [ref2]
    m = text.match(/^(?:\/diff|show\s+diff)(?:\s+(\S+))?(?:\s+(\S+))?\s*$/i);
    if (m) return { action: 'diff', ref1: m[1], ref2: m[2] };

    // /prs [repo] or show prs [repo] or list prs [repo]
    m = text.match(/^(?:\/prs|(?:show|list)\s+prs?)(?:\s+(.+?))?\s*$/i);
    if (m) return { action: 'listPRs', repo: m[1] };

    // /pr <number> or show pr #<number>
    m = text.match(/^(?:\/pr|show\s+pr)\s+#?(\d+)(?:\s+(.+?))?\s*$/i);
    if (m) return { action: 'getPR', number: parseInt(m[1]), repo: m[2] };

    // /create pr "title" base head [body] or create pr "title" base head
    m = text.match(/^(?:\/create\s+pr|create\s+pr)\s+"([^"]+)"\s+(\S+)\s+(\S+)(?:\s+"([^"]*)")?\s*$/i);
    if (m) return { action: 'createPR', title: m[1], base: m[2], head: m[3], body: m[4] };

    // /issues [repo] or show issues [repo] or list issues [repo]
    m = text.match(/^(?:\/issues|(?:show|list)\s+issues?)(?:\s+(.+?))?\s*$/i);
    if (m) return { action: 'listIssues', repo: m[1] };

    // /issue <number> or show issue #<number>
    m = text.match(/^(?:\/issue|show\s+issue)\s+#?(\d+)(?:\s+(.+?))?\s*$/i);
    if (m) return { action: 'getIssue', number: parseInt(m[1]), repo: m[2] };

    // /create issue "title" ["body"] or create issue "title" ["body"]
    m = text.match(/^(?:\/create\s+issue|create\s+issue)\s+"([^"]+)"(?:\s+"([^"]*)")?\s*$/i);
    if (m) return { action: 'createIssue', title: m[1], body: m[2] };

    // /browse [path] [repo] or browse repo [path]
    m = text.match(/^(?:\/browse|browse\s+repo(?:\s+files?)?)\s*(?:\s+(\S+))?\s*$/i);
    if (m) return { action: 'browse', ghPath: m[1] };

    return null;
  }

  function renderGitHubResult(action, data) {
    const container = document.createElement('div');
    container.className = 'message assistant gh-result';

    if (action === 'listPRs' || action === 'listIssues') {
      const items = data;
      if (!items || items.length === 0) {
        container.textContent = action === 'listPRs' ? 'No pull requests found.' : 'No issues found.';
        return container;
      }
      for (const item of items) {
        const card = document.createElement('div');
        card.className = 'gh-card';

        const title = document.createElement('div');
        title.className = 'gh-card-title';
        const prefix = action === 'listPRs' ? 'PR' : 'Issue';
        title.textContent = prefix + ' #' + item.number + ': ' + item.title;

        const state = document.createElement('span');
        state.className = 'gh-state ' + item.state;
        state.textContent = item.state;
        title.appendChild(document.createTextNode(' '));
        title.appendChild(state);

        const meta = document.createElement('div');
        meta.className = 'gh-meta';
        meta.textContent = 'by ' + item.author + ' - ' + new Date(item.createdAt).toLocaleDateString();

        const link = document.createElement('span');
        link.className = 'gh-link';
        link.textContent = item.url;
        link.addEventListener('click', () => {
          vscode.postMessage({ command: 'openExternal', url: item.url });
        });

        card.appendChild(title);
        card.appendChild(meta);
        card.appendChild(link);
        container.appendChild(card);
      }
      return container;
    }

    if (action === 'getPR' || action === 'getIssue') {
      const item = data;
      const prefix = action === 'getPR' ? 'PR' : 'Issue';
      const card = document.createElement('div');
      card.className = 'gh-card';

      const title = document.createElement('div');
      title.className = 'gh-card-title';
      title.textContent = prefix + ' #' + item.number + ': ' + item.title;

      const state = document.createElement('span');
      state.className = 'gh-state ' + item.state;
      state.textContent = item.state;
      title.appendChild(document.createTextNode(' '));
      title.appendChild(state);

      const meta = document.createElement('div');
      meta.className = 'gh-meta';
      meta.textContent = 'by ' + item.author + ' - ' + new Date(item.createdAt).toLocaleDateString();

      card.appendChild(title);
      card.appendChild(meta);

      if (item.body) {
        const body = document.createElement('div');
        body.className = 'gh-body';
        body.textContent = item.body.slice(0, 500) + (item.body.length > 500 ? '...' : '');
        card.appendChild(body);
      }

      if (action === 'getPR' && item.head && item.base) {
        const branches = document.createElement('div');
        branches.className = 'gh-meta';
        branches.textContent = item.head + ' \u2192 ' + item.base;
        card.appendChild(branches);
      }

      if (item.labels && item.labels.length > 0) {
        const labels = document.createElement('div');
        labels.className = 'gh-meta';
        labels.textContent = 'Labels: ' + item.labels.join(', ');
        card.appendChild(labels);
      }

      const link = document.createElement('span');
      link.className = 'gh-link';
      link.textContent = item.url;
      link.addEventListener('click', () => {
        vscode.postMessage({ command: 'openExternal', url: item.url });
      });
      card.appendChild(link);

      container.appendChild(card);
      return container;
    }

    if (action === 'createPR' || action === 'createIssue') {
      const item = data;
      const prefix = action === 'createPR' ? 'PR' : 'Issue';
      container.textContent = prefix + ' #' + item.number + ' created: ' + item.title;
      const link = document.createElement('span');
      link.className = 'gh-link';
      link.textContent = ' ' + item.url;
      link.addEventListener('click', () => {
        vscode.postMessage({ command: 'openExternal', url: item.url });
      });
      container.appendChild(link);
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
        container.appendChild(renderContent('```diff\n' + result.diff + '\n```', window.currentModelSupportsTools));
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

    // Fallback: plain text
    container.textContent = typeof data === 'string' ? data : JSON.stringify(data);
    return container;
  }

  function submitMessage() {
    const text = input.value.trim();
    if (!text || isLoading) return;

    // Check for slash commands
    if (text.startsWith('/batch ') || text.startsWith('/batch\n')) {
      appendMessage('user', text);
      vscode.postMessage({ command: 'batch', text: text.slice(7) });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/commit') {
      appendMessage('user', '/commit');
      vscode.postMessage({ command: 'generateCommit' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/doc') {
      appendMessage('user', text);
      vscode.postMessage({ command: 'generateDoc' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.startsWith('/spec ')) {
      appendMessage('user', text);
      vscode.postMessage({ command: 'spec', text: text.slice(6).trim() });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/insight') {
      appendMessage('user', text);
      vscode.postMessage({ command: 'insight' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.startsWith('/save ')) {
      vscode.postMessage({ command: 'saveSession', text: text.slice(6).trim() });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/sessions') {
      sessionsPanel.classList.remove('hidden');
      vscode.postMessage({ command: 'listSessions' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/test') {
      appendMessage('user', '/test');
      vscode.postMessage({ command: 'generateTests' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/lint' || text.startsWith('/lint ')) {
      appendMessage('user', text);
      vscode.postMessage({ command: 'lint', text: text.slice(5).trim() || undefined });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/deps') {
      appendMessage('user', '/deps');
      vscode.postMessage({ command: 'deps' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.startsWith('/scaffold')) {
      appendMessage('user', text);
      vscode.postMessage({ command: 'scaffold', text: text.slice(9).trim() });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/context') {
      appendMessage('user', '/context');
      vscode.postMessage({ command: 'context' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/usage') {
      appendMessage('user', '/usage');
      vscode.postMessage({ command: 'usage' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/scan') {
      appendMessage('user', '/scan');
      vscode.postMessage({ command: 'scanStaged' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/verbose') {
      vscode.postMessage({ command: 'toggleVerbose' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/prompt') {
      vscode.postMessage({ command: 'showSystemPrompt' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/reset') {
      vscode.postMessage({ command: 'newChat' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/undo') {
      vscode.postMessage({ command: 'undoChanges' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/export') {
      appendMessage('user', text);
      vscode.postMessage({ command: 'exportChat' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.match(/^\/model\s+(.+)$/i)) {
      const modelName = text.match(/^\/model\s+(.+)$/i)[1].trim();
      vscode.postMessage({ command: 'changeModel', model: modelName });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/help') {
      appendMessage('user', '/help');
      appendMessage(
        'assistant',
        '**Available commands:**\n' +
          '`/help` — Show this list\n' +
          '`/reset` — Clear chat\n' +
          '`/undo` — Rollback file changes\n' +
          '`/export` — Export chat as Markdown\n' +
          '`/model <name>` — Switch model\n' +
          '`/batch <tasks>` — Run multiple tasks\n' +
          '`/doc` — Generate documentation\n' +
          '`/spec <desc>` — Spec-driven development\n' +
          '`/insight` — Codebase insight report\n' +
          '`/commit` — Generate commit message & commit\n' +
          '`/save <name>` — Save session\n' +
          '`/sessions` — Browse conversations\n' +
          '`/move <src> <dest>` — Move/rename file\n' +
          '`/clone <url>` — Clone repository\n' +
          '`/scan` — Scan staged files for secrets\n' +
          '`/usage` — Token usage & cost dashboard\n' +
          '`/context` — Show context window breakdown\n' +
          '`/test` — Generate tests for active file\n' +
          '`/lint` — Run linter and show results\n' +
          '`/deps` — Analyze project dependencies\n' +
          '`/scaffold <type>` — Generate code from template\n' +
          '`/verbose` — Toggle verbose mode (show agent reasoning)\n' +
          '`/prompt` — Show the current system prompt',
      );
      input.value = '';
      input.style.height = 'auto';
      return;
    }

    // Check for move/rename commands
    const moveCmd = tryParseMoveCommand(text);
    if (moveCmd) {
      appendMessage('user', text);
      vscode.postMessage({ command: 'moveFile', sourcePath: moveCmd.source, destPath: moveCmd.dest });
      input.value = '';
      input.style.height = 'auto';
      return;
    }

    // Check for GitHub commands
    const ghCmd = tryParseGitHubCommand(text);
    if (ghCmd) {
      appendMessage('user', text);
      vscode.postMessage({ command: 'github', ...ghCmd });
      input.value = '';
      input.style.height = 'auto';
      return;
    }

    let messageText = text;
    let displayText = text;

    if (pendingFile) {
      messageText = '[File: ' + pendingFile.fileName + ']\n```\n' + pendingFile.fileContent + '\n```\n\n' + text;
      displayText = text;
      const div = appendMessage('user', displayText);
      const label = document.createElement('span');
      label.className = 'attachment-label';
      label.textContent = 'Attached: ' + pendingFile.fileName;
      div.appendChild(label);
      pendingFile = null;
      fileAttachment.classList.add('hidden');
    } else {
      appendMessage('user', displayText);
    }

    if (pendingImages.length > 0) {
      vscode.postMessage({ command: 'userMessage', text: messageText, images: pendingImages });
      pendingImages = [];
      updateImagePreview();
    } else {
      vscode.postMessage({ command: 'userMessage', text: messageText });
    }
    input.value = '';
    input.style.height = 'auto';
  }

  const createdFiles = new Set();

  // ---------------------------------------------------------------------------
  // Tool display helpers — clean names and icons like Claude Code / Copilot
  // ---------------------------------------------------------------------------
  const TOOL_DISPLAY_NAMES = {
    read_file: 'Read',
    write_file: 'Write',
    edit_file: 'Edit',
    search_files: 'Search',
    grep: 'Grep',
    run_command: 'Bash',
    list_directory: 'List',
    get_diagnostics: 'Diagnostics',
    run_tests: 'Test',
    git_diff: 'Git Diff',
    git_status: 'Git Status',
    git_stage: 'Git Stage',
    git_commit: 'Git Commit',
    git_log: 'Git Log',
    git_push: 'Git Push',
    git_pull: 'Git Pull',
    git_branch: 'Git Branch',
    git_stash: 'Git Stash',
    spawn_agent: 'Agent',
  };

  const TOOL_ICONS = {
    read_file: '\u{1F4D6}', // 📖
    write_file: '\u{270F}', // ✏
    edit_file: '\u{270F}', // ✏
    search_files: '\u{1F50D}', // 🔍
    grep: '\u{1F50E}', // 🔎
    run_command: '\u{1F4BB}', // 💻
    list_directory: '\u{1F4C2}', // 📂
    get_diagnostics: '\u{1FA7A}', // 🩺
    run_tests: '\u{1F9EA}', // 🧪
    spawn_agent: '\u{1F916}', // 🤖
  };

  function formatToolName(name) {
    return TOOL_DISPLAY_NAMES[name] || name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function getToolIcon(name) {
    // Git tools share one icon
    if (name.startsWith('git_')) return '\u{E0A0}'; // git branch symbol, fallback ↓
    return TOOL_ICONS[name] || '\u2699'; // ⚙
  }

  function formatToolDetail(name, fullContent) {
    // Extract the key argument to show as a concise detail
    const match = fullContent.match(/\(([^)]*)\)/);
    if (!match) return '';
    const args = match[1];

    // Show the most relevant argument for each tool type
    switch (name) {
      case 'read_file':
      case 'write_file':
      case 'edit_file':
      case 'list_directory':
      case 'get_diagnostics': {
        const pathMatch = args.match(/path:\s*([^,]+)/);
        return pathMatch ? pathMatch[1].trim() : '';
      }
      case 'grep':
      case 'search_files': {
        const patMatch = args.match(/pattern:\s*([^,]+)/);
        return patMatch ? patMatch[1].trim() : '';
      }
      case 'run_command': {
        const cmdMatch = args.match(/command:\s*(.+?)(?:,\s*timeout|$)/);
        return cmdMatch ? cmdMatch[1].trim() : '';
      }
      case 'run_tests': {
        const testMatch = args.match(/command:\s*([^,]+)/);
        return testMatch ? testMatch[1].trim() : 'auto-detect';
      }
      case 'spawn_agent': {
        const taskMatch = args.match(/task:\s*(.+)/);
        return taskMatch ? taskMatch[1].trim().slice(0, 50) : '';
      }
      default:
        return args.length > 60 ? args.slice(0, 57) + '...' : args;
    }
  }

  /**
   * Parse inline markdown into DOM nodes (no innerHTML, XSS-safe).
   * Supports: **bold**, *italic*, ~~strikethrough~~, `code`, [links](url), line breaks.
   */
  function appendInlineMarkdown(parent, text) {
    // Regex matches inline markdown tokens in priority order
    const inlineRegex =
      /(\*\*(.+?)\*\*)|(__(.+?)__)|(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)|(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)|(~~(.+?)~~)|(`([^`]+?)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
    let lastIdx = 0;
    let m;

    while ((m = inlineRegex.exec(text)) !== null) {
      // Append plain text before this match
      if (m.index > lastIdx) {
        appendPlainText(parent, text.slice(lastIdx, m.index));
      }

      if (m[2] != null) {
        // **bold**
        const el = document.createElement('strong');
        el.textContent = m[2];
        parent.appendChild(el);
      } else if (m[4] != null) {
        // __bold__
        const el = document.createElement('strong');
        el.textContent = m[4];
        parent.appendChild(el);
      } else if (m[5] != null) {
        // *italic*
        const el = document.createElement('em');
        el.textContent = m[5];
        parent.appendChild(el);
      } else if (m[6] != null) {
        // _italic_
        const el = document.createElement('em');
        el.textContent = m[6];
        parent.appendChild(el);
      } else if (m[8] != null) {
        // ~~strikethrough~~
        const el = document.createElement('del');
        el.textContent = m[8];
        parent.appendChild(el);
      } else if (m[10] != null) {
        // `inline code`
        const el = document.createElement('code');
        el.textContent = m[10];
        parent.appendChild(el);
      } else if (m[12] != null && m[13] != null) {
        // [text](url) — only allow http/https
        const url = m[13];
        if (/^https?:\/\//i.test(url)) {
          const el = document.createElement('a');
          el.href = url;
          el.textContent = m[12];
          el.target = '_blank';
          el.rel = 'noopener noreferrer';
          parent.appendChild(el);
        } else {
          // Not a safe URL, render as plain text
          appendPlainText(parent, m[0]);
        }
      }

      lastIdx = m.index + m[0].length;
    }

    // Append remaining plain text
    if (lastIdx < text.length) {
      appendPlainText(parent, text.slice(lastIdx));
    }
  }

  function appendPlainText(parent, text) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        parent.appendChild(document.createElement('br'));
      }
      if (lines[i]) {
        parent.appendChild(document.createTextNode(lines[i]));
      }
    }
  }

  /**
   * Parse block-level markdown into DOM nodes, then apply inline markdown
   * within each block. Supports: headings (#-####), bullet lists (- or *),
   * numbered lists (1.), blockquotes (>), and horizontal rules (---/***).
   */
  function appendBlockMarkdown(parent, text) {
    // Normalize \r\n → \n to prevent regex failures (JS . doesn't match \r)
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Skip empty lines
      if (line.trim() === '') {
        i++;
        continue;
      }

      // Horizontal rule: --- or *** or ___ (3+ chars, optional spaces)
      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
        parent.appendChild(document.createElement('hr'));
        i++;
        continue;
      }

      // Heading: # to ####
      const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const el = document.createElement('h' + (level + 1)); // h2-h5 (avoid h1 in chat)
        appendInlineMarkdown(el, headingMatch[2]);
        parent.appendChild(el);
        i++;
        continue;
      }

      // Blockquote: > text (collect consecutive > lines)
      if (/^\s*>\s?/.test(line)) {
        const bq = document.createElement('blockquote');
        const bqLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          bqLines.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        appendInlineMarkdown(bq, bqLines.join('\n'));
        parent.appendChild(bq);
        continue;
      }

      // Bullet list: - or * at start (collect consecutive list items)
      if (/^\s*[-*]\s+/.test(line)) {
        const ul = document.createElement('ul');
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          const li = document.createElement('li');
          appendInlineMarkdown(li, lines[i].replace(/^\s*[-*]\s+/, ''));
          ul.appendChild(li);
          i++;
        }
        parent.appendChild(ul);
        continue;
      }

      // Numbered list: 1. 2. etc (collect consecutive items)
      if (/^\s*\d+\.\s+/.test(line)) {
        const ol = document.createElement('ol');
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          const li = document.createElement('li');
          appendInlineMarkdown(li, lines[i].replace(/^\s*\d+\.\s+/, ''));
          ol.appendChild(li);
          i++;
        }
        parent.appendChild(ol);
        continue;
      }

      // Regular paragraph: collect consecutive non-special lines
      const paraLines = [];
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^#{1,4}\s+/.test(lines[i]) &&
        !/^\s*[-*]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i]) &&
        !/^\s*>\s?/.test(lines[i]) &&
        !/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(lines[i])
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      if (paraLines.length > 0) {
        const p = document.createElement('p');
        appendInlineMarkdown(p, paraLines.join('\n'));
        parent.appendChild(p);
      } else {
        // Safety: if no pattern matched and no paragraph lines collected,
        // treat as plain paragraph to prevent infinite loop
        const p = document.createElement('p');
        appendInlineMarkdown(p, line);
        parent.appendChild(p);
        i++;
      }
    }
  }

  function renderContent(text, supportsTools = true) {
    const fragment = document.createDocumentFragment();
    const codeBlockRegex = /```([\w.]*):?([^\n]*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        appendBlockMarkdown(fragment, text.slice(lastIndex, match.index));
      }

      const lang = match[1];
      const filePath = match[2] ? match[2].trim() : '';
      const code = match[3];
      const wrapper = document.createElement('div');
      wrapper.className = 'code-block';

      const header = document.createElement('div');
      header.className = 'code-block-header';
      header.appendChild(document.createTextNode(filePath || lang || 'code'));

      if (filePath && supportsTools) {
        // If tools supported and has file path, create file silently (don't show in webview)
        if (!createdFiles.has(filePath)) {
          createdFiles.add(filePath);
          vscode.postMessage({ command: 'createFile', code, filePath });
        }
        const notice = document.createElement('div');
        notice.className = 'file-created-notice';
        notice.textContent = '\u2713 Created ' + filePath;
        fragment.appendChild(notice);
        lastIndex = match.index + match[0].length;
        continue;
      }

      // For chat-only models or code blocks without file paths, always show the code block
      const isShell = ['sh', 'bash', 'shell', 'zsh'].includes(lang.toLowerCase());
      if (isShell) {
        const runBtn = document.createElement('button');
        runBtn.className = 'code-save-btn code-run-btn';
        runBtn.textContent = 'Run';
        runBtn.addEventListener('click', () => {
          vscode.postMessage({ command: 'runCommand', text: code.trim() });
          runBtn.textContent = 'Running...';
          runBtn.disabled = true;
        });
        header.appendChild(runBtn);
      }

      const saveBtn = document.createElement('button');
      saveBtn.className = 'code-save-btn';
      saveBtn.textContent = 'Save As...';
      saveBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'saveCodeBlock', code, language: lang });
      });
      header.appendChild(saveBtn);

      const pre = document.createElement('pre');
      const codeEl = document.createElement('code');
      codeEl.textContent = code;
      pre.appendChild(codeEl);

      wrapper.appendChild(header);
      wrapper.appendChild(pre);
      fragment.appendChild(wrapper);

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      const remaining = text.slice(lastIndex);
      // Render edit blocks in remaining text
      const editRegex = /<<<SEARCH:([^\n]+)\n([\s\S]*?)\n===\n([\s\S]*?)\n>>>REPLACE/g;
      let editLastIndex = 0;
      let editMatch;
      while ((editMatch = editRegex.exec(remaining)) !== null) {
        if (editMatch.index > editLastIndex) {
          appendBlockMarkdown(fragment, remaining.slice(editLastIndex, editMatch.index));
        }
        const editFilePath = editMatch[1].trim();
        const searchText = editMatch[2];
        const replaceText = editMatch[3];

        const editBlock = document.createElement('div');
        editBlock.className = 'edit-block';

        const editHeader = document.createElement('div');
        editHeader.className = 'edit-header';
        editHeader.textContent = '\u270E Edit: ' + editFilePath;
        editBlock.appendChild(editHeader);

        const searchDiv = document.createElement('div');
        searchDiv.className = 'edit-search';
        const searchPre = document.createElement('pre');
        searchPre.textContent = searchText;
        searchDiv.appendChild(searchPre);
        editBlock.appendChild(searchDiv);

        const replaceDiv = document.createElement('div');
        replaceDiv.className = 'edit-replace';
        const replacePre = document.createElement('pre');
        replacePre.textContent = replaceText;
        replaceDiv.appendChild(replacePre);
        editBlock.appendChild(replaceDiv);

        fragment.appendChild(editBlock);
        editLastIndex = editMatch.index + editMatch[0].length;
      }
      if (editLastIndex < remaining.length) {
        appendBlockMarkdown(fragment, remaining.slice(editLastIndex));
      }
    }

    return fragment;
  }

  function appendMessage(role, content, isError = false) {
    const div = document.createElement('div');
    div.className = 'message ' + role + (isError ? ' error' : '');
    if (role === 'assistant' && !isError) {
      div.appendChild(renderContent(content, window.currentModelSupportsTools));
    } else {
      div.textContent = content;
    }

    // Add delete button to each message
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'message-delete-btn';
    deleteBtn.textContent = '\u00d7';
    deleteBtn.title = 'Delete message';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const allMessages = messagesContainer.querySelectorAll('.message');
      const index = Array.from(allMessages).indexOf(div);
      if (index !== -1) {
        vscode.postMessage({ command: 'deleteMessage', index });
        div.remove();
      }
    });
    div.appendChild(deleteBtn);

    messagesContainer.appendChild(div);
    scrollToBottom();
    return div;
  }

  function startAssistantMessage() {
    currentAssistantText = '';
    currentAssistantDiv = document.createElement('div');
    currentAssistantDiv.className = 'message assistant';
    messagesContainer.appendChild(currentAssistantDiv);
    scrollToBottom();
    return currentAssistantDiv;
  }

  // ---------------------------------------------------------------------------
  // Streaming renderer: buffer incoming tokens, render completed markdown
  // blocks incrementally, and show in-progress text with a cursor.
  // ---------------------------------------------------------------------------
  let lastRenderedLen = 0; // how much of currentAssistantText has been fully rendered
  let renderTimer = null; // debounce timer for re-renders
  let streamingSpan = null; // the <span> used for in-progress (unfinished) text

  /** Find the end position of all "safe" (fully closed) content in the text.
   *  Anything after this position may be a partial code block, partial bold, etc. */
  function findSafeRenderBoundary(text) {
    // Find last completed code block or edit block
    let safeEnd = 0;

    // Track code block regions
    const codeBlockRegex = /```[\w.]*:?[^\n]*\n[\s\S]*?```/g;
    let m;
    while ((m = codeBlockRegex.exec(text)) !== null) {
      safeEnd = m.index + m[0].length;
    }

    // Track edit block regions
    const editRegex = /<<<SEARCH:[^\n]+\n[\s\S]*?\n===\n[\s\S]*?\n>>>REPLACE/g;
    while ((m = editRegex.exec(text)) !== null) {
      if (m.index + m[0].length > safeEnd) {
        safeEnd = m.index + m[0].length;
      }
    }

    // For text after the last structural block, find the last complete paragraph.
    // A paragraph is "complete" if followed by a blank line or another block marker.
    const trailing = text.slice(safeEnd);

    // Check if we're inside an unclosed code fence
    const backtickCount = (trailing.match(/```/g) || []).length;
    if (backtickCount % 2 !== 0) {
      // Inside an unclosed code block — don't render the trailing part
      return safeEnd;
    }

    // Check if we're inside an unclosed edit block
    const searchCount = (trailing.match(/<<<SEARCH:/g) || []).length;
    const replaceCount = (trailing.match(/>>>REPLACE/g) || []).length;
    if (searchCount > replaceCount) {
      return safeEnd;
    }

    // Find the last double-newline boundary in trailing text.
    // Content before it is "complete paragraphs" safe to render.
    const lastBlankLine = trailing.lastIndexOf('\n\n');
    if (lastBlankLine !== -1) {
      return safeEnd + lastBlankLine + 2;
    }

    // If there's a single complete line (ends with \n), render up to
    // the last newline so we don't render a half-typed line.
    const lastNewline = trailing.lastIndexOf('\n');
    if (lastNewline !== -1) {
      return safeEnd + lastNewline + 1;
    }

    // No safe boundary in trailing text — only render up to the structural blocks
    return safeEnd;
  }

  function renderStreamingChunk() {
    renderTimer = null;
    if (!currentAssistantDiv) return;

    const text = currentAssistantText;
    const boundary = findSafeRenderBoundary(text);
    const safeText = text.slice(0, boundary);
    const pendingText = text.slice(boundary);

    // Only re-render if the safe portion has grown
    if (boundary > lastRenderedLen) {
      // Remove the streaming span before re-render
      if (streamingSpan && streamingSpan.parentNode) {
        streamingSpan.remove();
      }
      // Full render of all safe content
      currentAssistantDiv.innerHTML = '';
      if (safeText) {
        currentAssistantDiv.appendChild(renderContent(safeText, window.currentModelSupportsTools));
      }
      lastRenderedLen = boundary;
    }

    // Update or create the streaming span for pending (in-progress) text
    if (pendingText) {
      if (!streamingSpan || !streamingSpan.parentNode) {
        streamingSpan = document.createElement('span');
        streamingSpan.className = 'streaming-text';
      }
      streamingSpan.textContent = pendingText;
      if (!streamingSpan.parentNode) {
        currentAssistantDiv.appendChild(streamingSpan);
      }
    } else if (streamingSpan && streamingSpan.parentNode) {
      streamingSpan.remove();
    }

    scrollToBottom();
  }

  function appendToAssistantMessage(content) {
    if (!currentAssistantDiv) return;
    currentAssistantText += content;

    // Debounce renders to avoid DOM thrashing on fast token streams.
    // Render immediately on the first chunk and on structural boundaries;
    // otherwise batch updates every 80ms.
    const hasStructural = content.includes('```') || content.includes('>>>REPLACE');
    if (lastRenderedLen === 0 || hasStructural) {
      if (renderTimer) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      renderStreamingChunk();
    } else if (!renderTimer) {
      renderTimer = setTimeout(renderStreamingChunk, 80);
    }
  }

  function finishAssistantMessage() {
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    if (streamingSpan && streamingSpan.parentNode) {
      streamingSpan.remove();
    }
    streamingSpan = null;

    if (currentAssistantDiv && currentAssistantText) {
      // Final full render to ensure complete content with all buttons
      currentAssistantDiv.innerHTML = '';
      currentAssistantDiv.appendChild(renderContent(currentAssistantText, window.currentModelSupportsTools));
    }
    currentAssistantDiv = null;
    currentAssistantText = '';
    lastRenderedLen = 0;
  }

  function showTypingIndicator() {
    const div = document.createElement('div');
    div.className = 'message assistant typing-indicator';
    div.id = 'typing';
    div.innerHTML = '<span></span><span></span><span></span>';
    messagesContainer.appendChild(div);
    scrollToBottom();
  }

  function removeTypingIndicator() {
    const typing = document.getElementById('typing');
    if (typing) typing.remove();
  }

  function setLoading(loading) {
    isLoading = loading;
    sendBtn.disabled = false;
    sendBtn.textContent = loading ? 'Stop' : 'Send';
    sendBtn.classList.toggle('loading', loading);
    input.disabled = loading;
    const activityBar = document.getElementById('activity-bar');
    if (activityBar) activityBar.classList.toggle('hidden', !loading);
  }

  let userScrolledUp = false;

  messagesContainer.addEventListener('scroll', () => {
    const gap = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
    userScrolledUp = gap > 40;
    const scrollBtn = document.getElementById('scroll-to-bottom');
    if (scrollBtn) scrollBtn.classList.toggle('hidden', !userScrolledUp);
  });

  function scrollToBottom() {
    if (!userScrolledUp) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  function forceScrollToBottom() {
    userScrolledUp = false;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    const scrollBtn = document.getElementById('scroll-to-bottom');
    if (scrollBtn) scrollBtn.classList.add('hidden');
  }

  function renderModelList(models) {
    modelList.innerHTML = '';

    // Organize models by tool support
    const toolModels = models.filter((m) => m.supportsTools !== false);
    const chatOnlyModels = models.filter((m) => m.supportsTools === false);

    // Render tool-supporting models section
    if (toolModels.length > 0) {
      const section = document.createElement('div');
      section.className = 'model-section';
      const header = document.createElement('div');
      header.className = 'model-section-header';
      header.textContent = 'Full Features (Tools)';
      section.appendChild(header);
      modelList.appendChild(section);

      for (const model of toolModels) {
        const item = document.createElement('div');
        item.className = 'model-item';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'model-item-name';
        nameSpan.textContent = model.name;

        if (model.installed) {
          nameSpan.classList.add('installed');
          const checkmark = document.createElement('span');
          checkmark.className = 'model-check';
          checkmark.textContent = '\u2713';
          nameSpan.appendChild(checkmark);
        } else {
          const badge = document.createElement('span');
          badge.className = 'model-badge';
          badge.textContent = 'not installed';
          nameSpan.appendChild(badge);
        }

        const actionBtn = document.createElement('button');
        if (model.installed) {
          actionBtn.textContent = 'Use';
          actionBtn.className = 'model-action use';
        } else if (installingModel === model.name) {
          actionBtn.textContent = 'Installing...';
          actionBtn.className = 'model-action installing';
          actionBtn.disabled = true;
        } else {
          actionBtn.textContent = 'Install';
          actionBtn.className = 'model-action install';
        }
        actionBtn.dataset.model = model.name;

        actionBtn.addEventListener('click', () => {
          if (model.installed) {
            vscode.postMessage({ command: 'changeModel', model: model.name });
            modelPanel.classList.add('hidden');
          } else if (installingModel !== model.name) {
            vscode.postMessage({ command: 'installModel', model: model.name });
          }
        });

        item.appendChild(nameSpan);
        item.appendChild(actionBtn);
        modelList.appendChild(item);
      }
    }

    // Render chat-only models section
    if (chatOnlyModels.length > 0) {
      const section = document.createElement('div');
      section.className = 'model-section';
      const header = document.createElement('div');
      header.className = 'model-section-header';
      header.innerHTML = 'Chat-Only \u2139\ufe0f';
      header.title = 'These models support text chat only. Use Full Features models for autonomous tool calling.';
      section.appendChild(header);
      modelList.appendChild(section);

      for (const model of chatOnlyModels) {
        const item = document.createElement('div');
        item.className = 'model-item';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'model-item-name';
        nameSpan.textContent = model.name;

        if (model.installed) {
          nameSpan.classList.add('installed');
          const checkmark = document.createElement('span');
          checkmark.className = 'model-check';
          checkmark.textContent = '\u2713';
          nameSpan.appendChild(checkmark);
        } else {
          const badge = document.createElement('span');
          badge.className = 'model-badge';
          badge.textContent = 'not installed';
          nameSpan.appendChild(badge);
        }

        const actionBtn = document.createElement('button');
        if (model.installed) {
          actionBtn.textContent = 'Use';
          actionBtn.className = 'model-action use';
        } else if (installingModel === model.name) {
          actionBtn.textContent = 'Installing...';
          actionBtn.className = 'model-action installing';
          actionBtn.disabled = true;
        } else {
          actionBtn.textContent = 'Install';
          actionBtn.className = 'model-action install';
        }
        actionBtn.dataset.model = model.name;

        actionBtn.addEventListener('click', () => {
          if (model.installed) {
            vscode.postMessage({ command: 'changeModel', model: model.name });
            modelPanel.classList.add('hidden');
          } else if (installingModel !== model.name) {
            vscode.postMessage({ command: 'installModel', model: model.name });
          }
        });

        item.appendChild(nameSpan);
        item.appendChild(actionBtn);
        modelList.appendChild(item);
      }
    }
  }

  function updateChatOnlyBadge() {
    const badge = document.getElementById('chat-only-badge');
    const supportsTools = window.currentModelSupportsTools !== false;
    if (supportsTools) {
      badge.classList.add('hidden');
    } else {
      badge.classList.remove('hidden');
    }
  }

  // Store current model's tool support status
  window.currentModelSupportsTools = true;

  // Handle chat-only badge hover
  const chatOnlyBadge = document.getElementById('chat-only-badge');
  if (chatOnlyBadge) {
    chatOnlyBadge.addEventListener('mouseenter', () => {
      const tooltipContent = `<strong>Available Tools:</strong><br/>
• Read files<br/>
• Edit files<br/>
• Search files<br/>
• Run commands<br/>
• Git operations<br/>
• Run tests<br/>
• Get diagnostics<br/>
• Access workspace`;

      // Reuse or create tooltip
      let tooltip = document.getElementById('chat-only-tooltip');
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'chat-only-tooltip';
        document.body.appendChild(tooltip);
      }
      tooltip.innerHTML = tooltipContent;
      tooltip.classList.add('visible');

      // Position tooltip
      const rect = chatOnlyBadge.getBoundingClientRect();
      tooltip.style.left = rect.left + rect.width / 2 - tooltip.offsetWidth / 2 + 'px';
      tooltip.style.top = rect.bottom + 8 + 'px';
    });

    chatOnlyBadge.addEventListener('mouseleave', () => {
      const tooltip = document.getElementById('chat-only-tooltip');
      if (tooltip) {
        tooltip.classList.remove('visible');
      }
    });
  }

  // Handle messages from extension
  window.addEventListener('message', (event) => {
    const msg = event.data;
    const { command, content } = msg;

    switch (command) {
      case 'init':
        if (event.data.messages) {
          for (const msg of event.data.messages) {
            const text =
              typeof msg.content === 'string'
                ? msg.content
                : msg.content
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text)
                    .join('\n');
            appendMessage(msg.role, text);
          }
        }
        break;

      case 'setLoading':
        setLoading(event.data.isLoading);
        // Feature 6: Store expandThinking preference
        if (event.data.expandThinking !== undefined) {
          window.expandThinking = event.data.expandThinking;
        }
        if (event.data.isLoading) {
          showTypingIndicator();
          streamStartTime = Date.now();
          streamCharCount = 0;
          streamStats.classList.remove('hidden');
          streamStats.textContent = '';
        } else {
          removeTypingIndicator();
        }
        break;

      case 'assistantMessage':
        if (!currentAssistantDiv) {
          removeTypingIndicator();
          startAssistantMessage();
        }
        appendToAssistantMessage(content || '');
        streamCharCount += (content || '').length;
        {
          const elapsed = (Date.now() - streamStartTime) / 1000;
          const tokens = Math.ceil(streamCharCount / 4);
          const tokPerSec = elapsed > 0 ? (tokens / elapsed).toFixed(1) : '0';
          streamStats.textContent = tokens + ' tokens \u00b7 ' + tokPerSec + ' tok/s';
        }
        break;

      case 'agentProgress': {
        const progressEl = document.getElementById('agent-progress');
        if (progressEl && msg.iteration != null) {
          const stepEl = document.getElementById('progress-step');
          const timeEl = document.getElementById('progress-time');
          const tokensEl = document.getElementById('progress-tokens');
          if (stepEl) stepEl.textContent = `Step ${msg.iteration}/${msg.maxIterations}`;
          if (timeEl) {
            const secs = Math.floor((msg.elapsedMs || 0) / 1000);
            const mins = Math.floor(secs / 60);
            const rem = secs % 60;
            timeEl.textContent = mins > 0 ? `${mins}m ${rem}s` : `${rem}s`;
          }
          if (tokensEl && msg.estimatedTokens != null) {
            const k =
              msg.estimatedTokens >= 1000 ? `${Math.round(msg.estimatedTokens / 1000)}K` : String(msg.estimatedTokens);
            tokensEl.textContent = `~${k} tokens`;
          }
          progressEl.classList.remove('hidden');
        }
        break;
      }

      case 'done': {
        finishAssistantMessage();
        setLoading(false);
        userScrolledUp = false;
        const scrollBtnDone = document.getElementById('scroll-to-bottom');
        if (scrollBtnDone) scrollBtnDone.classList.add('hidden');
        const progressDone = document.getElementById('agent-progress');
        if (progressDone) progressDone.classList.add('hidden');
        setTimeout(() => {
          streamStats.classList.add('hidden');
        }, 3000);
        const thinkingDone = document.getElementById('current-thinking');
        if (thinkingDone) {
          thinkingDone.removeAttribute('id');
          const summary = thinkingDone.querySelector('summary');
          if (summary) summary.textContent = 'Reasoning';
        }
        break;
      }

      case 'changeSummary': {
        // Remove any existing summary panel
        const existingSummary = document.getElementById('change-summary');
        if (existingSummary) existingSummary.remove();

        const items = msg.changeSummary || [];
        if (items.length === 0) break;

        const panel = document.createElement('div');
        panel.id = 'change-summary';
        panel.className = 'change-summary';

        const csHeader = document.createElement('div');
        csHeader.className = 'change-summary-header';
        const csTitle = document.createElement('span');
        csTitle.textContent = items.length + ' file(s) changed';
        csHeader.appendChild(csTitle);

        const acceptAllBtn = document.createElement('button');
        acceptAllBtn.className = 'confirm-btn confirm-primary';
        acceptAllBtn.textContent = 'Accept All';
        acceptAllBtn.addEventListener('click', () => {
          vscode.postMessage({ command: 'acceptAllChanges' });
          panel.remove();
        });
        csHeader.appendChild(acceptAllBtn);
        panel.appendChild(csHeader);

        for (const item of items) {
          const fileSection = document.createElement('details');
          fileSection.className = 'change-summary-file';

          const fileSummary = document.createElement('summary');
          const badge = item.isNew ? ' (new)' : item.isDeleted ? ' (deleted)' : '';
          const fileLabel = document.createTextNode(item.filePath + badge);
          fileSummary.appendChild(fileLabel);

          const revertBtn = document.createElement('button');
          revertBtn.className = 'confirm-btn';
          revertBtn.textContent = 'Revert';
          revertBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'revertFile', filePath: item.filePath });
            fileSection.remove();
            if (panel.querySelectorAll('.change-summary-file').length === 0) {
              panel.remove();
            }
          });
          fileSummary.appendChild(revertBtn);
          fileSection.appendChild(fileSummary);

          const diffPre = document.createElement('pre');
          diffPre.className = 'change-summary-diff';
          // Render diff lines with color classes
          const diffLines = item.diff.split('\n');
          for (const line of diffLines) {
            const span = document.createElement('span');
            span.textContent = line;
            if (line.startsWith('+')) {
              span.className = 'diff-add';
            } else if (line.startsWith('-')) {
              span.className = 'diff-del';
            } else if (line.startsWith('@@')) {
              span.className = 'diff-hunk';
            } else {
              span.className = 'diff-ctx';
            }
            diffPre.appendChild(span);
            diffPre.appendChild(document.createTextNode('\n'));
          }
          fileSection.appendChild(diffPre);
          panel.appendChild(fileSection);
        }

        messagesContainer.appendChild(panel);
        scrollToBottom();
        break;
      }

      case 'chatCleared':
        messagesContainer.innerHTML = '';
        currentAssistantDiv = null;
        currentAssistantText = '';
        break;

      case 'addUserMessage':
        appendMessage('user', content || '');
        break;

      case 'thinking': {
        let thinkingEl = document.getElementById('current-thinking');
        if (!thinkingEl) {
          const details = document.createElement('details');
          details.className = 'thinking-block';
          details.id = 'current-thinking';
          // Feature 6: Expand thinking by default if setting is enabled
          if (window.expandThinking) {
            details.open = true;
          }
          const summary = document.createElement('summary');
          summary.textContent = 'Reasoning...';
          details.appendChild(summary);
          const body = document.createElement('pre');
          body.className = 'thinking-body';
          body.textContent = '';
          details.appendChild(body);
          messagesContainer.appendChild(details);
        }
        thinkingEl = document.getElementById('current-thinking');
        if (thinkingEl) {
          const body = thinkingEl.querySelector('.thinking-body');
          if (body) body.textContent += content || '';
        }
        scrollToBottom();
        break;
      }

      case 'verboseLog': {
        const vBlock = document.createElement('details');
        vBlock.className = 'verbose-block';
        vBlock.open = true;
        const vSummary = document.createElement('summary');
        vSummary.textContent = msg.verboseLabel || 'Verbose';
        vBlock.appendChild(vSummary);
        const vBody = document.createElement('pre');
        vBody.className = 'verbose-body';
        vBody.textContent = content || '';
        vBlock.appendChild(vBody);
        messagesContainer.appendChild(vBlock);
        scrollToBottom();
        break;
      }

      case 'confirm': {
        finishAssistantMessage();
        const confirmCard = document.createElement('div');
        confirmCard.className = 'confirm-card';
        const confirmId = event.data.confirmId;
        confirmCard.dataset.confirmId = confirmId;
        const confirmMsg = document.createElement('div');
        confirmMsg.className = 'confirm-message';
        confirmMsg.textContent = content || 'Confirm action?';
        confirmCard.appendChild(confirmMsg);
        const confirmActions = document.createElement('div');
        confirmActions.className = 'confirm-actions';
        const actions = event.data.confirmActions || ['Allow', 'Deny'];
        for (const label of actions) {
          const btn = document.createElement('button');
          btn.className = 'confirm-btn' + (label === actions[0] ? ' confirm-primary' : '');
          btn.textContent = label;
          btn.addEventListener('click', () => {
            vscode.postMessage({ command: 'confirmResponse', confirmId, confirmed: true, text: label });
            confirmCard.remove();
          });
          confirmActions.appendChild(btn);
        }
        confirmCard.appendChild(confirmActions);
        messagesContainer.appendChild(confirmCard);
        scrollToBottom();
        break;
      }

      case 'dismissConfirm': {
        const id = event.data.confirmId;
        const card = document.querySelector(`.confirm-card[data-confirm-id="${id}"]`);
        if (card) card.remove();
        break;
      }

      case 'toolCall': {
        // Finish the current assistant message so the next text stream
        // creates a new response block after the tool call/result.
        finishAssistantMessage();

        const toolName = event.data.toolName || (content || '').split('(')[0];
        const displayName = formatToolName(toolName);
        const toolDetail = formatToolDetail(toolName, content || '');

        const details = document.createElement('details');
        details.className = 'tool-call running';
        details.id = 'active-tool';
        const summary = document.createElement('summary');
        summary.innerHTML = '';
        const iconSpan = document.createElement('span');
        iconSpan.className = 'tool-icon';
        iconSpan.textContent = getToolIcon(toolName);
        summary.appendChild(iconSpan);
        const nameSpan = document.createElement('span');
        nameSpan.className = 'tool-name';
        nameSpan.textContent = displayName;
        summary.appendChild(nameSpan);
        if (toolDetail) {
          const detailSpan = document.createElement('span');
          detailSpan.className = 'tool-detail';
          detailSpan.textContent = toolDetail;
          summary.appendChild(detailSpan);
        }
        const spinnerSpan = document.createElement('span');
        spinnerSpan.className = 'tool-spinner';
        summary.appendChild(spinnerSpan);
        details.appendChild(summary);
        const body = document.createElement('pre');
        body.className = 'tool-call-body';
        body.textContent = content || '';
        details.appendChild(body);
        messagesContainer.appendChild(details);
        scrollToBottom();
        break;
      }

      case 'toolOutput': {
        // Stream output into the active tool call body
        const activeToolForOutput = document.getElementById('active-tool');
        if (activeToolForOutput) {
          const body = activeToolForOutput.querySelector('.tool-call-body');
          if (body) {
            body.textContent += event.data.content || '';
            // Auto-open the details when output starts flowing
            activeToolForOutput.open = true;
          }
        }
        scrollToBottom();
        break;
      }

      case 'toolResult': {
        // Mark active tool call as complete and remove spinner
        const activeTool = document.getElementById('active-tool');
        if (activeTool) {
          activeTool.classList.remove('running');
          activeTool.removeAttribute('id');
          const spinner = activeTool.querySelector('.tool-spinner');
          if (spinner) spinner.remove();
        }
        const text = content || '';
        const isError = text.startsWith('\u2717') || text.includes('Error');

        // For successful results, just update the active tool call with result info.
        // For errors or when there's no active tool, show a separate result block.
        if (activeTool && !isError) {
          const resultBadge = document.createElement('span');
          resultBadge.className = 'tool-result-badge success';
          resultBadge.textContent = '\u2713';
          const activeSummary = activeTool.querySelector('summary');
          if (activeSummary) activeSummary.appendChild(resultBadge);
          // Append result output to the tool call body
          const activeBody = activeTool.querySelector('.tool-call-body');
          if (activeBody && text) {
            activeBody.textContent += '\n' + text;
          }
        } else {
          const details = document.createElement('details');
          details.className = 'tool-result' + (isError ? ' error' : '');
          const summary = document.createElement('summary');
          const rawName = text.split(':')[0];
          const cleanName = formatToolName(rawName.replace(/^[^\w]*/, '').trim());
          summary.textContent = (isError ? '\u2717 ' : '\u2713 ') + cleanName;
          details.appendChild(summary);
          const body = document.createElement('pre');
          body.className = 'tool-result-body';
          body.textContent = text;
          details.appendChild(body);
          messagesContainer.appendChild(details);
        }
        scrollToBottom();
        break;
      }

      case 'commandResult': {
        const resultDiv = document.createElement('div');
        resultDiv.className = 'message assistant';
        const output = event.data.content || '(no output)';
        const pre = document.createElement('pre');
        pre.className = 'command-output';
        pre.textContent = output;
        resultDiv.appendChild(pre);
        messagesContainer.appendChild(resultDiv);
        scrollToBottom();
        break;
      }

      case 'setModels':
        renderModelList(event.data.models || []);
        break;

      case 'setCurrentModel':
        modelName.textContent = event.data.currentModel || 'Select Model';
        window.currentModelSupportsTools = event.data.supportsTools !== false;
        updateChatOnlyBadge();
        modelPanel.classList.add('hidden');
        break;

      case 'setAgentMode': {
        const select = document.getElementById('agent-mode-select');
        const mode = event.data.agentMode || 'cautious';
        if (select) {
          select.value = mode;
          select.className = 'agent-mode-select mode-' + mode;
        }
        break;
      }

      case 'planReady': {
        const planDiv = document.createElement('div');
        planDiv.className = 'plan-block';
        const planContent = document.createElement('pre');
        planContent.textContent = content || '';
        planDiv.appendChild(planContent);
        const btnRow = document.createElement('div');
        btnRow.className = 'plan-actions';
        const execBtn = document.createElement('button');
        execBtn.textContent = 'Execute Plan';
        execBtn.className = 'plan-btn plan-execute';
        execBtn.addEventListener('click', () => {
          vscode.postMessage({ command: 'executePlan' });
          execBtn.disabled = true;
          execBtn.textContent = 'Executing...';
        });
        const reviseBtn = document.createElement('button');
        reviseBtn.textContent = 'Revise';
        reviseBtn.className = 'plan-btn plan-revise';
        reviseBtn.addEventListener('click', () => {
          const feedback = prompt('How should the plan be revised?');
          if (feedback) vscode.postMessage({ command: 'revisePlan', text: feedback });
        });
        btnRow.appendChild(execBtn);
        btnRow.appendChild(reviseBtn);
        planDiv.appendChild(btnRow);
        messagesContainer.appendChild(planDiv);
        scrollToBottom();
        break;
      }

      case 'sessionList': {
        try {
          const sessions = JSON.parse(content);
          renderSessionsList(sessions);
        } catch (e) {
          console.error('Failed to parse session list:', e);
        }
        break;
      }

      case 'installProgress':
        installingModel = event.data.modelName;
        installProgress.classList.remove('hidden');
        installText.textContent =
          'Installing ' + event.data.modelName + (event.data.progress ? ': ' + event.data.progress : '...');
        if (event.data.models) {
          renderModelList(event.data.models);
        }
        break;

      case 'installComplete':
        installingModel = null;
        installProgress.classList.add('hidden');
        if (event.data.models) {
          renderModelList(event.data.models);
        }
        break;

      case 'fileAttached':
        pendingFile = { fileName: event.data.fileName, fileContent: event.data.fileContent };
        fileAttachmentName.textContent = 'Attached: ' + event.data.fileName;
        fileAttachment.classList.remove('hidden');
        break;

      case 'imageAttached':
        pendingImages.push({ mediaType: event.data.mediaType, data: event.data.data });
        updateImagePreview();
        break;

      case 'fileMoved':
        appendMessage('assistant', content || 'File moved.');
        break;

      case 'githubResult': {
        const resultEl = renderGitHubResult(event.data.githubAction, event.data.githubData);
        messagesContainer.appendChild(resultEl);
        scrollToBottom();
        break;
      }

      case 'error': {
        removeTypingIndicator();
        const progressErr = document.getElementById('agent-progress');
        if (progressErr) progressErr.classList.add('hidden');
        if (currentAssistantDiv) {
          currentAssistantDiv.remove();
          currentAssistantDiv = null;
          currentAssistantText = '';
        }
        const errorDiv = document.createElement('div');
        errorDiv.className = 'message assistant error';
        const errorContent = document.createElement('div');
        errorContent.className = 'error-card';
        errorContent.textContent = content || 'An error occurred';
        errorDiv.appendChild(errorContent);
        if (msg.errorAction) {
          const actionsRow = document.createElement('div');
          actionsRow.className = 'error-actions';
          const actionBtn = document.createElement('button');
          actionBtn.className = 'error-action-btn';
          actionBtn.textContent = msg.errorAction;
          actionBtn.addEventListener('click', () => {
            if (msg.errorActionCommand === 'openSettings') {
              vscode.postMessage({ command: 'openSettings' });
            } else if (msg.errorActionCommand === 'runCommand') {
              vscode.postMessage({ command: 'runCommand', text: 'ollama serve' });
            }
          });
          actionsRow.appendChild(actionBtn);
          if (msg.errorType === 'timeout' || msg.errorType === 'connection') {
            const retryBtn = document.createElement('button');
            retryBtn.className = 'error-action-btn';
            retryBtn.textContent = 'Retry';
            retryBtn.addEventListener('click', () => {
              const lastUser = [...messagesContainer.querySelectorAll('.message.user')].pop();
              if (lastUser) {
                const lastText = lastUser.textContent || '';
                vscode.postMessage({ command: 'userMessage', text: lastText });
              }
            });
            actionsRow.appendChild(retryBtn);
          }
          errorDiv.appendChild(actionsRow);
        }
        messagesContainer.appendChild(errorDiv);
        scrollToBottom();
        setLoading(false);
        break;
      }
    }
  });
})();
