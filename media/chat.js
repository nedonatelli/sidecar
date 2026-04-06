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
    { cmd: '/save', desc: 'Save session' },
    { cmd: '/sessions', desc: 'List sessions' },
    { cmd: '/move', desc: 'Move/rename file' },
    { cmd: '/clone', desc: 'Clone repository' },
    { cmd: '/scan', desc: 'Scan staged files for secrets' },
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
    const needsArg = ['/model', '/batch', '/spec', '/save', '/move', '/clone'].includes(cmd);
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
        container.appendChild(renderContent('```diff\n' + result.diff + '\n```'));
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
      vscode.postMessage({ command: 'listSessions' });
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
          '`/save <name>` — Save session\n' +
          '`/sessions` — List sessions\n' +
          '`/move <src> <dest>` — Move/rename file\n' +
          '`/clone <url>` — Clone repository\n' +
          '`/scan` — Scan staged files for secrets',
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

  function renderContent(text) {
    const fragment = document.createDocumentFragment();
    const codeBlockRegex = /```([\w.]*):?([^\n]*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        const span = document.createElement('span');
        span.textContent = text.slice(lastIndex, match.index);
        fragment.appendChild(span);
      }

      const lang = match[1];
      const filePath = match[2] ? match[2].trim() : '';
      const code = match[3];
      const wrapper = document.createElement('div');
      wrapper.className = 'code-block';

      const header = document.createElement('div');
      header.className = 'code-block-header';
      header.appendChild(document.createTextNode(filePath || lang || 'code'));

      if (filePath) {
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
          const span = document.createElement('span');
          span.textContent = remaining.slice(editLastIndex, editMatch.index);
          fragment.appendChild(span);
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
        const span = document.createElement('span');
        span.textContent = remaining.slice(editLastIndex);
        fragment.appendChild(span);
      }
    }

    return fragment;
  }

  function appendMessage(role, content, isError = false) {
    const div = document.createElement('div');
    div.className = 'message ' + role + (isError ? ' error' : '');
    if (role === 'assistant' && !isError) {
      div.appendChild(renderContent(content));
    } else {
      div.textContent = content;
    }
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

  let lastRenderedBlockCount = 0;

  function countCompletedBlocks(text) {
    const codeBlocks = (text.match(/```[\w.]*:?[^\n]*\n[\s\S]*?```/g) || []).length;
    const editBlocks = (text.match(/<<<SEARCH:[^\n]+\n[\s\S]*?\n===\n[\s\S]*?\n>>>REPLACE/g) || []).length;
    return codeBlocks + editBlocks;
  }

  function getTrailingText(text) {
    // Find the end position of the last completed code block
    const codeBlockRegex = /```[\w.]*:?[^\n]*\n[\s\S]*?```/g;
    let lastMatchEnd = 0;
    let m;
    while ((m = codeBlockRegex.exec(text)) !== null) {
      lastMatchEnd = m.index + m[0].length;
    }
    return text.slice(lastMatchEnd);
  }

  function appendToAssistantMessage(content) {
    if (!currentAssistantDiv) return;
    currentAssistantText += content;

    const blockCount = countCompletedBlocks(currentAssistantText);

    if (blockCount !== lastRenderedBlockCount) {
      // New code/edit block completed — full re-render
      lastRenderedBlockCount = blockCount;
      currentAssistantDiv.innerHTML = '';
      currentAssistantDiv.appendChild(renderContent(currentAssistantText));
    } else {
      // Plain text streaming — update only the trailing text span
      const lastChild = currentAssistantDiv.lastChild;
      if (lastChild && lastChild.nodeType === Node.ELEMENT_NODE && lastChild.tagName === 'SPAN') {
        lastChild.textContent = getTrailingText(currentAssistantText);
      } else {
        currentAssistantDiv.innerHTML = '';
        currentAssistantDiv.appendChild(renderContent(currentAssistantText));
      }
    }
    scrollToBottom();
  }

  function finishAssistantMessage() {
    if (currentAssistantDiv && currentAssistantText) {
      // Final full render to ensure complete content with all buttons
      currentAssistantDiv.innerHTML = '';
      currentAssistantDiv.appendChild(renderContent(currentAssistantText));
    }
    currentAssistantDiv = null;
    currentAssistantText = '';
    lastRenderedBlockCount = 0;
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
    for (const model of models) {
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

  // Handle messages from extension
  window.addEventListener('message', (event) => {
    const { command, content } = event.data;

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

      case 'confirm': {
        finishAssistantMessage();
        const confirmCard = document.createElement('div');
        confirmCard.className = 'confirm-card';
        const confirmMsg = document.createElement('div');
        confirmMsg.className = 'confirm-message';
        confirmMsg.textContent = content || 'Confirm action?';
        confirmCard.appendChild(confirmMsg);
        const confirmActions = document.createElement('div');
        confirmActions.className = 'confirm-actions';
        const actions = event.data.confirmActions || ['Allow', 'Deny'];
        const confirmId = event.data.confirmId;
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

      case 'toolCall': {
        // Finish the current assistant message so the next text stream
        // creates a new response block after the tool call/result.
        finishAssistantMessage();

        const details = document.createElement('details');
        details.className = 'tool-call running';
        details.id = 'active-tool';
        const summary = document.createElement('summary');
        summary.textContent = '\u2699 ' + (content || '').split('(')[0] + ' \u2026';
        details.appendChild(summary);
        const body = document.createElement('pre');
        body.className = 'tool-call-body';
        body.textContent = content || '';
        details.appendChild(body);
        messagesContainer.appendChild(details);
        scrollToBottom();
        break;
      }

      case 'toolResult': {
        // Mark active tool call as complete
        const activeTool = document.getElementById('active-tool');
        if (activeTool) {
          activeTool.classList.remove('running');
          activeTool.removeAttribute('id');
          const activeSummary = activeTool.querySelector('summary');
          if (activeSummary) {
            activeSummary.textContent = activeSummary.textContent.replace(' \u2026', '');
          }
        }
        const details = document.createElement('details');
        details.className = 'tool-result';
        const summary = document.createElement('summary');
        const text = content || '';
        const isError = text.startsWith('\u2717') || text.includes('Error');
        summary.textContent = (isError ? '\u2717 ' : '\u2713 ') + text.split(':')[0];
        details.appendChild(summary);
        const body = document.createElement('pre');
        body.className = 'tool-result-body';
        body.textContent = text;
        details.appendChild(body);
        messagesContainer.appendChild(details);
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
        // Could be rendered in a panel — for now just log
        console.log('Sessions:', content);
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
