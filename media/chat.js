// SideCar chat webview script.
// Plain browser JS (IIFE) — not checked by the repo tsconfig (which only
// includes src/**/*) and not linted by eslint.config.mjs (scoped to
// src/**/*.ts). No @ts-nocheck needed. Helper modules live under
// media/chat/ and attach to the window.SideCar namespace before this file
// runs — see chatWebview.getChatWebviewHtml for the script load order.

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
  const modelSearchInput = document.getElementById('model-search-input');
  const customModelInput = document.getElementById('custom-model-input');
  const customModelUse = document.getElementById('custom-model-use');

  let isLoading = false;
  let currentAssistantDiv = null;
  let currentAssistantText = '';
  let installingModel = null;
  let cachedModels = [];
  let bgAgentRuns = [];
  let pendingFile = null;
  let pendingImages = [];
  const imagePreview = document.getElementById('image-preview');
  let streamStartTime = 0;
  let streamCharCount = 0;
  const streamStats = document.getElementById('stream-stats');
  let typingTimerStart = 0;
  let typingTimerInterval = null;
  let pendingPlanReady = false;

  // Mermaid lazy-loader
  let mermaidReady = null; // resolves when mermaid is loaded
  let mermaidIdCounter = 0;

  /**
   * Apply chat UI theme settings pushed from the extension.
   * Maps density/font/accent to CSS custom properties on the root element
   * so CSS rules in chat.css can consume them. Values are validated before
   * being written to the DOM to keep untrusted strings out of the style.
   */
  function applyUiSettings(opts) {
    if (!opts) return;
    const root = document.documentElement;

    const density = opts.chatDensity;
    if (density === 'compact' || density === 'normal' || density === 'comfortable') {
      root.dataset.chatDensity = density;
    }

    if (typeof opts.chatFontSize === 'number' && opts.chatFontSize >= 10 && opts.chatFontSize <= 22) {
      root.style.setProperty('--sidecar-chat-font-size', opts.chatFontSize + 'px');
    }

    // Only accept CSS colors we can unambiguously validate — hex, rgb(a),
    // hsl(a), or a short named-color allowlist. Reject anything else so the
    // user can't smuggle other style properties into the chat through the
    // settings value.
    const raw = (opts.chatAccentColor || '').trim();
    if (raw === '') {
      root.style.removeProperty('--sidecar-chat-accent');
    } else if (isSafeCssColor(raw)) {
      root.style.setProperty('--sidecar-chat-accent', raw);
    }
  }

  function isSafeCssColor(value) {
    if (!value || value.length > 64) return false;
    // Hex: #rgb, #rgba, #rrggbb, #rrggbbaa
    if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return true;
    // Functional notation: rgb(), rgba(), hsl(), hsla() — only digits, %, commas, spaces, dots
    if (/^(rgb|rgba|hsl|hsla)\(\s*[\d.\s,%\/]+\s*\)$/i.test(value)) return true;
    // Small allowlist of common named colors
    const named = new Set([
      'transparent',
      'black',
      'white',
      'red',
      'green',
      'blue',
      'yellow',
      'orange',
      'purple',
      'pink',
      'cyan',
      'magenta',
      'gray',
      'grey',
    ]);
    return named.has(value.toLowerCase());
  }

  function loadMermaid() {
    if (mermaidReady) return mermaidReady;
    mermaidReady = new Promise((resolve, reject) => {
      // ESM-bundled mermaid sets window.mermaid = { default: { initialize, render, ... } }
      const unwrap = (m) => (m && m.default && typeof m.default.initialize === 'function' ? m.default : m);
      if (window.mermaid) {
        const m = unwrap(window.mermaid);
        m.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
        resolve(m);
        return;
      }
      const src = window.__mermaidSrc;
      if (!src) {
        reject(new Error('Mermaid source not configured'));
        return;
      }
      console.log('[SideCar] Loading mermaid.js from:', src);
      const script = document.createElement('script');
      script.src = src;
      if (window.__nonce) script.setAttribute('nonce', window.__nonce);
      script.onload = () => {
        console.log('[SideCar] Mermaid loaded, initializing...');
        try {
          const m = unwrap(window.mermaid);
          m.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
          console.log('[SideCar] Mermaid initialized successfully');
          resolve(m);
        } catch (initErr) {
          console.error('[SideCar] Mermaid init failed:', initErr);
          reject(initErr);
        }
      };
      script.onerror = (e) => {
        console.error('[SideCar] Failed to load mermaid.js script:', e);
        reject(new Error('Failed to load mermaid'));
      };
      document.head.appendChild(script);
    });
    return mermaidReady;
  }

  async function renderMermaidBlock(container, code, copyBtn) {
    // Skip if this container has already been rendered or is in progress
    if (container.dataset.mermaidState === 'rendering' || container.dataset.mermaidState === 'done') {
      return;
    }
    container.dataset.mermaidState = 'rendering';

    try {
      const m = await loadMermaid();

      // Check if container was detached from DOM during mermaid load
      // (happens when finishAssistantMessage clears and re-renders)
      if (!container.parentNode) {
        return;
      }

      const id = 'mermaid-' + ++mermaidIdCounter;
      const { svg } = await m.render(id, code);

      // Check again after async render — container may have been detached
      if (!container.parentNode) return;

      // Sanitize SVG content to prevent XSS
      const sanitizedSvg = sanitizeSvg(svg);
      if (!sanitizedSvg) {
        container.textContent = 'Diagram render produced empty SVG';
        container.classList.add('diagram-error');
        container.dataset.mermaidState = 'error';
        return;
      }
      container.innerHTML = sanitizedSvg;
      container.classList.add('diagram-rendered');
      container.dataset.mermaidState = 'done';

      if (copyBtn) {
        copyBtn.style.visibility = 'visible';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(svg).then(() => {
            copyBtn.textContent = 'Copied!';
            setTimeout(() => {
              copyBtn.textContent = 'Copy SVG';
            }, 1500);
          });
        });
      }
    } catch (err) {
      console.error('[SideCar] Mermaid render failed:', err);
      container.textContent = 'Diagram error: ' + (err.message || err);
      container.classList.add('diagram-error');
      container.dataset.mermaidState = 'error';
    }
  }

  // Sanitize SVG content using DOM parsing with an allowlist approach.
  // The allowlist must include tags that mermaid.js produces (style, a, etc.)
  const SVG_ALLOWED_TAGS = new Set([
    // Core SVG structure
    'svg',
    'g',
    'defs',
    'use',
    'symbol',
    // Shapes
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    // Text
    'text',
    'tspan',
    'textpath',
    // Styling (required by mermaid for themed diagrams)
    'style',
    // Links (mermaid click targets)
    'a',
    // Gradients & patterns
    'lineargradient',
    'radialgradient',
    'stop',
    'pattern',
    // Clipping & masking
    'clippath',
    'mask',
    'marker',
    // Filters
    'filter',
    'fegaussianblur',
    'feoffset',
    'feblend',
    'fecolormatrix',
    'fecomponenttransfer',
    'fecomposite',
    'feflood',
    'femerge',
    'femergenode',
    // Image & embedded content
    'image',
    'foreignobject',
    // Metadata
    'title',
    'desc',
    // HTML inside foreignObject (mermaid uses these for labels)
    'span',
    'div',
    'p',
    'br',
    'em',
    'strong',
    'i',
    'b',
    'pre',
    'code',
  ]);
  const SVG_DANGEROUS_ATTRS = /^on/i;
  const SVG_DANGEROUS_VALS = /javascript:|data:text\/html/i;

  function sanitizeSvg(svgContent) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(svgContent, 'image/svg+xml');
      const errorNode = doc.querySelector('parsererror');
      if (errorNode) return ''; // Reject unparseable SVG entirely

      function cleanNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const tag = node.tagName.toLowerCase();
          // Remove disallowed elements (script, animate, set, etc.)
          if (!SVG_ALLOWED_TAGS.has(tag)) {
            node.remove();
            return;
          }
          // Sanitize <style> contents — strip @import and url() to prevent data exfiltration
          if (tag === 'style' && node.textContent) {
            node.textContent = node.textContent
              .replace(/@import\b[^;]*/gi, '/* blocked */')
              .replace(/url\s*\([^)]*\)/gi, 'url()');
          }
          // Remove dangerous attributes
          for (const attr of [...node.attributes]) {
            if (SVG_DANGEROUS_ATTRS.test(attr.name) || SVG_DANGEROUS_VALS.test(attr.value)) {
              node.removeAttribute(attr.name);
            }
          }
          // Sanitize href on <a> — only allow fragment links
          if (tag === 'a') {
            const href = node.getAttribute('href') || node.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
            if (href && !href.startsWith('#')) {
              node.removeAttribute('href');
              node.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
            }
          }
        }
        for (const child of [...node.childNodes]) {
          cleanNode(child);
        }
      }

      cleanNode(doc.documentElement);
      return new XMLSerializer().serializeToString(doc.documentElement);
    } catch {
      return ''; // If anything goes wrong, return empty SVG
    }
  }

  modelBtn.addEventListener('click', () => {
    modelPanel.classList.toggle('hidden');
    if (!modelPanel.classList.contains('hidden')) {
      modelSearchInput.focus();
    }
  });

  closePanel.addEventListener('click', () => {
    modelPanel.classList.add('hidden');
  });

  modelSearchInput.addEventListener('input', () => {
    renderModelList(cachedModels, modelSearchInput.value.trim());
  });

  cancelInstall.addEventListener('click', () => {
    vscode.postMessage({ command: 'cancelInstall' });
  });

  // Attach button context menu — shows file attach + available skills
  let attachMenuEl = null;
  let pendingSkillsCallback = null;

  function showAttachMenu() {
    if (attachMenuEl) {
      attachMenuEl.remove();
      attachMenuEl = null;
      return;
    }

    attachMenuEl = document.createElement('div');
    attachMenuEl.className = 'attach-menu';

    // Always show "Attach File" first
    const fileItem = document.createElement('div');
    fileItem.className = 'attach-menu-item';
    fileItem.innerHTML = '&#128206; Attach File';
    fileItem.addEventListener('click', () => {
      vscode.postMessage({ command: 'attachFile' });
      closeAttachMenu();
    });
    attachMenuEl.appendChild(fileItem);

    // Add a divider
    const divider = document.createElement('div');
    divider.className = 'attach-menu-divider';
    divider.textContent = 'Skills';
    attachMenuEl.appendChild(divider);

    // Loading placeholder
    const loading = document.createElement('div');
    loading.className = 'attach-menu-item attach-menu-loading';
    loading.textContent = 'Loading skills...';
    attachMenuEl.appendChild(loading);

    // Position relative to the attach button
    const rect = attachBtn.getBoundingClientRect();
    attachMenuEl.style.bottom = window.innerHeight - rect.top + 4 + 'px';
    attachMenuEl.style.left = rect.left + 'px';
    document.body.appendChild(attachMenuEl);

    // Request skills from extension
    pendingSkillsCallback = (skills) => {
      if (!attachMenuEl) return;
      loading.remove();
      if (!skills || skills.length === 0) {
        const noSkills = document.createElement('div');
        noSkills.className = 'attach-menu-item attach-menu-empty';
        noSkills.textContent = 'No skills found';
        attachMenuEl.appendChild(noSkills);
      } else {
        for (const skill of skills) {
          const item = document.createElement('div');
          item.className = 'attach-menu-item attach-menu-skill';
          item.innerHTML =
            '<strong>/' +
            skill.id +
            '</strong>' +
            (skill.description ? '<span class="attach-menu-desc">' + skill.description + '</span>' : '');
          item.title = skill.description || skill.name;
          item.addEventListener('click', () => {
            input.value = '/' + skill.id + ' ';
            input.focus();
            closeAttachMenu();
          });
          attachMenuEl.appendChild(item);
        }
      }
    };
    vscode.postMessage({ command: 'getSkillsForMenu' });

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', closeAttachMenuOnOutside);
    }, 0);
  }

  function closeAttachMenu() {
    if (attachMenuEl) {
      attachMenuEl.remove();
      attachMenuEl = null;
    }
    pendingSkillsCallback = null;
    document.removeEventListener('click', closeAttachMenuOnOutside);
  }

  function closeAttachMenuOnOutside(e) {
    if (attachMenuEl && !attachMenuEl.contains(e.target) && e.target !== attachBtn) {
      closeAttachMenu();
    }
  }

  attachBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showAttachMenu();
  });

  removeAttachment.addEventListener('click', () => {
    pendingFile = null;
    fileAttachment.classList.add('hidden');
  });

  customModelUse.addEventListener('click', () => {
    const name = customModelInput.value.trim();
    if (!name) return;
    // Detect HuggingFace URLs and trigger install instead of just switching
    const isHF = /huggingface\.co\/|^hf\.co\//i.test(name);
    if (isHF) {
      vscode.postMessage({ command: 'installModel', model: name });
    } else {
      vscode.postMessage({ command: 'changeModel', model: name });
    }
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
      removeBtn.dataset.imageIndex = i;
      const wrapper = document.createElement('span');
      wrapper.className = 'image-thumb-wrapper';
      wrapper.appendChild(img);
      wrapper.appendChild(removeBtn);
      imagePreview.appendChild(wrapper);
    }
  }

  // Event delegation for image remove buttons — avoids closure capture of loop variable
  imagePreview.addEventListener('click', (e) => {
    if (e.target.classList.contains('image-remove')) {
      const index = parseInt(e.target.dataset.imageIndex, 10);
      pendingImages.splice(index, 1);
      updateImagePreview();
    }
  });

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

  // Event delegation for session list — single listener instead of per-item
  sessionsList.addEventListener('click', (e) => {
    const target = e.target;
    const item = target.closest('.session-item');
    if (!item) return;
    const id = item.dataset.sessionId;
    if (!id) return;

    if (target.closest('.session-delete-btn')) {
      e.stopPropagation();
      vscode.postMessage({ command: 'deleteSession', text: id });
    } else {
      vscode.postMessage({ command: 'loadSession', text: id });
      sessionsPanel.classList.add('hidden');
    }
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

    // Build all items in a fragment to avoid per-item reflow
    const fragment = document.createDocumentFragment();
    for (const s of sessions) {
      const item = document.createElement('div');
      item.className = 'session-item';
      item.dataset.sessionId = s.id;

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

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'session-delete-btn';
      deleteBtn.textContent = 'Delete';

      actions.appendChild(loadBtn);
      actions.appendChild(deleteBtn);

      item.appendChild(info);
      item.appendChild(actions);

      fragment.appendChild(item);
    }
    sessionsList.appendChild(fragment);
  }

  document.getElementById('new-chat-btn').addEventListener('click', () => {
    vscode.postMessage({ command: 'newChat' });
  });

  document.getElementById('compact-btn').addEventListener('click', () => {
    vscode.postMessage({ command: 'compactContext' });
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
    e.target.className = 'agent-mode-select mode-' + (mode === 'plan' ? 'plan' : mode);
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
    { cmd: '/audit', desc: 'Agent action audit log' },
    { cmd: '/insights', desc: 'Conversation pattern analysis' },
    { cmd: '/mcp', desc: 'MCP server status' },
    { cmd: '/verbose', desc: 'Toggle verbose mode (show agent reasoning)' },
    { cmd: '/prompt', desc: 'Show the current system prompt' },
    { cmd: '/skills', desc: 'List available Claude Code & SideCar skills' },
    { cmd: '/releases', desc: 'List GitHub releases' },
    { cmd: '/release', desc: 'Show, create, or delete a release' },
    { cmd: '/compact', desc: 'Compact conversation context to free tokens' },
    { cmd: '/init', desc: 'Generate SIDECAR.md project notes from codebase' },
    { cmd: '/bg', desc: 'Run a task in the background' },
  ];
  const autocompleteEl = document.getElementById('slash-autocomplete');
  let acSelectedIndex = -1;
  let loadedSkillCommands = [];
  let skillsLoadedForAutocomplete = false;

  function updateAutocomplete() {
    // Request skills from extension on first autocomplete trigger
    if (!skillsLoadedForAutocomplete) {
      skillsLoadedForAutocomplete = true;
      vscode.postMessage({ command: 'getSkillsForMenu' });
    }
    const text = input.value;
    // Only show when text starts with / and is a single line with no spaces yet (or just the command)
    const match = text.match(/^\/(\S*)$/);
    if (!match) {
      autocompleteEl.classList.add('hidden');
      acSelectedIndex = -1;
      return;
    }
    const query = match[1].toLowerCase();
    // Merge built-in commands with dynamically loaded skills
    const allCommands = [...slashCommands, ...loadedSkillCommands];
    const filtered = allCommands.filter((c) => c.cmd.slice(1).startsWith(query));
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

  // Auto-resize textarea and update send button label
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    updateAutocomplete();
    updateSendButton();
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
    const hasText = input.value.trim().length > 0;
    if (hasText) {
      submitMessage();
    } else if (isLoading) {
      vscode.postMessage({ command: 'abort' });
      setLoading(false);
    }
  });

  // Global Escape key — abort processing or dismiss confirm/clarify cards
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Don't handle if autocomplete is open (input handler manages that)
    if (!autocompleteEl.classList.contains('hidden')) return;
    if (!isLoading) return;
    e.preventDefault();
    vscode.postMessage({ command: 'abort' });
    setLoading(false);
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

    // /releases [repo] or list releases [repo]
    m = text.match(/^(?:\/releases|(?:show|list)\s+releases?)(?:\s+(.+?))?\s*$/i);
    if (m) return { action: 'listReleases', repo: m[1] };

    // /release <tag> [repo] or show release <tag>
    m = text.match(/^(?:\/release|show\s+release)\s+(\S+)(?:\s+(.+?))?\s*$/i);
    if (m && m[1] !== 'create' && m[1] !== 'delete') return { action: 'getRelease', tag: m[1], repo: m[2] };

    // /release create <tag> ["title"] ["body"] [--draft] [--prerelease] [--notes]
    m = text.match(/^(?:\/release\s+create|create\s+release)\s+(\S+)(?:\s+"([^"]*)")?(?:\s+"([^"]*)")?(.*)?$/i);
    if (m) {
      const flags = m[4] || '';
      return {
        action: 'createRelease',
        tag: m[1],
        title: m[2],
        body: m[3],
        draft: /--draft/i.test(flags),
        prerelease: /--prerelease/i.test(flags),
        generateNotes: /--notes/i.test(flags),
      };
    }

    // /release delete <tag>
    m = text.match(/^(?:\/release\s+delete|delete\s+release)\s+(\S+)(?:\s+(.+?))?\s*$/i);
    if (m) return { action: 'deleteRelease', tag: m[1], repo: m[2] };

    return null;
  }

  // GitHub card rendering lives in media/chat/githubCards.js. Delegating
  // here keeps chat.js focused on chat/agent-loop logic while the card
  // builder can evolve independently.
  function renderGitHubResult(action, data) {
    return window.SideCar.githubCards.renderGitHubResult(
      { vscode, renderContent, currentModelSupportsTools: window.currentModelSupportsTools },
      action,
      data,
    );
  }

  function submitMessage() {
    const text = input.value.trim();
    if (!text) return;

    // If the agent is already running, abort it first — the extension
    // backend will handle the race (chatHandlers aborts the previous loop
    // and bumps chatGeneration before processing the new message).
    if (isLoading) {
      vscode.postMessage({ command: 'abort' });
    }

    // Check for slash commands missing required arguments
    const usageHints = {
      '/spec': { syntax: '/spec <description>', desc: 'Generate a structured specification for a feature' },
      '/batch': { syntax: '/batch <tasks>', desc: 'Run multiple tasks (one per line)' },
      '/save': { syntax: '/save <name>', desc: 'Save the current session with a name' },
      '/model': { syntax: '/model <name>', desc: 'Switch to a different model' },
      '/move': { syntax: '/move <source> <dest>', desc: 'Move or rename a file' },
      '/clone': { syntax: '/clone <url>', desc: 'Clone a Git repository' },
      '/scaffold': { syntax: '/scaffold <type>', desc: 'Generate code from a template' },
      '/revise': { syntax: '/revise <feedback>', desc: 'Revise the current plan with feedback' },
      '/bg': { syntax: '/bg <task>', desc: 'Spawn a background agent to work on a task autonomously' },
    };
    const bareCmd = text.trim().match(/^(\/\w+)$/);
    if (bareCmd && usageHints[bareCmd[1]]) {
      const hint = usageHints[bareCmd[1]];
      appendMessage('user', text);
      appendMessage('assistant', `**Usage:** \`${hint.syntax}\`\n${hint.desc}`);
      input.value = '';
      input.style.height = 'auto';
      return;
    }

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
    if (text.trim() === '/init') {
      appendMessage('user', '/init');
      vscode.postMessage({ command: 'initProject' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.startsWith('/bg ')) {
      const bgTask = text.slice(4).trim();
      if (bgTask) {
        appendMessage('user', text);
        vscode.postMessage({ command: 'bgStart', text: bgTask });
        input.value = '';
        input.style.height = 'auto';
        return;
      }
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
    if (text.trim() === '/audit' || text.trim().startsWith('/audit ')) {
      appendMessage('user', text);
      vscode.postMessage({ command: 'audit', text: text.slice(6).trim() });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/insights') {
      appendMessage('user', '/insights');
      vscode.postMessage({ command: 'insights' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/mcp') {
      appendMessage('user', '/mcp');
      vscode.postMessage({ command: 'mcpStatus' });
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
    if (text.trim() === '/compact') {
      vscode.postMessage({ command: 'compactContext' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim().startsWith('/revise ')) {
      const feedback = text.trim().slice(8);
      if (feedback) {
        appendMessage('user', 'Revise: ' + feedback);
        vscode.postMessage({ command: 'revisePlan', text: feedback });
      }
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
    if (text.trim() === '/skills') {
      appendMessage('user', '/skills');
      vscode.postMessage({ command: 'listSkills' });
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
          '`/audit [filters]` — Agent action audit log\n' +
          '`/insights` — Conversation pattern analysis\n' +
          '`/mcp` — MCP server status\n' +
          '`/verbose` — Toggle verbose mode (show agent reasoning)\n' +
          '`/compact` — Compact conversation context to free tokens\n' +
          '`/init` — Generate SIDECAR.md project notes from codebase\n' +
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

      // Bullet list: - or * at start (collect consecutive list items, allow blank lines between)
      if (/^\s*[-*]\s+/.test(line)) {
        const ul = document.createElement('ul');
        while (i < lines.length) {
          if (/^\s*[-*]\s+/.test(lines[i])) {
            const li = document.createElement('li');
            // Collect continuation lines (non-empty lines that aren't a new list item)
            let itemText = lines[i].replace(/^\s*[-*]\s+/, '');
            i++;
            while (
              i < lines.length &&
              lines[i].trim() !== '' &&
              !/^\s*[-*]\s+/.test(lines[i]) &&
              !/^\s*\d+\.\s+/.test(lines[i]) &&
              !/^#{1,4}\s+/.test(lines[i])
            ) {
              itemText += ' ' + lines[i].trim();
              i++;
            }
            appendInlineMarkdown(li, itemText);
            ul.appendChild(li);
          } else if (lines[i].trim() === '' && i + 1 < lines.length && /^\s*[-*]\s+/.test(lines[i + 1])) {
            // Skip blank line between list items
            i++;
          } else {
            break;
          }
        }
        parent.appendChild(ul);
        continue;
      }

      // Numbered list: 1. 2. etc (collect consecutive items, allow blank lines between)
      if (/^\s*\d+\.\s+/.test(line)) {
        const ol = document.createElement('ol');
        while (i < lines.length) {
          if (/^\s*\d+\.\s+/.test(lines[i])) {
            const li = document.createElement('li');
            // Collect continuation lines (non-empty lines that aren't a new list item)
            let itemText = lines[i].replace(/^\s*\d+\.\s+/, '');
            i++;
            while (
              i < lines.length &&
              lines[i].trim() !== '' &&
              !/^\s*\d+\.\s+/.test(lines[i]) &&
              !/^\s*[-*]\s+/.test(lines[i]) &&
              !/^#{1,4}\s+/.test(lines[i])
            ) {
              itemText += ' ' + lines[i].trim();
              i++;
            }
            appendInlineMarkdown(li, itemText);
            ol.appendChild(li);
          } else if (lines[i].trim() === '' && i + 1 < lines.length && /^\s*\d+\.\s+/.test(lines[i + 1])) {
            // Skip blank line between numbered list items
            i++;
          } else {
            break;
          }
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

      // Render mermaid blocks as diagrams, unless mermaid is disabled via
      // settings — in which case fall through to the normal code-block path
      // so users who never use diagrams don't pay the 5.2MB load cost.
      if (lang.toLowerCase() === 'mermaid' && window.__mermaidEnabled !== false) {
        const diagramBlock = document.createElement('div');
        diagramBlock.className = 'diagram-block';
        const diagramHeader = document.createElement('div');
        diagramHeader.className = 'diagram-header';
        diagramHeader.textContent = 'Diagram';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'code-save-btn';
        copyBtn.textContent = 'Copy SVG';
        copyBtn.style.visibility = 'hidden';
        diagramHeader.appendChild(copyBtn);
        diagramBlock.appendChild(diagramHeader);
        const diagramContainer = document.createElement('div');
        diagramContainer.className = 'diagram-container';
        diagramContainer.textContent = mermaidReady ? 'Rendering diagram...' : 'Loading diagram engine...';
        diagramBlock.appendChild(diagramContainer);
        // Show mermaid source in a collapsible detail
        const details = document.createElement('details');
        details.className = 'diagram-source';
        const summary = document.createElement('summary');
        summary.textContent = 'View source';
        details.appendChild(summary);
        const sourcePre = document.createElement('pre');
        sourcePre.textContent = code;
        details.appendChild(sourcePre);
        diagramBlock.appendChild(details);
        fragment.appendChild(diagramBlock);
        renderMermaidBlock(diagramContainer, code.trim(), copyBtn);
        lastIndex = match.index + match[0].length;
        continue;
      }

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
        runBtn.dataset.action = 'run';
        runBtn.dataset.code = code.trim();
        header.appendChild(runBtn);
      }

      const saveBtn = document.createElement('button');
      saveBtn.className = 'code-save-btn';
      saveBtn.textContent = 'Save As...';
      saveBtn.dataset.action = 'save';
      saveBtn.dataset.code = code;
      saveBtn.dataset.lang = lang;
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

  let messageCounter = 0;

  /**
   * Close the in-progress reasoning block so the next thinking event opens a
   * new segment. Stamps the block with an elapsed-time badge and converts its
   * summary label from "Reasoning..." to "Reasoning" so the timeline reads as
   * a series of completed steps.
   */
  function finalizeCurrentThinking() {
    const el = document.getElementById('current-thinking');
    if (!el) return;
    el.removeAttribute('id');
    el.classList.add('completed');
    const label = el.querySelector('.step-label');
    if (label && label.textContent === 'Reasoning...') {
      label.textContent = 'Reasoning';
    }
    stampStepDuration(el);
  }

  /**
   * Append a `.step-duration` badge to an element's summary showing the
   * elapsed time since its `dataset.stepStart` was recorded. No-op if the
   * step was too short to bother showing, or if a badge already exists.
   */
  function stampStepDuration(el) {
    if (!el || !el.dataset || !el.dataset.stepStart) return;
    const summary = el.querySelector('summary');
    if (!summary || summary.querySelector('.step-duration')) return;
    const start = Number(el.dataset.stepStart);
    if (!start || Number.isNaN(start)) return;
    const elapsed = Date.now() - start;
    if (elapsed < 500) return;
    const badge = document.createElement('span');
    badge.className = 'step-duration';
    badge.textContent = elapsed < 1000 ? elapsed + 'ms' : (elapsed / 1000).toFixed(1) + 's';
    summary.appendChild(badge);
  }

  // ---------------------------------------------------------------------------
  // Message list virtualization
  //
  // Long conversations (200+ turns) grow the DOM node count past the point
  // where layout, scroll, and streaming updates stay cheap. This module
  // detaches the inner content of messages that are scrolled far offscreen
  // and replaces it with an empty shell pinned to the original pixel height.
  // Scrolling back near a placeholder rehydrates it from `dataset.rawContent`.
  //
  // Only text messages (those with `dataset.rawContent`) are virtualized —
  // rich cards (audit panels, diffs, confirmation prompts, mermaid diagrams)
  // stay mounted because their structure isn't serialized on the element.
  // ---------------------------------------------------------------------------
  const virtualizer = (function () {
    const DETACH_ROOT_MARGIN = '1200px 0px 1200px 0px';
    const REATTACH_ROOT_MARGIN = '400px 0px 400px 0px';
    const MIN_VIRTUALIZABLE_HEIGHT = 48;

    // Disable entirely if IntersectionObserver isn't available (older webviews).
    const supported = typeof IntersectionObserver !== 'undefined';

    // Map placeholder → { role, raw, wasErr } so we can rebuild on rehydrate.
    const placeholderData = new WeakMap();

    let detachObserver = null;
    let reattachObserver = null;

    function ensureObservers() {
      if (!supported || detachObserver) return;
      detachObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) continue;
            detachMessage(entry.target);
          }
        },
        { root: messagesContainer, rootMargin: DETACH_ROOT_MARGIN },
      );
      reattachObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            reattachMessage(entry.target);
          }
        },
        { root: messagesContainer, rootMargin: REATTACH_ROOT_MARGIN },
      );
    }

    function detachMessage(el) {
      if (!el || el.classList.contains('virtualized')) return;
      if (el === currentAssistantDiv) return;
      if (!el.dataset || !el.dataset.rawContent) return;
      const height = el.offsetHeight;
      if (height < MIN_VIRTUALIZABLE_HEIGHT) return;

      const role = el.classList.contains('user') ? 'user' : 'assistant';
      const wasErr = el.classList.contains('error');
      placeholderData.set(el, { role, wasErr, raw: el.dataset.rawContent });

      el.classList.add('virtualized');
      el.style.height = height + 'px';
      while (el.firstChild) el.removeChild(el.firstChild);

      detachObserver.unobserve(el);
      reattachObserver.observe(el);
    }

    function reattachMessage(el) {
      const data = placeholderData.get(el);
      if (!data) return;

      el.classList.remove('virtualized');
      el.style.height = '';

      if (data.role === 'assistant' && !data.wasErr) {
        try {
          el.appendChild(renderContent(data.raw, window.currentModelSupportsTools));
          postProcessMarkdown(el);
        } catch (err) {
          console.error('SideCar: virtualizer rehydrate failed:', err);
          el.textContent = data.raw;
        }
      } else {
        el.textContent = data.raw;
      }
      addMessageActions(el);

      placeholderData.delete(el);
      reattachObserver.unobserve(el);
      detachObserver.observe(el);
    }

    function observe(el) {
      if (!supported || !el || !el.classList || !el.classList.contains('message')) return;
      if (!el.dataset || !el.dataset.rawContent) return;
      ensureObservers();
      detachObserver.observe(el);
    }

    function reset() {
      if (!supported) return;
      if (detachObserver) detachObserver.disconnect();
      if (reattachObserver) reattachObserver.disconnect();
      detachObserver = null;
      reattachObserver = null;
    }

    return { observe, reset };
  })();

  /** Add copy and delete action buttons to a message div. */
  function addMessageActions(div) {
    // Remove existing actions if present (for re-render cases)
    const existing = div.querySelector('.message-actions');
    if (existing) existing.remove();

    const actions = document.createElement('div');
    actions.className = 'message-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'message-action-btn message-copy-btn';
    copyBtn.innerHTML = '&#x2398;';
    copyBtn.title = 'Copy message';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const raw = div.dataset.rawContent || div.innerText;
      navigator.clipboard.writeText(raw).then(() => {
        copyBtn.innerHTML = '&#x2713;';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.innerHTML = '&#x2398;';
          copyBtn.classList.remove('copied');
        }, 1500);
      });
    });
    actions.appendChild(copyBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'message-action-btn message-delete-btn';
    deleteBtn.textContent = '\u00d7';
    deleteBtn.title = 'Delete message';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = parseInt(div.dataset.msgIndex, 10);
      if (!isNaN(index)) {
        vscode.postMessage({ command: 'deleteMessage', index });
        div.remove();
      }
    });
    actions.appendChild(deleteBtn);

    div.appendChild(actions);
  }

  function appendMessage(role, content, isError = false) {
    const div = document.createElement('div');
    div.className = 'message ' + role + (isError ? ' error' : '');
    div.dataset.msgIndex = String(messageCounter++);
    // Store raw markdown content for the copy button (not rendered HTML)
    div.dataset.rawContent = content || '';
    if (role === 'assistant' && !isError) {
      div.appendChild(renderContent(content, window.currentModelSupportsTools));
      postProcessMarkdown(div);
    } else {
      div.textContent = content;
    }

    addMessageActions(div);
    messagesContainer.appendChild(div);
    virtualizer.observe(div);
    scrollToBottom();
    return div;
  }

  function startAssistantMessage() {
    currentAssistantText = '';
    lastRenderedLen = 0;
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    if (streamingSpan && streamingSpan.parentNode) {
      streamingSpan.remove();
    }
    streamingSpan = null;
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
    const pendingText = text.slice(boundary);

    // Only render if the safe portion has grown
    if (boundary > lastRenderedLen) {
      // Remove the streaming span before appending new content
      if (streamingSpan && streamingSpan.parentNode) {
        streamingSpan.remove();
      }
      // Render ONLY the new incremental slice and append it
      const newSlice = text.slice(lastRenderedLen, boundary);
      if (newSlice) {
        currentAssistantDiv.appendChild(renderContent(newSlice, window.currentModelSupportsTools));
      }
      lastRenderedLen = boundary;
    }

    // Update or create the streaming span for pending (in-progress) text
    // Render with markdown so bold, lists, etc. display correctly while streaming
    if (pendingText) {
      if (!streamingSpan || !streamingSpan.parentNode) {
        streamingSpan = document.createElement('div');
        streamingSpan.className = 'streaming-text';
      }
      streamingSpan.innerHTML = '';
      appendBlockMarkdown(streamingSpan, pendingText);
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
    // Preload mermaid.js as soon as we see a mermaid code fence opening,
    // so the 5MB script is parsed before the block finishes streaming.
    if (!mermaidReady && currentAssistantText.includes('```mermaid')) {
      loadMermaid();
    }
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
      // Store raw content for copy button (used by rehydration + clipboard)
      currentAssistantDiv.dataset.rawContent = currentAssistantText;

      // Incremental finish: only render the slice that streaming left unrendered,
      // preserving the DOM nodes built by earlier renderStreamingChunk calls.
      // Avoids an O(N) re-parse on every message finish.
      try {
        const finalSlice = currentAssistantText.slice(Math.max(0, lastRenderedLen));
        if (finalSlice) {
          currentAssistantDiv.appendChild(renderContent(finalSlice, window.currentModelSupportsTools));
        }
      } catch (err) {
        console.error('SideCar: finishAssistantMessage render failed:', err);
        // Fallback: at least surface the raw text rather than losing it.
        const fallback = document.createElement('p');
        fallback.textContent = currentAssistantText.slice(Math.max(0, lastRenderedLen));
        currentAssistantDiv.appendChild(fallback);
      }

      // Post-processing pass: fix any un-rendered markdown in text nodes
      postProcessMarkdown(currentAssistantDiv);

      // Attach message action buttons (idempotent — removes existing first)
      addMessageActions(currentAssistantDiv);

      // Hand the finished message off to the virtualizer so it can detach
      // it once the user scrolls far enough to leave it offscreen.
      virtualizer.observe(currentAssistantDiv);
    }
    currentAssistantDiv = null;
    currentAssistantText = '';
    lastRenderedLen = 0;
  }

  /**
   * Post-processing pass: walk the DOM and fix text nodes that still contain
   * raw markdown syntax (**, `, ~~) that the primary renderer failed to convert.
   * Uses simple string splitting (no regex) as an independent fallback.
   */
  function postProcessMarkdown(root) {
    // Collect all text nodes (skip code blocks and pre elements)
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentNode;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'CODE' || tag === 'PRE' || tag === 'STRONG' || tag === 'EM' || tag === 'DEL')
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);

    for (const textNode of textNodes) {
      const text = textNode.textContent;
      if (!text) continue;

      // Check for un-rendered bold (**text**)
      if (text.indexOf('**') === -1) continue;

      const parts = text.split('**');
      // Need at least 3 parts (text before, bold content, text after) for a valid bold pair
      if (parts.length < 3) continue;

      const fragment = document.createDocumentFragment();
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) {
          // Even indices: plain text
          if (parts[i]) {
            // Process inline code within plain text
            processInlineCode(fragment, parts[i]);
          }
        } else {
          // Odd indices: bold text
          const strong = document.createElement('strong');
          strong.textContent = parts[i];
          fragment.appendChild(strong);
        }
      }
      textNode.parentNode.replaceChild(fragment, textNode);
    }
  }

  /** Helper: process backtick-delimited inline code within a text segment */
  function processInlineCode(parent, text) {
    if (text.indexOf('`') === -1) {
      parent.appendChild(document.createTextNode(text));
      return;
    }
    const parts = text.split('`');
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        if (parts[i]) parent.appendChild(document.createTextNode(parts[i]));
      } else {
        const code = document.createElement('code');
        code.textContent = parts[i];
        parent.appendChild(code);
      }
    }
  }

  function showTypingIndicator() {
    // Remove any existing typing indicator to prevent duplicates
    removeTypingIndicator();
    const div = document.createElement('div');
    div.className = 'message assistant typing-indicator';
    div.id = 'typing';
    const dots = document.createElement('div');
    dots.className = 'typing-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';
    div.appendChild(dots);
    const statusRow = document.createElement('div');
    statusRow.className = 'typing-status-row';
    const status = document.createElement('span');
    status.className = 'typing-status';
    status.id = 'typing-status';
    status.textContent = 'Connecting to model...';
    statusRow.appendChild(status);
    const timer = document.createElement('span');
    timer.className = 'typing-timer';
    timer.id = 'typing-timer';
    timer.textContent = '0s';
    statusRow.appendChild(timer);
    div.appendChild(statusRow);
    messagesContainer.appendChild(div);
    scrollToBottom();
    typingTimerStart = Date.now();
    typingTimerInterval = setInterval(() => {
      const el = document.getElementById('typing-timer');
      if (!el) {
        clearInterval(typingTimerInterval);
        typingTimerInterval = null;
        return;
      }
      const secs = Math.floor((Date.now() - typingTimerStart) / 1000);
      const mins = Math.floor(secs / 60);
      const rem = secs % 60;
      el.textContent = mins > 0 ? mins + 'm ' + rem + 's' : secs + 's';
    }, 1000);
  }

  function updateTypingStatus(text) {
    const status = document.getElementById('typing-status');
    if (status) status.textContent = text;
  }

  function renderBgAgentPanel() {
    const panel = document.getElementById('bg-agents-panel');
    const list = document.getElementById('bg-agents-list');
    const countBadge = document.getElementById('bg-agents-count');
    if (!panel || !list) return;

    const active = bgAgentRuns.filter((r) => r.status === 'running' || r.status === 'queued');
    const recent = bgAgentRuns.filter((r) => r.status !== 'running' && r.status !== 'queued');

    if (bgAgentRuns.length === 0) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    if (countBadge) countBadge.textContent = active.length > 0 ? String(active.length) : '';

    list.innerHTML = '';
    for (const run of [...active, ...recent.slice(-5)]) {
      const item = document.createElement('div');
      item.className = 'bg-agent-item';

      const info = document.createElement('div');
      info.className = 'bg-agent-info';

      const taskSpan = document.createElement('span');
      taskSpan.className = 'bg-agent-task';
      taskSpan.textContent = run.task.length > 60 ? run.task.slice(0, 60) + '…' : run.task;
      taskSpan.title = run.task;
      info.appendChild(taskSpan);

      const statusSpan = document.createElement('span');
      statusSpan.className = 'bg-agent-status bg-status-' + run.status;
      const elapsed = ((run.completedAt || Date.now()) - run.startedAt) / 1000;
      statusSpan.textContent =
        run.status === 'running'
          ? 'Running ' + Math.round(elapsed) + 's'
          : run.status === 'queued'
            ? 'Queued'
            : run.status + (run.toolCalls ? ' (' + run.toolCalls + ' tools)' : '');
      info.appendChild(statusSpan);
      item.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'bg-agent-actions';

      if (run.status === 'running' || run.status === 'queued') {
        const stopBtn = document.createElement('button');
        stopBtn.className = 'bg-agent-stop';
        stopBtn.title = 'Stop';
        stopBtn.textContent = '\u25A0';
        stopBtn.addEventListener('click', () => vscode.postMessage({ command: 'bgStop', text: run.id }));
        actions.appendChild(stopBtn);
      }

      const expandBtn = document.createElement('button');
      expandBtn.className = 'bg-agent-expand';
      expandBtn.title = 'Toggle output';
      expandBtn.textContent = '\u25BC';
      expandBtn.addEventListener('click', () => {
        const outputEl = item.querySelector('.bg-agent-output');
        if (outputEl) outputEl.classList.toggle('hidden');
      });
      actions.appendChild(expandBtn);
      item.appendChild(actions);

      const outputDiv = document.createElement('pre');
      outputDiv.className = 'bg-agent-output hidden';
      outputDiv.dataset.runId = run.id;
      outputDiv.textContent = run.output || '(no output yet)';
      item.appendChild(outputDiv);

      list.appendChild(item);
    }
  }

  function removeTypingIndicator() {
    if (typingTimerInterval) {
      clearInterval(typingTimerInterval);
      typingTimerInterval = null;
    }
    const typing = document.getElementById('typing');
    if (typing) typing.remove();
  }

  function updateSendButton() {
    const hasText = input.value.trim().length > 0;
    if (isLoading && !hasText) {
      sendBtn.textContent = 'Stop';
      sendBtn.classList.add('loading');
    } else {
      sendBtn.textContent = 'Send';
      sendBtn.classList.remove('loading');
    }
  }

  function setLoading(loading) {
    isLoading = loading;
    sendBtn.disabled = false;
    updateSendButton();
    const activityBar = document.getElementById('activity-bar');
    if (activityBar) activityBar.classList.toggle('hidden', !loading);
  }

  let userScrolledUp = false;
  let scrollBtnRef = null; // cached reference to avoid getElementById per event

  let scrollRafPending = false;
  messagesContainer.addEventListener('scroll', () => {
    // Debounce via requestAnimationFrame to avoid layout thrashing
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(() => {
      scrollRafPending = false;
      const gap = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
      userScrolledUp = gap > 40;
      if (!scrollBtnRef) scrollBtnRef = document.getElementById('scroll-to-bottom');
      if (scrollBtnRef) scrollBtnRef.classList.toggle('hidden', !userScrolledUp);
    });
  });

  // Delegated event handler for code block buttons — avoids per-button
  // listeners that capture code/lang in closures and leak memory.
  messagesContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'run') {
      vscode.postMessage({ command: 'runCommand', text: btn.dataset.code });
      btn.textContent = 'Running...';
      btn.disabled = true;
    } else if (action === 'save') {
      vscode.postMessage({ command: 'saveCodeBlock', code: btn.dataset.code, language: btn.dataset.lang });
    }
  });

  let scrollPending = false;
  function scrollToBottom() {
    if (userScrolledUp || scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      scrollPending = false;
    });
  }

  function forceScrollToBottom() {
    userScrolledUp = false;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    const scrollBtn = document.getElementById('scroll-to-bottom');
    if (scrollBtn) scrollBtn.classList.add('hidden');
  }

  function getModelDisplayName(name) {
    if (name.includes('/')) {
      const last = name.split('/').pop();
      return last || name;
    }
    return name;
  }

  function renderModelList(models, filter) {
    // Cache full list when called without a filter (fresh data from extension)
    if (filter === undefined) {
      cachedModels = models;
      if (modelSearchInput) modelSearchInput.value = '';
    }

    modelList.innerHTML = '';

    // Apply search filter
    let filtered = models;
    if (filter) {
      const q = filter.toLowerCase();
      filtered = models.filter((m) => m.name.toLowerCase().includes(q));
    }

    // Organize models by tool support
    const toolModels = filtered.filter((m) => m.supportsTools !== false);
    const chatOnlyModels = filtered.filter((m) => m.supportsTools === false);

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
        nameSpan.title = model.name;

        const nameText = document.createElement('span');
        nameText.className = 'name-text';
        nameText.textContent = getModelDisplayName(model.name);
        nameSpan.appendChild(nameText);

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
          actionBtn.dataset.installed = 'true';
        } else if (installingModel === model.name) {
          actionBtn.textContent = 'Installing...';
          actionBtn.className = 'model-action installing';
          actionBtn.disabled = true;
          actionBtn.dataset.installed = 'false';
        } else {
          actionBtn.textContent = 'Install';
          actionBtn.className = 'model-action install';
          actionBtn.dataset.installed = 'false';
        }
        actionBtn.dataset.model = model.name;

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
        nameSpan.title = model.name;

        const nameText = document.createElement('span');
        nameText.className = 'name-text';
        nameText.textContent = getModelDisplayName(model.name);
        nameSpan.appendChild(nameText);

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
          actionBtn.dataset.installed = 'true';
        } else if (installingModel === model.name) {
          actionBtn.textContent = 'Installing...';
          actionBtn.className = 'model-action installing';
          actionBtn.disabled = true;
          actionBtn.dataset.installed = 'false';
        } else {
          actionBtn.textContent = 'Install';
          actionBtn.className = 'model-action install';
          actionBtn.dataset.installed = 'false';
        }
        actionBtn.dataset.model = model.name;

        item.appendChild(nameSpan);
        item.appendChild(actionBtn);
        modelList.appendChild(item);
      }
    }
  }

  // Event delegation for model action buttons — avoids closure capture of model object
  modelList.addEventListener('click', (e) => {
    const btn = e.target.closest('.model-action');
    if (!btn) return;

    const modelName = btn.dataset.model;
    const isInstalled = btn.dataset.installed === 'true';

    if (isInstalled) {
      vscode.postMessage({ command: 'changeModel', model: modelName });
      modelPanel.classList.add('hidden');
    } else if (installingModel !== modelName) {
      vscode.postMessage({ command: 'installModel', model: modelName });
    }
  });

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

      case 'uiSettings':
        applyUiSettings(event.data);
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

      case 'typingStatus':
        updateTypingStatus(content || '');
        break;

      case 'skillsMenu': {
        if (msg.skills) {
          // Update autocomplete list with skill commands
          loadedSkillCommands = msg.skills
            .filter((s) => !slashCommands.some((c) => c.cmd === '/' + s.id))
            .map((s) => ({ cmd: '/' + s.id, desc: s.description || s.name }));
          // Notify the attach menu callback if waiting
          if (pendingSkillsCallback) {
            pendingSkillsCallback(msg.skills);
            pendingSkillsCallback = null;
          }
        }
        break;
      }

      case 'onboarding': {
        const card = document.createElement('div');
        card.className = 'onboarding-card';

        const title = document.createElement('div');
        title.className = 'onboarding-title';
        title.textContent = 'Welcome to SideCar';
        card.appendChild(title);

        const subtitle = document.createElement('div');
        subtitle.className = 'onboarding-subtitle';
        subtitle.textContent = 'Your free, local-first AI coding assistant';
        card.appendChild(subtitle);

        const features = [
          ['Type a question or instruction to get started', '💬'],
          ['Use @file:path to include specific files as context', '📎'],
          ['Use @pin:path to pin files for persistent context', '📌'],
          ['Type / to see all slash commands', '⌨️'],
          ['Switch between cautious / autonomous modes in the header', '🔧'],
          ['Paste a URL to include web page content automatically', '🌐'],
        ];
        const list = document.createElement('ul');
        list.className = 'onboarding-features';
        for (const [text, icon] of features) {
          const li = document.createElement('li');
          const iconSpan = document.createElement('span');
          iconSpan.className = 'onboarding-icon';
          iconSpan.textContent = icon;
          li.appendChild(iconSpan);
          li.appendChild(document.createTextNode(text));
          list.appendChild(li);
        }
        card.appendChild(list);

        const btn = document.createElement('button');
        btn.className = 'onboarding-dismiss';
        btn.textContent = 'Got it';
        btn.addEventListener('click', () => {
          card.remove();
          vscode.postMessage({ command: 'dismissOnboarding' });
        });
        card.appendChild(btn);

        messagesContainer.appendChild(card);
        scrollToBottom();
        break;
      }

      case 'assistantMessage':
        updateTypingStatus('Generating response...');
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
          updateTypingStatus(`Agent step ${msg.iteration}/${msg.maxIterations}...`);
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
        // Clean up any orphaned spinners from tool calls that never got a result
        const orphanedTools = messagesContainer.querySelectorAll('.tool-call.running');
        for (const tool of orphanedTools) {
          tool.classList.remove('running');
          const orphanSpinner = tool.querySelector('.tool-spinner');
          if (orphanSpinner) orphanSpinner.remove();
          // Add a neutral badge (no result received)
          const orphanSummary = tool.querySelector('summary');
          if (orphanSummary && !orphanSummary.querySelector('.tool-result-badge')) {
            const badge = document.createElement('span');
            badge.className = 'tool-result-badge success';
            badge.textContent = '\u2713';
            orphanSummary.appendChild(badge);
          }
        }

        // Append plan action buttons to the last assistant message
        if (pendingPlanReady) {
          pendingPlanReady = false;
          const assistantMsgs = messagesContainer.querySelectorAll('.message.assistant');
          const lastMsg = assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1] : null;
          if (lastMsg) {
            lastMsg.classList.add('plan-message');
            const btnRow = document.createElement('div');
            btnRow.className = 'plan-actions';
            const execBtn = document.createElement('button');
            execBtn.textContent = 'Execute Plan';
            execBtn.className = 'plan-btn plan-execute';
            execBtn.addEventListener('click', () => {
              vscode.postMessage({ command: 'executePlan' });
              execBtn.disabled = true;
              reviseBtn.disabled = true;
              rejectBtn.disabled = true;
              execBtn.textContent = 'Executing...';
            });
            const reviseBtn = document.createElement('button');
            reviseBtn.textContent = 'Revise';
            reviseBtn.className = 'plan-btn plan-revise';
            reviseBtn.addEventListener('click', () => {
              input.value = '/revise ';
              input.focus();
              input.style.height = 'auto';
              input.style.height = input.scrollHeight + 'px';
            });
            const rejectBtn = document.createElement('button');
            rejectBtn.textContent = 'Reject';
            rejectBtn.className = 'plan-btn plan-reject';
            rejectBtn.addEventListener('click', () => {
              lastMsg.style.opacity = '0.5';
              execBtn.disabled = true;
              reviseBtn.disabled = true;
              rejectBtn.disabled = true;
              appendMessage('assistant', 'Plan rejected.');
            });
            btnRow.appendChild(execBtn);
            btnRow.appendChild(reviseBtn);
            btnRow.appendChild(rejectBtn);
            lastMsg.appendChild(btnRow);
            scrollToBottom();
          }
        }
        break;
      }

      case 'suggestNextSteps': {
        const suggestions = message.suggestions || [];
        if (suggestions.length > 0) {
          const container = document.createElement('div');
          container.className = 'next-steps';
          const label = document.createElement('span');
          label.className = 'next-steps-label';
          label.textContent = 'Next steps:';
          container.appendChild(label);
          for (const text of suggestions) {
            const btn = document.createElement('button');
            btn.className = 'next-step-btn';
            btn.textContent = text;
            btn.addEventListener('click', () => {
              vscode.postMessage({ type: 'userMessage', content: text });
            });
            container.appendChild(btn);
          }
          chatMessages.appendChild(container);
          scrollToBottom();
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
          // Render diff lines with color classes — build in fragment to avoid per-line reflow
          const diffLines = item.diff.split('\n');
          const diffFragment = document.createDocumentFragment();
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
            diffFragment.appendChild(span);
            diffFragment.appendChild(document.createTextNode('\n'));
          }
          diffPre.appendChild(diffFragment);
          fileSection.appendChild(diffPre);
          panel.appendChild(fileSection);
        }

        messagesContainer.appendChild(panel);
        scrollToBottom();
        break;
      }

      case 'chatCleared':
        virtualizer.reset();
        messagesContainer.innerHTML = '';
        currentAssistantDiv = null;
        currentAssistantText = '';
        messageCounter = 0;
        break;

      case 'addUserMessage':
        appendMessage('user', content || '');
        break;

      case 'thinking': {
        updateTypingStatus('Reasoning...');
        let thinkingEl = document.getElementById('current-thinking');
        if (!thinkingEl) {
          const details = document.createElement('details');
          details.className = 'thinking-block';
          details.id = 'current-thinking';
          details.dataset.stepStart = String(Date.now());
          // Feature 6: Expand thinking by default if setting is enabled
          if (window.expandThinking) {
            details.open = true;
          }
          const summary = document.createElement('summary');
          const icon = document.createElement('span');
          icon.className = 'step-icon';
          icon.textContent = '\u{1F9E0}'; // brain
          summary.appendChild(icon);
          const label = document.createElement('span');
          label.className = 'step-label';
          label.textContent = 'Reasoning...';
          summary.appendChild(label);
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

      case 'bgStatusUpdate':
      case 'bgComplete': {
        const bgRun = event.data.bgRun;
        if (bgRun) {
          const idx = bgAgentRuns.findIndex((r) => r.id === bgRun.id);
          if (idx >= 0) bgAgentRuns[idx] = bgRun;
          else bgAgentRuns.push(bgRun);
          renderBgAgentPanel();
        }
        break;
      }

      case 'bgOutput': {
        const bgRunId = event.data.bgRunId;
        const bgChunk = content || '';
        const bgEntry = bgAgentRuns.find((r) => r.id === bgRunId);
        if (bgEntry) {
          bgEntry.output = (bgEntry.output || '') + bgChunk;
          const outputEl = document.querySelector(`.bg-agent-output[data-run-id="${bgRunId}"]`);
          if (outputEl) outputEl.textContent = bgEntry.output;
        }
        break;
      }

      case 'bgList': {
        bgAgentRuns = event.data.bgRuns || [];
        renderBgAgentPanel();
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

      case 'clarify': {
        finishAssistantMessage();
        const clarifyId = event.data.clarifyId;
        const options = event.data.clarifyOptions || [];
        const allowCustom = event.data.clarifyAllowCustom !== false;

        const card = document.createElement('div');
        card.className = 'clarify-card';
        card.dataset.clarifyId = clarifyId;

        const question = document.createElement('div');
        question.className = 'clarify-question';
        question.textContent = content || 'I need more information:';
        card.appendChild(question);

        function sendResponse(value) {
          vscode.postMessage({ command: 'clarifyResponse', confirmId: clarifyId, text: value });
          card.remove();
        }

        // Option buttons
        if (options.length > 0) {
          const optionsContainer = document.createElement('div');
          optionsContainer.className = 'clarify-options';
          for (const opt of options) {
            const btn = document.createElement('button');
            btn.className = 'clarify-option-btn';
            btn.textContent = opt;
            btn.addEventListener('click', () => sendResponse(opt));
            optionsContainer.appendChild(btn);
          }
          card.appendChild(optionsContainer);
        }

        // Custom text input
        if (allowCustom) {
          const customRow = document.createElement('div');
          customRow.className = 'clarify-custom';
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'clarify-input';
          input.placeholder = 'Or type your own response...';
          const submitBtn = document.createElement('button');
          submitBtn.className = 'clarify-submit-btn';
          submitBtn.textContent = 'Send';
          submitBtn.addEventListener('click', () => {
            const val = input.value.trim();
            if (val) sendResponse(val);
          });
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              const val = input.value.trim();
              if (val) sendResponse(val);
            }
          });
          customRow.appendChild(input);
          customRow.appendChild(submitBtn);
          card.appendChild(customRow);
        }

        messagesContainer.appendChild(card);
        scrollToBottom();
        break;
      }

      case 'toolCall': {
        // Finish the current assistant message so the next text stream
        // creates a new response block after the tool call/result.
        finishAssistantMessage();
        // Close out any in-progress reasoning block as a completed step so
        // the next `thinking` event starts a fresh segment in the timeline.
        finalizeCurrentThinking();

        const toolName = event.data.toolName || (content || '').split('(')[0];
        const toolCallId = event.data.toolCallId || '';
        const displayName = formatToolName(toolName);
        updateTypingStatus('Running tool: ' + displayName + '...');
        const toolDetail = formatToolDetail(toolName, content || '');

        const details = document.createElement('details');
        details.className = 'tool-call running';
        details.dataset.stepStart = String(Date.now());
        if (toolCallId) details.setAttribute('data-tool-id', toolCallId);
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
        // Stream output into the matching tool call body (by ID or last running)
        const toolIdForOutput = event.data.toolCallId;
        let activeToolForOutput = null;
        if (toolIdForOutput) {
          activeToolForOutput = document.querySelector('.tool-call[data-tool-id="' + toolIdForOutput + '"]');
        }
        if (!activeToolForOutput) {
          const runningForOutput = messagesContainer.querySelectorAll('.tool-call.running');
          activeToolForOutput = runningForOutput.length > 0 ? runningForOutput[runningForOutput.length - 1] : null;
        }
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
        updateTypingStatus('Processing tool result...');
        const resultToolId = event.data.toolCallId;
        const resultToolName = event.data.toolName || '';
        const text = content || '';
        const isError = text.startsWith('\u2717') || text.includes('Error');

        // Find the matching tool call element by ID, or fall back to last .running
        // Note: :last-of-type matches by element type (details), not class, so we
        // use querySelectorAll + pick the last one for the fallback.
        let matchedTool = null;
        if (resultToolId) {
          matchedTool = document.querySelector('.tool-call[data-tool-id="' + resultToolId + '"]');
        }
        if (!matchedTool) {
          const running = messagesContainer.querySelectorAll('.tool-call.running');
          matchedTool = running.length > 0 ? running[running.length - 1] : null;
        }

        if (matchedTool) {
          matchedTool.classList.remove('running');
          const spinner = matchedTool.querySelector('.tool-spinner');
          if (spinner) spinner.remove();
          stampStepDuration(matchedTool);

          // Add success/error badge
          const resultBadge = document.createElement('span');
          resultBadge.className = 'tool-result-badge ' + (isError ? 'error' : 'success');
          resultBadge.textContent = isError ? '\u2717' : '\u2713';
          const matchedSummary = matchedTool.querySelector('summary');
          if (matchedSummary) {
            matchedSummary.appendChild(resultBadge);
            // Add "Why?" button for model decision explanation
            const whyBtn = document.createElement('button');
            whyBtn.className = 'tool-why-btn';
            whyBtn.textContent = 'Why?';
            whyBtn.title = 'Explain why this tool was chosen';
            const whyToolId = resultToolId || matchedTool.getAttribute('data-tool-id') || '';
            whyBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              e.preventDefault();
              whyBtn.disabled = true;
              whyBtn.textContent = '...';
              vscode.postMessage({ command: 'explainToolDecision', toolCallId: whyToolId });
            });
            matchedSummary.appendChild(whyBtn);
          }

          // Append result output to the tool call body
          if (text) {
            const matchedBody = matchedTool.querySelector('.tool-call-body');
            if (matchedBody) {
              matchedBody.textContent += '\n' + text;
            }
          }

          if (isError) {
            matchedTool.classList.add('error');
          }
        } else {
          // No matching tool call found — show a standalone result block
          const details = document.createElement('details');
          details.className = 'tool-result' + (isError ? ' error' : '');
          const summary = document.createElement('summary');
          const displayName = resultToolName ? formatToolName(resultToolName) : 'Tool';
          const iconSpan = document.createElement('span');
          iconSpan.className = 'tool-icon';
          iconSpan.textContent = resultToolName ? getToolIcon(resultToolName) : '\u2699';
          summary.appendChild(iconSpan);
          const nameSpan = document.createElement('span');
          nameSpan.className = 'tool-name';
          nameSpan.textContent = displayName;
          summary.appendChild(nameSpan);
          const badge = document.createElement('span');
          badge.className = 'tool-result-badge ' + (isError ? 'error' : 'success');
          badge.textContent = isError ? '\u2717' : '\u2713';
          summary.appendChild(badge);
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
        const customModes = event.data.customModes || [];
        if (select) {
          // Rebuild options: keep built-in modes, add/update custom modes
          const builtIns = ['cautious', 'autonomous', 'manual', 'plan'];
          // Remove old custom options
          for (const opt of [...select.options]) {
            if (!builtIns.includes(opt.value)) opt.remove();
          }
          // Add custom modes
          for (const cm of customModes) {
            const opt = document.createElement('option');
            opt.value = cm.name;
            opt.textContent = cm.name + (cm.description ? ' — ' + cm.description : '');
            select.appendChild(opt);
          }
          select.value = mode;
          const isBuiltIn = builtIns.includes(mode);
          select.className = 'agent-mode-select mode-' + (isBuiltIn ? mode : 'custom');
        }
        break;
      }

      case 'planReady': {
        // Just flag it — the action buttons will be appended to the
        // assistant message once streaming finishes in the 'done' handler.
        pendingPlanReady = true;
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
        if (renderTimer) {
          clearTimeout(renderTimer);
          renderTimer = null;
        }
        if (streamingSpan && streamingSpan.parentNode) {
          streamingSpan.remove();
        }
        streamingSpan = null;
        lastRenderedLen = 0;
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
            } else if (msg.errorActionCommand === 'reconnect') {
              actionBtn.textContent = 'Reconnecting...';
              actionBtn.disabled = true;
              vscode.postMessage({ command: 'reconnect' });
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
