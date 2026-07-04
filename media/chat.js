// SideCar chat webview script.
// Plain browser JS (IIFE) — not checked by the repo tsconfig (which only
// includes src/**/*) and not linted by eslint.config.mjs (scoped to
// src/**/*.ts). No @ts-nocheck needed. Helper modules live under
// media/chat/ and attach to the window.SideCar namespace before this file
// runs — see chatWebview.getChatWebviewHtml for the script load order.

(function () {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const vscode = acquireVsCodeApi();
  const messagesContainer = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const attachBtn = document.getElementById('attach-btn');
  const micBtn = document.getElementById('mic-btn');
  const modelBtn = document.getElementById('model-btn');
  const modelName = document.getElementById('model-name');
  const modelPanel = document.getElementById('model-panel');
  const modelList = document.getElementById('model-list');
  const closePanel = document.getElementById('close-panel');
  const refreshModelsBtn = document.getElementById('refresh-models-btn');
  const ollamaActions = document.getElementById('ollama-actions');
  const restartOllamaBtn = document.getElementById('restart-ollama-btn');
  const installProgress = document.getElementById('install-progress');
  const progressStop = document.getElementById('progress-stop');
  const MAX_TOOL_OUTPUT_CHARS = 8000;
  // Per-tool-id char counts for truncation tracking (cleared when agent finishes)
  const toolOutputChars = new Map();
  // Full (untruncated) plain-text content per tool key — populated alongside
  // toolOutputChars so "Show all" can expand in-place without a round-trip.
  const toolFullOutput = new Map();
  const installText = document.getElementById('install-text');
  const installBar = document.getElementById('install-bar');
  const cancelInstall = document.getElementById('cancel-install');
  const activeFileBar = document.getElementById('active-file-bar');
  const activeFileNameEl = document.getElementById('active-file-name');
  const activeFileToggle = document.getElementById('active-file-toggle');
  const fileAttachment = document.getElementById('file-attachment');
  const fileAttachmentName = document.getElementById('file-attachment-name');
  const removeAttachment = document.getElementById('remove-attachment');
  const modelSearchInput = document.getElementById('model-search-input');
  const customModelInput = document.getElementById('custom-model-input');
  const customModelUse = document.getElementById('custom-model-use');
  const steerStrip = document.getElementById('steer-queue-strip');
  const resumeStrip = document.getElementById('resume-strip');
  const autoModeStrip = document.getElementById('auto-mode-strip');

  // Steer-queue state (v0.65). `steerEnabled` tracks whether a run is
  // live (strip shows pending items). Items are rendered directly from
  // the authoritative server snapshot — no client-side state synthesis.
  let steerEnabled = false;
  let steerItems = [];
  let editingSteerId = null;

  // Auto Mode strip state (v0.73.1). Tracks current session progress.
  let autoModeHistory = []; // {text, status, errorMessage?}[]
  let autoModeCurrent = null; // {taskN, total, text} | null
  let autoModeDismissTimer = null;

  // Resume-available state (v0.65 chunk 7b). Set when the stream fails
  // mid-turn; cleared when a `done` arrives after a successful resume.
  // Separate from the inline scroll-away Resume button — this one lives
  // above the input and stays visible while the user reads earlier context.
  let resumePendingSteerCount = 0;

  let isLoading = false;
  let currentAssistantDiv = null;
  let currentAssistantText = '';
  let installingModel = null;
  let cachedModels = [];
  let bgAgentRuns = [];
  let batchProgressState = null; // { kind, task, items, doneCount, totalCount } | null
  // Active file bar — tracks the currently focused editor file so the bar
  // can show an include/exclude toggle without the user opening the attach menu.
  let currentActiveFile = null; // { fileName, filePath } | null

  // Attached files live as an array so drag-drop can accumulate several
  // at once. handleAttachFile (single file button flow) and
  // handleDroppedPaths (drag-drop bulk flow) both append into this list.
  let pendingFiles = [];
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

    if (micBtn) {
      if (opts.voiceEnabled) {
        micBtn.classList.remove('hidden');
      } else {
        micBtn.classList.add('hidden');
      }
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
      const nonce = document.body.dataset.nonce;
      if (nonce) script.setAttribute('nonce', nonce);
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

  refreshModelsBtn.addEventListener('click', () => {
    refreshModelsBtn.disabled = true;
    vscode.postMessage({ command: 'refreshModels' });
    setTimeout(() => {
      refreshModelsBtn.disabled = false;
    }, 2000);
  });

  restartOllamaBtn.addEventListener('click', () => {
    restartOllamaBtn.disabled = true;
    restartOllamaBtn.textContent = 'Restarting...';
    modelPanel.classList.add('hidden');
    vscode.postMessage({ command: 'restartOllama' });
    setTimeout(() => {
      restartOllamaBtn.disabled = false;
      restartOllamaBtn.textContent = 'Restart Ollama';
    }, 5000);
  });

  modelSearchInput.addEventListener('input', () => {
    renderModelList(cachedModels, modelSearchInput.value.trim());
  });

  cancelInstall.addEventListener('click', () => {
    vscode.postMessage({ command: 'cancelInstall' });
  });

  if (progressStop) {
    progressStop.addEventListener('click', () => {
      vscode.postMessage({ command: 'abort' });
    });
  }

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
          // Build nodes with createElement + textContent so skill
          // frontmatter (user-authored, potentially hostile in cloned
          // repos) can't inject markup or DOM-clobber event handlers.
          // CSP blocks inline <script> but not DOM-level attribute
          // injection via innerHTML.
          const strong = document.createElement('strong');
          strong.textContent = '/' + skill.id;
          item.appendChild(strong);
          if (skill.description) {
            const desc = document.createElement('span');
            desc.className = 'attach-menu-desc';
            desc.textContent = skill.description;
            item.appendChild(desc);
          }
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

  // ---------------------------------------------------------------------------
  // Voice input — record directly in the webview via MediaRecorder, then send
  // the audio to the extension host for local Whisper transcription.
  // Falls back to the external browser recording server if getUserMedia is
  // blocked (e.g. VS Code Web or a stripped-down webview environment).
  if (micBtn) {
    let mediaRecorder = null;
    let audioChunks = [];
    let isRecording = false;

    function resetMicBtn() {
      micBtn.textContent = '🎤';
      micBtn.disabled = false;
      micBtn.title = 'Voice input';
      micBtn.classList.remove('mic-recording');
      isRecording = false;
      mediaRecorder = null;
      audioChunks = [];
    }

    async function startRecording() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';
        mediaRecorder = new MediaRecorder(stream, { mimeType });
        audioChunks = [];
        mediaRecorder.addEventListener('dataavailable', (e) => {
          if (e.data && e.data.size > 0) audioChunks.push(e.data);
        });
        mediaRecorder.addEventListener('stop', () => {
          stream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(audioChunks, { type: mimeType.split(';')[0] });
          // Decode to Float32 PCM at 16 kHz in the browser so the extension
          // host can pass it directly to the Whisper ONNX pipeline.
          const reader = new FileReader();
          reader.onloadend = async () => {
            micBtn.textContent = '⏳';
            micBtn.disabled = true;
            try {
              const arrayBuffer = await blob.arrayBuffer();
              const audioCtx = new AudioContext({ sampleRate: 16000 });
              const decoded = await audioCtx.decodeAudioData(arrayBuffer);
              const pcm = decoded.getChannelData(0); // Float32Array, mono, 16 kHz
              vscode.postMessage({
                command: 'voiceAudio',
                pcmBase64: btoa(String.fromCharCode(...new Uint8Array(pcm.buffer))),
                mimeType: 'audio/pcm-f32le',
              });
            } catch (err) {
              resetMicBtn();
              vscode.postMessage({
                command: 'voiceAudio',
                pcmBase64: '',
                mimeType: 'audio/webm',
                voiceError: err.message,
              });
            }
          };
          reader.readAsArrayBuffer(blob);
        });
        mediaRecorder.start();
        micBtn.textContent = '⏹';
        micBtn.classList.add('mic-recording');
        micBtn.title = 'Click to stop recording';
        isRecording = true;
      } catch (err) {
        if (err.name === 'NotAllowedError' || err.name === 'NotFoundError') {
          // getUserMedia blocked — fall back to external browser recording server.
          micBtn.textContent = '⏳';
          micBtn.disabled = true;
          micBtn.title = 'Waiting for browser recording…';
          vscode.postMessage({ command: 'startVoice' });
        } else {
          resetMicBtn();
        }
      }
    }

    function stopRecording() {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        micBtn.classList.remove('mic-recording');
        micBtn.textContent = '⏳';
        micBtn.disabled = true;
        isRecording = false;
      }
    }

    micBtn.addEventListener('click', () => {
      if (micBtn.disabled) return;
      if (isRecording) {
        stopRecording();
      } else {
        void startRecording();
      }
    });
  }

  // The original single-file "×" button removes whichever file the user
  // has clicked within the chip list; legacy selector is kept so the CSS
  // still applies to the hit target, but per-chip close buttons are the
  // primary interaction.
  removeAttachment.addEventListener('click', () => {
    pendingFiles = [];
    renderPendingFiles();
  });

  function renderPendingFiles() {
    if (!pendingFiles || pendingFiles.length === 0) {
      fileAttachment.classList.add('hidden');
      fileAttachmentName.textContent = '';
      fileAttachment.querySelectorAll('.attachment-chip').forEach((el) => el.remove());
      renderActiveFileBar();
      return;
    }
    fileAttachment.classList.remove('hidden');
    fileAttachment.querySelectorAll('.attachment-chip').forEach((el) => el.remove());
    fileAttachmentName.textContent =
      pendingFiles.length === 1
        ? 'Attached: ' + pendingFiles[0].fileName
        : 'Attached ' + pendingFiles.length + ' files';
    for (let i = 0; i < pendingFiles.length; i++) {
      const chip = document.createElement('span');
      chip.className = 'attachment-chip';
      const label = document.createElement('span');
      label.className = 'attachment-chip-name';
      label.textContent = pendingFiles[i].fileName;
      label.title = pendingFiles[i].fileName;
      const close = document.createElement('button');
      close.className = 'attachment-chip-remove';
      close.type = 'button';
      close.textContent = '\u00D7';
      close.setAttribute('aria-label', 'Remove attachment');
      const idx = i;
      close.addEventListener('click', () => {
        pendingFiles.splice(idx, 1);
        renderPendingFiles();
      });
      chip.appendChild(label);
      chip.appendChild(close);
      fileAttachment.appendChild(chip);
    }
    renderActiveFileBar();
  }

  function renderActiveFileBar() {
    if (!activeFileBar || !activeFileNameEl || !activeFileToggle) return;
    if (!currentActiveFile) {
      activeFileBar.classList.add('hidden');
      return;
    }
    activeFileBar.classList.remove('hidden');
    activeFileNameEl.textContent = currentActiveFile.fileName;
    activeFileNameEl.title = currentActiveFile.filePath;

    const isAttached = pendingFiles.some((f) => f.fileName === currentActiveFile.fileName);
    if (isAttached) {
      activeFileToggle.textContent = '\u2713 Included';
      activeFileToggle.title = 'Remove from context';
      activeFileToggle.className = 'active-file-toggle active-file-toggle--included';
      activeFileToggle.onclick = () => {
        const idx = pendingFiles.findIndex((f) => f.fileName === currentActiveFile.fileName);
        if (idx !== -1) {
          pendingFiles.splice(idx, 1);
          renderPendingFiles();
        }
      };
    } else {
      activeFileToggle.textContent = '+ Add';
      activeFileToggle.title = 'Include this file in the message';
      activeFileToggle.className = 'active-file-toggle';
      activeFileToggle.onclick = () => {
        vscode.postMessage({ command: 'attachActiveFile' });
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Drag-and-drop for files and folders.
  //
  // VS Code explorer drags surface as `text/uri-list` (newline-separated
  // file:// URIs). OS drags populate `dataTransfer.files` with File
  // objects that expose a `path` property in the Electron webview context.
  // We collect whichever we get and hand the paths to the extension via
  // `droppedPaths` — the extension reads them and posts `filesAttached`
  // back, which slots into the existing pendingFiles[] flow.
  // ---------------------------------------------------------------------------
  const dropOverlay = document.createElement('div');
  dropOverlay.id = 'drop-overlay';
  dropOverlay.className = 'hidden';
  dropOverlay.innerHTML = '<div class="drop-overlay-inner">Drop files or folders to attach</div>';
  document.body.appendChild(dropOverlay);

  let dragDepth = 0;

  function hasFileDrag(e) {
    const types = e?.dataTransfer?.types;
    if (!types) return false;
    for (const t of types) {
      if (t === 'Files' || t === 'text/uri-list') return true;
    }
    return false;
  }

  document.addEventListener('dragenter', (e) => {
    if (!hasFileDrag(e)) return;
    dragDepth++;
    dropOverlay.classList.remove('hidden');
  });

  document.addEventListener('dragover', (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  document.addEventListener('dragleave', (e) => {
    if (!hasFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.classList.add('hidden');
  });

  document.addEventListener('drop', (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.add('hidden');

    const paths = [];
    const seen = new Set();

    const uriList = e.dataTransfer?.getData('text/uri-list') || '';
    if (uriList) {
      for (const line of uriList.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        paths.push(trimmed);
      }
    }

    if (e.dataTransfer?.files) {
      for (const file of e.dataTransfer.files) {
        const p = file.path;
        if (p && !seen.has(p)) {
          seen.add(p);
          paths.push(p);
        }
      }
    }

    if (paths.length > 0) {
      vscode.postMessage({ command: 'droppedPaths', paths });
    }
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
      removeBtn.dataset.imageIndex = String(i);
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
  const sessionsSearch = document.getElementById('sessions-search');
  let allSessions = [];

  document.getElementById('history-btn').addEventListener('click', () => {
    const isOpen = !sessionsPanel.classList.contains('hidden');
    sessionsPanel.classList.toggle('hidden');
    if (!isOpen) {
      sessionsSearch.value = '';
      vscode.postMessage({ command: 'listSessions' });
    }
  });

  sessionsSearch.addEventListener('input', () => {
    renderSessionsList(allSessions, sessionsSearch.value);
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

  function renderSessionsList(sessions, filter) {
    if (sessions) {
      allSessions = sessions;
      allSessions.sort((a, b) => b.createdAt - a.createdAt);
    }
    const query = (filter || '').trim().toLowerCase();
    const visible = query ? allSessions.filter((s) => s.name.toLowerCase().includes(query)) : allSessions;

    sessionsList.innerHTML = '';
    if (visible.length === 0) {
      sessionsEmpty.classList.remove('hidden');
      return;
    }
    sessionsEmpty.classList.add('hidden');

    // Build all items in a fragment to avoid per-item reflow
    const fragment = document.createDocumentFragment();
    for (const s of visible) {
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

  // --- Settings menu (☰ menu button in the header) ---
  // Replaces the old Export button — holds backend profile switching,
  // export, and an "Open settings" escape hatch. Values injected from
  // chatWebview.ts as window.__backendProfiles / window.__activeBackendProfileId.
  const settingsBtn = document.getElementById('settings-btn');
  const settingsMenu = document.getElementById('settings-menu');
  const backendProfileList = document.getElementById('backend-profile-list');

  function renderBackendProfiles() {
    backendProfileList.innerHTML = '';
    const profiles = window.__backendProfiles || [];
    const activeId = window.__activeBackendProfileId;
    for (const p of profiles) {
      const btn = document.createElement('button');
      const isActive = p.id === activeId;
      btn.className = 'settings-menu-item backend-profile' + (isActive ? ' active' : '');
      btn.setAttribute('role', 'menuitem');
      // aria-current exposes "this is the currently-selected one" to
      // screen readers; the visible checkmark was previously the only
      // indicator.
      if (isActive) btn.setAttribute('aria-current', 'true');
      btn.dataset.profileId = p.id;
      const name = document.createElement('div');
      name.className = 'backend-profile-name';
      name.textContent = (p.id === activeId ? '\u2713 ' : '') + p.name;
      const desc = document.createElement('div');
      desc.className = 'backend-profile-desc';
      desc.textContent = p.description;
      btn.appendChild(name);
      btn.appendChild(desc);
      btn.addEventListener('click', () => {
        closeSettingsMenu();
        vscode.postMessage({ command: 'switchBackend', profileId: p.id });
      });
      backendProfileList.appendChild(btn);
    }
  }

  function openSettingsMenu() {
    renderBackendProfiles();
    settingsMenu.classList.remove('hidden');
    settingsBtn.setAttribute('aria-expanded', 'true');
  }
  function closeSettingsMenu() {
    settingsMenu.classList.add('hidden');
    settingsBtn.setAttribute('aria-expanded', 'false');
    // Return focus to the settings button so keyboard users and screen
    // readers don't lose their place after Escape or click-outside.
    settingsBtn.focus();
  }

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (settingsMenu.classList.contains('hidden')) {
      openSettingsMenu();
    } else {
      closeSettingsMenu();
    }
  });
  // Click-outside to dismiss
  document.addEventListener('click', (e) => {
    if (settingsMenu.classList.contains('hidden')) return;
    if (!settingsMenu.contains(e.target) && e.target !== settingsBtn) {
      closeSettingsMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsMenu.classList.contains('hidden')) {
      closeSettingsMenu();
    }
  });
  settingsMenu.querySelectorAll('.settings-menu-item[data-action]').forEach((item) => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      closeSettingsMenu();
      if (action === 'exportChat') vscode.postMessage({ command: 'exportChat' });
      else if (action === 'openSettings') vscode.postMessage({ command: 'openSettings' });
    });
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
    { cmd: '/init', desc: 'Generate SIDECAR.md project notes from codebase' },
    { cmd: '/bg', desc: 'Run a task in the background' },
    { cmd: '/fork', desc: 'Run N parallel approaches to the same task and pick the winner' },
    { cmd: '/arena', desc: 'Open Model Arena — compare 2–4 models side-by-side with ELO ratings' },
    { cmd: '/arena agent', desc: 'Model Arena agent mode — run a task through different models and pick the winner' },
    { cmd: '/notebook', desc: 'Enter source-grounded research mode with mandatory citations' },
    { cmd: '/code', desc: 'Exit Notebook Mode and return to coding-agent mode' },
    { cmd: '/resume', desc: 'Resume a response that was cut off mid-stream' },
    { cmd: '/review', desc: 'Review current git changes' },
    { cmd: '/pr-summary', desc: 'Generate PR title and summary' },
    { cmd: '/pr', desc: 'Push branch and open a draft pull request' },
    { cmd: '/ci', desc: 'Analyze the latest failing CI run on this branch' },
    { cmd: '/review-comments', desc: 'Fetch and display PR review comments for the current branch' },
    { cmd: '/pr-respond', desc: 'Dispatch the agent to respond to all open PR review threads' },
    { cmd: '/pr-ready', desc: 'Mark the current branch PR as ready for review' },
    { cmd: '/pr-ci', desc: 'Check the CI status of the current branch PR' },
    { cmd: '/commit-message', desc: 'Generate and copy a commit message' },
    { cmd: '/memories', desc: 'Browse agent memories' },
    { cmd: '/memory-search', desc: 'Search agent memories' },
    { cmd: '/compact', desc: 'Summarize older turns to free context window space' },
    { cmd: '/undo', desc: 'Revert last agent file changes and trim last turn' },
    { cmd: '/guards', desc: 'Show active regression guards and built-in guard catalog' },
    { cmd: '/branch', desc: 'Fork the current conversation into a new named thread' },
    { cmd: '/research', desc: 'Set active research project or log an observation' },
  ];
  const autocompleteEl = document.getElementById('slash-autocomplete');
  let acSelectedIndex = -1;
  let loadedSkillCommands = [];
  let skillsLoadedForAutocomplete = false;

  // ---------------------------------------------------------------------------
  // @-mention file completion
  // ---------------------------------------------------------------------------
  const atAutocompleteEl = document.getElementById('at-autocomplete');
  let atAcSelectedIndex = -1;
  let atAcFiles = []; // { label: basename, dir: relative dir, fullPath: full relative path }
  let atAcFilesLoaded = false;

  /** Return the word after the @ that precedes the cursor, or null if none. */
  function getAtQuery() {
    const val = input.value;
    const pos = input.selectionStart ?? val.length;
    const before = val.slice(0, pos);
    const m = before.match(/@(\S*)$/);
    return m ? m[1] : null;
  }

  function updateAtAutocomplete() {
    const query = getAtQuery();
    if (query === null) {
      atAutocompleteEl.classList.add('hidden');
      atAcSelectedIndex = -1;
      return;
    }

    if (!atAcFilesLoaded) {
      atAcFilesLoaded = true;
      vscode.postMessage({ command: 'requestFileCompletion' });
      // Will re-trigger once fileCompletionList arrives (see message handler below)
      return;
    }

    const q = query.toLowerCase();
    const filtered = atAcFiles.filter((f) => q === '' || f.fullPath.toLowerCase().includes(q)).slice(0, 12);

    if (filtered.length === 0) {
      atAutocompleteEl.classList.add('hidden');
      atAcSelectedIndex = -1;
      return;
    }

    atAcSelectedIndex = 0;
    atAutocompleteEl.innerHTML = '';
    filtered.forEach((f, i) => {
      const item = document.createElement('div');
      item.className = 'ac-item' + (i === 0 ? ' ac-selected' : '');
      item.innerHTML =
        `<span class="ac-cmd">${escapeHtml(f.label)}</span>` +
        (f.dir ? ` <span class="ac-desc">${escapeHtml(f.dir)}</span>` : '');
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectAtAutocomplete(f);
      });
      atAutocompleteEl.appendChild(item);
    });
    atAutocompleteEl.classList.remove('hidden');
  }

  function selectAtAutocomplete(file) {
    const val = input.value;
    const pos = input.selectionStart ?? val.length;
    const before = val.slice(0, pos);
    const after = val.slice(pos);
    // Replace @query with @basename
    const newBefore = before.replace(/@(\S*)$/, '@' + file.label);
    input.value = newBefore + after;
    const newPos = newBefore.length;
    input.setSelectionRange(newPos, newPos);
    input.focus();
    atAutocompleteEl.classList.add('hidden');
    atAcSelectedIndex = -1;
    // Attach the file through the existing droppedPaths pipeline
    vscode.postMessage({ command: 'droppedPaths', paths: [file.fullPath] });
  }

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
      item.innerHTML = `<span class="ac-cmd">${escapeHtml(c.cmd)}</span> <span class="ac-desc">${escapeHtml(c.desc)}</span>`;
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

  // Track manual resize so auto-expand doesn't shrink a user-dragged height.
  let manualInputHeight = 0;
  input.addEventListener('pointerup', () => {
    manualInputHeight = input.clientHeight;
  });

  // Auto-resize textarea and update send button label
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    const autoH = Math.min(input.scrollHeight, 300);
    input.style.height = Math.max(autoH, manualInputHeight) + 'px';
    updateAutocomplete();
    updateAtAutocomplete();
    updateSendButton();
  });

  // Enter to send, Shift+Enter for newline, arrow keys for autocomplete
  input.addEventListener('keydown', (e) => {
    // @-mention autocomplete — takes priority over slash autocomplete
    if (!atAutocompleteEl.classList.contains('hidden')) {
      const atItems = atAutocompleteEl.querySelectorAll('.ac-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        atAcSelectedIndex = Math.min(atAcSelectedIndex + 1, atItems.length - 1);
        atItems.forEach((el, i) => el.classList.toggle('ac-selected', i === atAcSelectedIndex));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        atAcSelectedIndex = Math.max(atAcSelectedIndex - 1, 0);
        atItems.forEach((el, i) => el.classList.toggle('ac-selected', i === atAcSelectedIndex));
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && atAcSelectedIndex >= 0) {
        e.preventDefault();
        const idx = atAcSelectedIndex;
        const filtered = atAcFiles.filter((f) => {
          const q = getAtQuery()?.toLowerCase() ?? '';
          return q === '' || f.fullPath.toLowerCase().includes(q);
        });
        if (filtered[idx]) selectAtAutocomplete(filtered[idx]);
        return;
      }
      if (e.key === 'Escape') {
        atAutocompleteEl.classList.add('hidden');
        atAcSelectedIndex = -1;
        return;
      }
    }

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
      // Steer routing: when a run is active, Enter queues a steer
      // instead of starting a new turn. Ctrl/Cmd+Enter upgrades to
      // interrupt urgency so a mid-stream course-correct aborts the
      // in-flight turn immediately.
      if (steerEnabled) {
        const urgency = e.ctrlKey || e.metaKey ? 'interrupt' : 'nudge';
        enqueueSteerFromInput(urgency);
        return;
      }
      submitMessage();
    }
  });

  sendBtn.addEventListener('click', () => {
    const hasText = input.value.trim().length > 0;
    if (hasText) {
      if (steerEnabled) {
        enqueueSteerFromInput('nudge');
      } else {
        submitMessage();
      }
    } else if (isLoading) {
      vscode.postMessage({ command: 'abort' });
      setLoading(false);
    }
  });

  // Global Escape key — clear input first; abort only when input is already empty.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Don't handle if autocomplete is open (input handler manages that)
    if (!autocompleteEl.classList.contains('hidden')) return;
    e.preventDefault();
    if (input.value.trim().length > 0) {
      input.value = '';
      input.style.height = 'auto';
      updateSendButton();
      input.focus();
      return;
    }
    if (!isLoading) return;
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
      '/fork': {
        syntax: '/fork <task>',
        desc: 'Run N parallel approaches to the same task in isolated Shadow Workspaces, then pick the winner',
      },
      '/arena agent': {
        syntax: '/arena agent <task>',
        desc: 'Run a task through different models in parallel and compare results',
      },
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
    if (text.startsWith('/fork ')) {
      const forkTask = text.slice(6).trim();
      if (forkTask) {
        appendMessage('user', text);
        vscode.postMessage({ command: 'forkStart', text: forkTask });
        input.value = '';
        input.style.height = 'auto';
        return;
      }
    }
    if (text.trim() === '/arena' || (text.startsWith('/arena ') && !text.startsWith('/arena agent'))) {
      // /arena            → open arena (model QuickPick in extension)
      // /arena m1,m2      → open arena with pre-selected models
      const rest = text.slice(6).trim();
      const models = rest
        ? rest
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      appendMessage('user', text);
      vscode.postMessage({ command: 'arenaStart', models });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.startsWith('/arena agent ')) {
      const agentTask = text.slice(13).trim();
      if (agentTask) {
        appendMessage('user', text);
        vscode.postMessage({ command: 'arenaAgentStart', text: agentTask });
        input.value = '';
        input.style.height = 'auto';
        return;
      }
    }
    if (text.trim() === '/notebook') {
      appendMessage('user', '/notebook');
      vscode.postMessage({ command: 'notebookStart' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/code') {
      appendMessage('user', '/code');
      vscode.postMessage({ command: 'notebookExit' });
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
    if (text.trim() === '/resume') {
      appendMessage('user', '/resume');
      vscode.postMessage({ command: 'resume' });
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
    if (text.trim() === '/review') {
      appendMessage('user', '/review');
      vscode.postMessage({ command: 'reviewChanges' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/pr-summary') {
      appendMessage('user', '/pr-summary');
      vscode.postMessage({ command: 'prSummary' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/pr') {
      appendMessage('user', '/pr');
      vscode.postMessage({ command: 'createDraftPR' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/ci') {
      appendMessage('user', '/ci');
      vscode.postMessage({ command: 'analyzeCi' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/review-comments') {
      appendMessage('user', '/review-comments');
      vscode.postMessage({ command: 'reviewPrComments' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/pr-respond') {
      appendMessage('user', '/pr-respond');
      vscode.postMessage({ command: 'respondPrComments' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/pr-ready') {
      appendMessage('user', '/pr-ready');
      vscode.postMessage({ command: 'markPrReady' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/pr-ci') {
      appendMessage('user', '/pr-ci');
      vscode.postMessage({ command: 'checkPrCi' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/commit-message') {
      appendMessage('user', '/commit-message');
      vscode.postMessage({ command: 'commitMessage' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim() === '/memories') {
      appendMessage('user', '/memories');
      vscode.postMessage({ command: 'listMemories' });
      input.value = '';
      input.style.height = 'auto';
      return;
    }
    if (text.trim().startsWith('/memory-search ')) {
      const query = text.trim().slice('/memory-search '.length).trim();
      appendMessage('user', '/memory-search ' + query);
      vscode.postMessage({ command: 'searchMemories', text: query });
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
    if (text.trim() === '/skills' || text.trim() === '/skills stack') {
      const stackMode = text.trim() === '/skills stack';
      vscode.postMessage({ command: 'openSkillPicker', stackMode });
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
        '**Available chat commands:**\n' +
          '`/help` — Show this list\n' +
          '`/model <name>` — Switch model (persists across turns)\n' +
          '`@opus` / `@sonnet` / `@haiku` / `@local` — one-turn model pin (v0.64)\n' +
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
          '`/compact` — Summarize older turns to free context window space\n' +
          '`/undo` — Revert last agent file changes and trim last turn\n' +
          '`/guards` — Show active regression guards and built-in guard catalog\n' +
          '`/branch [name]` — Fork the current conversation into a new named thread\n' +
          '`/research [observe <note>]` — Set active research project or log an observation\n' +
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
    const displayText = text;
    const activeFileIncluded =
      currentActiveFile !== null && pendingFiles.some((f) => f.fileName === currentActiveFile.fileName);

    if (pendingFiles.length > 0) {
      let prefix = '';
      for (const f of pendingFiles) {
        prefix += '[File: ' + f.fileName + ']\n```\n' + f.fileContent + '\n```\n\n';
      }
      messageText = prefix + text;
      const div = appendMessage('user', displayText);
      const label = document.createElement('span');
      label.className = 'attachment-label';
      label.textContent =
        pendingFiles.length === 1
          ? 'Attached: ' + pendingFiles[0].fileName
          : 'Attached ' + pendingFiles.length + ' files: ' + pendingFiles.map((f) => f.fileName).join(', ');
      div.appendChild(label);
      pendingFiles = [];
      renderPendingFiles();
    } else {
      appendMessage('user', displayText);
    }

    if (pendingImages.length > 0) {
      vscode.postMessage({ command: 'userMessage', text: messageText, images: pendingImages, activeFileIncluded });
      pendingImages = [];
      updateImagePreview();
    } else {
      vscode.postMessage({ command: 'userMessage', text: messageText, activeFileIncluded });
    }
    input.value = '';
    input.style.height = 'auto';
  }

  // ---------------------------------------------------------------------------
  // Steer queue (v0.65 chunk 3.3)
  //
  // When a run is active the strip above the input lists pending
  // steers the user typed mid-run. Shift+Enter enqueues as 'nudge';
  // Shift+Ctrl+Enter (or Shift+Cmd+Enter) enqueues as 'interrupt'.
  // Plain Enter still sends a normal user message via sendMessage().
  // ---------------------------------------------------------------------------
  function renderSteerStrip() {
    if (!steerStrip) return;
    if (!steerEnabled || steerItems.length === 0) {
      steerStrip.classList.add('hidden');
      steerStrip.innerHTML = '';
      return;
    }
    steerStrip.classList.remove('hidden');
    const frag = document.createDocumentFragment();
    for (const item of steerItems) {
      const row = document.createElement('div');
      row.className = 'steer-item steer-urgency-' + item.urgency;
      row.dataset.id = item.id;

      const badge = document.createElement('span');
      badge.className = 'steer-badge';
      badge.textContent = item.urgency === 'interrupt' ? '🔴 interrupt' : '🟡 nudge';
      row.appendChild(badge);

      if (editingSteerId === item.id) {
        const edit = document.createElement('input');
        edit.type = 'text';
        edit.className = 'steer-edit-input';
        edit.value = item.text;
        edit.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && edit.value.trim()) {
            vscode.postMessage({ command: 'steerEdit', steerId: item.id, text: edit.value });
            editingSteerId = null;
          } else if (e.key === 'Escape') {
            editingSteerId = null;
            renderSteerStrip();
          }
        });
        row.appendChild(edit);
        // Focus after insert so typing lands in the edit field.
        setTimeout(() => edit.focus(), 0);
      } else {
        const text = document.createElement('span');
        text.className = 'steer-text';
        text.textContent = item.text;
        row.appendChild(text);
      }

      const editBtn = document.createElement('button');
      editBtn.className = 'steer-action';
      editBtn.title = 'Edit this steer';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => {
        editingSteerId = editingSteerId === item.id ? null : item.id;
        renderSteerStrip();
      });
      row.appendChild(editBtn);

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'steer-action steer-cancel';
      cancelBtn.title = 'Cancel this steer';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'steerCancel', steerId: item.id });
      });
      row.appendChild(cancelBtn);

      frag.appendChild(row);
    }
    steerStrip.innerHTML = '';
    steerStrip.appendChild(frag);
  }

  function renderAutoModeStrip() {
    if (!autoModeStrip) return;
    if (!autoModeCurrent && autoModeHistory.length === 0) {
      autoModeStrip.classList.add('hidden');
      autoModeStrip.innerHTML = '';
      return;
    }
    autoModeStrip.classList.remove('hidden');
    const frag = document.createDocumentFragment();

    // Header row: spinner/done icon + label + progress + stop button
    const header = document.createElement('div');
    header.className = 'am-header';

    const icon = document.createElement('span');
    icon.className = autoModeCurrent ? 'am-icon am-icon-running' : 'am-icon am-icon-done';
    icon.textContent = autoModeCurrent ? '⟳' : '✓';
    header.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'am-label';
    label.textContent = 'Auto Mode';
    header.appendChild(label);

    if (autoModeCurrent) {
      const progress = document.createElement('span');
      progress.className = 'am-progress';
      progress.textContent = `task ${autoModeCurrent.taskN}/${autoModeCurrent.total}`;
      header.appendChild(progress);

      const stopBtn = document.createElement('button');
      stopBtn.className = 'am-stop-btn';
      stopBtn.textContent = 'Stop';
      stopBtn.title = 'Stop Auto Mode';
      stopBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'stopAutoMode' });
      });
      header.appendChild(stopBtn);
    } else {
      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'am-dismiss-btn';
      dismissBtn.textContent = '✕';
      dismissBtn.title = 'Dismiss';
      dismissBtn.addEventListener('click', () => {
        autoModeHistory = [];
        autoModeCurrent = null;
        renderAutoModeStrip();
      });
      header.appendChild(dismissBtn);
    }

    frag.appendChild(header);

    // Current task (if running)
    if (autoModeCurrent) {
      const current = document.createElement('div');
      current.className = 'am-current-task';
      current.textContent = autoModeCurrent.text;
      frag.appendChild(current);
    }

    // History list (last 5, newest first)
    const recent = autoModeHistory.slice(-5).reverse();
    for (const entry of recent) {
      const row = document.createElement('div');
      row.className = 'am-history-row am-status-' + entry.status;

      const glyph = document.createElement('span');
      glyph.className = 'am-glyph';
      glyph.textContent = entry.status === 'done' ? '✓' : '✗';
      row.appendChild(glyph);

      const text = document.createElement('span');
      text.className = 'am-history-text';
      text.textContent = entry.text;
      if (entry.errorMessage) text.title = entry.errorMessage;
      row.appendChild(text);

      frag.appendChild(row);
    }

    autoModeStrip.innerHTML = '';
    autoModeStrip.appendChild(frag);
  }

  function enqueueSteerFromInput(urgency) {
    const text = input.value.trim();
    if (!text) return false;
    vscode.postMessage({ command: 'steerEnqueue', text, steerUrgency: urgency });
    input.value = '';
    input.style.height = 'auto';
    updateSendButton();
    input.focus();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Planned Edits card (v0.65 chunk 4.4a)
  //
  // Renders the EditPlan manifest the runtime produced just before a
  // multi-file write batch executes. Users inspect the planned scope +
  // DAG edges and can amend via the Steer Queue ("skip src/legacy/**").
  // No per-card amend UI here — steer is the amend channel.
  // ---------------------------------------------------------------------------
  // Active Planned Edits card — most recent one rendered. Status
  // updates via `editPlanProgress` find rows by path within this card.
  // Rotating to a new card on each fresh plan is intentional: older
  // plans stay visible in the transcript as a historical record but
  // only the current plan receives live status transitions.
  let activeEditPlanCard = null;
  // op-type per path for the active plan (populated when the card renders,
  // used to send the correct revert command when the user clicks Revert).
  const editPlanOps = new Map();
  // Paths that completed successfully in the active run (populated as
  // done-status progress updates arrive; cleared when a new plan card renders).
  const editPlanDonePaths = new Set();

  const STATUS_GLYPH = {
    pending: '◯',
    writing: '⟳',
    done: '✓',
    failed: '✗',
    aborted: '⊘',
  };

  function renderEditPlanCard(edits) {
    editPlanOps.clear();
    editPlanDonePaths.clear();
    for (const e of edits) editPlanOps.set(e.path, e.op);

    const card = document.createElement('details');
    card.className = 'edit-plan-card';
    card.open = true;

    const summary = document.createElement('summary');
    summary.className = 'edit-plan-summary';
    const countByOp = { create: 0, edit: 0, delete: 0 };
    for (const e of edits) if (countByOp[e.op] !== undefined) countByOp[e.op] += 1;
    const parts = [];
    if (countByOp.create) parts.push(countByOp.create + ' new');
    if (countByOp.edit) parts.push(countByOp.edit + ' edit');
    if (countByOp.delete) parts.push(countByOp.delete + ' delete');
    summary.textContent = '📋 Planned edits (' + edits.length + ' files: ' + parts.join(', ') + ')';
    card.appendChild(summary);

    const list = document.createElement('ul');
    list.className = 'edit-plan-list';
    for (const e of edits) {
      const item = document.createElement('li');
      item.className = 'edit-plan-item edit-plan-op-' + e.op;
      item.dataset.path = e.path;

      const status = document.createElement('span');
      status.className = 'edit-plan-status edit-plan-status-pending';
      status.textContent = STATUS_GLYPH.pending;
      status.title = 'pending';
      item.appendChild(status);

      const badge = document.createElement('span');
      badge.className = 'edit-plan-badge';
      badge.textContent = e.op;
      item.appendChild(badge);

      const path = document.createElement('span');
      path.className = 'edit-plan-path';
      path.textContent = e.path;
      item.appendChild(path);

      if (e.rationale && e.rationale.length > 0) {
        const rat = document.createElement('span');
        rat.className = 'edit-plan-rationale';
        rat.textContent = e.rationale;
        item.appendChild(rat);
      }

      if (Array.isArray(e.dependsOn) && e.dependsOn.length > 0) {
        const deps = document.createElement('span');
        deps.className = 'edit-plan-deps';
        deps.textContent = '← depends on: ' + e.dependsOn.join(', ');
        item.appendChild(deps);
      }

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'edit-plan-cancel';
      cancelBtn.textContent = '×';
      cancelBtn.title = 'Cancel this file';
      cancelBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        vscode.postMessage({ command: 'cancelEditPlanFile', filePath: e.path });
        cancelBtn.disabled = true;
      });
      item.appendChild(cancelBtn);

      list.appendChild(item);
    }
    card.appendChild(list);

    const hint = document.createElement('div');
    hint.className = 'edit-plan-hint';
    hint.textContent = 'Amend this plan by queuing a steer (Enter in the input below while the run is live).';
    card.appendChild(hint);

    messagesContainer.appendChild(card);
    activeEditPlanCard = card;
  }

  // Apply an `editPlanProgress` status transition to the matching row
  // on the most-recent plan card. No-ops when no active card exists
  // or the path isn't in the current plan — the updates arrive in
  // arrival order and a stale message from a prior run can't corrupt
  // an in-flight card.
  function applyEditPlanProgress(update) {
    if (!activeEditPlanCard || !update || !update.path) return;
    const row = activeEditPlanCard.querySelector('[data-path="' + cssEscape(update.path) + '"]');
    if (!row) return;
    const statusEl = row.querySelector('.edit-plan-status');
    if (!statusEl) return;
    statusEl.textContent = STATUS_GLYPH[update.status] || '?';
    statusEl.title = update.status + (update.errorMessage ? ': ' + update.errorMessage : '');
    // Swap class so CSS can color/animate per state.
    statusEl.className = 'edit-plan-status edit-plan-status-' + update.status;
    // Hide cancel button once the edit reaches a terminal state.
    const cancelBtn = row.querySelector('.edit-plan-cancel');
    if (cancelBtn) {
      const isTerminal = update.status === 'done' || update.status === 'failed' || update.status === 'aborted';
      cancelBtn.style.display = isTerminal ? 'none' : '';
    }
    // When a file completes successfully, record it and show a per-row Revert button.
    if (update.status === 'done') {
      editPlanDonePaths.add(update.path);
      if (!row.querySelector('.edit-plan-revert-btn')) {
        const revertBtn = document.createElement('button');
        revertBtn.className = 'edit-plan-revert-btn';
        revertBtn.textContent = 'Revert';
        revertBtn.title = 'Undo changes to this file';
        const op = editPlanOps.get(update.path) || 'edit';
        revertBtn.addEventListener('click', () => {
          vscode.postMessage({ command: 'rejectEditPlanFile', filePath: update.path, op });
          revertBtn.disabled = true;
          revertBtn.textContent = 'Reverted';
        });
        row.appendChild(revertBtn);
      }
    }
  }

  // CSS.escape fallback — the runtime webview hasn't always shipped it.
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\\n]/g, '\\$&');
  }

  // ---------------------------------------------------------------------------
  // Persistent Resume affordance (v0.65 chunk 7b)
  //
  // The inline Resume button (rendered on `resumeAvailable` into the
  // transcript) handles the moment-of-failure discovery case. The strip
  // below the transcript handles the "I've scrolled away and need to get
  // back to resuming" case. Both point at the same `resume` command.
  // ---------------------------------------------------------------------------
  function renderResumeStrip() {
    if (!resumeStrip) return;
    if (resumePendingSteerCount < 0) {
      resumeStrip.classList.add('hidden');
      resumeStrip.innerHTML = '';
      return;
    }
    resumeStrip.classList.remove('hidden');
    resumeStrip.innerHTML = '';

    const label = document.createElement('span');
    label.className = 'resume-strip-label';
    const steerSuffix =
      resumePendingSteerCount > 0
        ? ' (+' + resumePendingSteerCount + ' queued steer' + (resumePendingSteerCount === 1 ? '' : 's') + ')'
        : '';
    label.textContent = '⚠ Stream interrupted — resume available' + steerSuffix;
    resumeStrip.appendChild(label);

    const resumeBtn = document.createElement('button');
    resumeBtn.className = 'resume-strip-btn';
    resumeBtn.textContent = '▶ Resume';
    resumeBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'resume' });
      resumeBtn.disabled = true;
      resumeBtn.textContent = 'Resuming...';
    });
    resumeStrip.appendChild(resumeBtn);

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'resume-strip-dismiss';
    dismissBtn.title = 'Dismiss — the partial is kept but the strip hides';
    dismissBtn.textContent = '✕';
    dismissBtn.addEventListener('click', () => {
      hideResumeStrip();
    });
    resumeStrip.appendChild(dismissBtn);
  }

  function hideResumeStrip() {
    resumePendingSteerCount = -1;
    if (resumeStrip) {
      resumeStrip.classList.add('hidden');
      resumeStrip.innerHTML = '';
    }
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
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
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
            const firstLine = lines[i].replace(/^\s*\d+\.\s+/, '');
            i++;
            // Collect continuation lines including indented sub-items (nested bullets, etc.).
            // Only stop at a new numbered item at the same level, a heading, or a blank
            // line not followed by more indented content.
            const itemLines = [firstLine];
            while (i < lines.length) {
              const cur = lines[i];
              if (/^\s*\d+\.\s+/.test(cur) || /^#{1,4}\s+/.test(cur)) break;
              if (cur.trim() === '') {
                // Peek: stop if next non-blank line is a new numbered item or heading.
                let j = i + 1;
                while (j < lines.length && lines[j].trim() === '') j++;
                if (j >= lines.length || /^\s*\d+\.\s+/.test(lines[j]) || /^#{1,4}\s+/.test(lines[j])) break;
                itemLines.push('');
                i++;
              } else {
                itemLines.push(cur);
                i++;
              }
            }
            const itemContent = itemLines.join('\n').trimEnd();
            // Single-line items use inline rendering to avoid a <p> wrapper.
            // Multi-line items (e.g. with indented sub-bullets) use block rendering
            // so nested lists are parsed recursively.
            if (!itemContent.includes('\n')) {
              appendInlineMarkdown(li, itemContent);
            } else {
              appendBlockMarkdown(li, itemContent);
            }
            ol.appendChild(li);
          } else if (lines[i].trim() === '' && i + 1 < lines.length && /^\s*\d+\.\s+/.test(lines[i + 1])) {
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
        !/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(lines[i])
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

      const copyCodeBtn = document.createElement('button');
      copyCodeBtn.className = 'code-save-btn code-copy-btn';
      copyCodeBtn.textContent = 'Copy';
      copyCodeBtn.title = 'Copy code to clipboard';
      copyCodeBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(code).then(() => {
          copyCodeBtn.textContent = '✓';
          setTimeout(() => (copyCodeBtn.textContent = 'Copy'), 1500);
        });
      });
      header.appendChild(copyCodeBtn);

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

  /** Add copy, regenerate (assistant only), and delete action buttons to a message div. */
  function addMessageActions(div, isAssistant = false) {
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

    if (isAssistant) {
      const regenBtn = document.createElement('button');
      regenBtn.className = 'message-action-btn message-regen-btn';
      regenBtn.innerHTML = '&#x21bb;';
      regenBtn.title = 'Regenerate response';
      regenBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ command: 'regenerateResponse' });
      });
      actions.appendChild(regenBtn);
    }

    if (!isAssistant && div.dataset.rawContent) {
      const editBtn = document.createElement('button');
      editBtn.className = 'message-action-btn message-edit-btn';
      editBtn.innerHTML = '&#x270e;';
      editBtn.title = 'Edit and resend';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startInlineEdit(div);
      });
      actions.appendChild(editBtn);
    }

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

  // ------------------------------------------------------------------
  // Inline message editing — replaces a user message bubble with a
  // textarea so the user can edit and resend from that point.
  // ------------------------------------------------------------------

  function setTruncatePreview(anchorDiv, active) {
    let sibling = anchorDiv.nextElementSibling;
    while (sibling) {
      sibling.classList.toggle('msg-will-truncate', active);
      sibling = sibling.nextElementSibling;
    }
  }

  function startInlineEdit(div) {
    if (div.dataset.editing === 'true') return;
    div.dataset.editing = 'true';

    const originalContent = div.dataset.rawContent || '';
    const originalHTML = div.innerHTML;

    // Dim subsequent messages to preview what will be removed on Resend
    setTruncatePreview(div, true);

    // Hide action buttons while editing
    const actionsEl = div.querySelector('.message-actions');
    if (actionsEl) actionsEl.style.display = 'none';

    // Build inline editor
    const editor = document.createElement('div');
    editor.className = 'msg-inline-editor';

    const textarea = document.createElement('textarea');
    textarea.className = 'msg-inline-textarea';
    textarea.value = originalContent;
    textarea.rows = Math.max(2, originalContent.split('\n').length);
    editor.appendChild(textarea);

    if (div.nextElementSibling) {
      const hint = document.createElement('div');
      hint.className = 'msg-inline-hint';
      hint.textContent = 'Messages below will be removed on resend';
      editor.appendChild(hint);
    }

    const btnRow = document.createElement('div');
    btnRow.className = 'msg-inline-btn-row';

    const resendBtn = document.createElement('button');
    resendBtn.className = 'msg-inline-resend';
    resendBtn.textContent = 'Resend';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'msg-inline-cancel';
    cancelBtn.textContent = 'Cancel';

    btnRow.appendChild(resendBtn);
    btnRow.appendChild(cancelBtn);
    editor.appendChild(btnRow);

    // Replace bubble content with editor (keep the div itself)
    div.innerHTML = '';
    div.appendChild(editor);

    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    // Auto-resize
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
    });

    function cancelEdit() {
      div.dataset.editing = 'false';
      div.innerHTML = originalHTML;
      setTruncatePreview(div, false);
    }

    function submitEdit() {
      const newText = textarea.value.trim();
      if (!newText) return;
      const index = parseInt(div.dataset.msgIndex, 10);
      if (isNaN(index)) return;
      div.dataset.editing = 'false';
      vscode.postMessage({ command: 'editMessage', index, text: newText });
    }

    cancelBtn.addEventListener('click', cancelEdit);
    resendBtn.addEventListener('click', submitEdit);

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitEdit();
      }
    });
  }

  // ------------------------------------------------------------------
  // Message context menu — right-click on a message opens a small themed
  // popover with Copy / Delete (and Copy Code when the click originated
  // on a code block). Dynamic items keep the menu relevant to whatever
  // the user actually right-clicked on.
  // ------------------------------------------------------------------
  const contextMenuEl = document.createElement('div');
  contextMenuEl.className = 'chat-context-menu hidden';
  contextMenuEl.setAttribute('role', 'menu');
  document.body.appendChild(contextMenuEl);

  function hideContextMenu() {
    contextMenuEl.classList.add('hidden');
    contextMenuEl.innerHTML = '';
  }

  function showContextMenu(x, y, items) {
    contextMenuEl.innerHTML = '';
    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'chat-context-menu-sep';
        contextMenuEl.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-context-menu-item';
      btn.setAttribute('role', 'menuitem');

      // Two-part label layout: bold action on the left, muted detail on
      // the right. The detail disambiguates items that share a label —
      // critical for "Why?" when multiple things can be explained.
      const labelSpan = document.createElement('span');
      labelSpan.className = 'chat-context-menu-label';
      labelSpan.textContent = item.label;
      btn.appendChild(labelSpan);
      if (item.detail) {
        const detailSpan = document.createElement('span');
        detailSpan.className = 'chat-context-menu-detail';
        detailSpan.textContent = item.detail;
        btn.appendChild(detailSpan);
      }

      btn.addEventListener('click', () => {
        hideContextMenu();
        item.action();
      });
      contextMenuEl.appendChild(btn);
    }
    contextMenuEl.classList.remove('hidden');

    // Position the menu, keeping it inside the viewport.
    const rect = contextMenuEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(x, vw - rect.width - 4);
    const top = Math.min(y, vh - rect.height - 4);
    contextMenuEl.style.left = Math.max(0, left) + 'px';
    contextMenuEl.style.top = Math.max(0, top) + 'px';
  }

  function buildMessageMenuItems(messageDiv, codeBlock) {
    const items = [];

    if (codeBlock) {
      // Code block found under the click — prepend code-specific actions.
      const codeEl = codeBlock.querySelector('pre > code');
      const code = codeEl ? codeEl.textContent || '' : '';
      items.push({
        label: 'Copy code',
        action: () => {
          navigator.clipboard.writeText(code);
        },
      });
      const saveBtn = codeBlock.querySelector('.code-save-btn[data-action="save"]');
      if (saveBtn) {
        items.push({
          label: 'Save code as...',
          action: () => saveBtn.click(),
        });
      }
      items.push({ separator: true });
    }

    items.push({
      label: 'Copy message',
      action: () => {
        const raw = messageDiv.dataset.rawContent || messageDiv.innerText;
        navigator.clipboard.writeText(raw);
      },
    });

    if (!messageDiv.classList.contains('assistant') && messageDiv.dataset.rawContent) {
      items.push({
        label: 'Edit and resend',
        action: () => startInlineEdit(messageDiv),
      });
    }

    items.push({
      label: 'Delete message',
      action: () => {
        const index = parseInt(messageDiv.dataset.msgIndex, 10);
        if (!isNaN(index)) {
          vscode.postMessage({ command: 'deleteMessage', index });
          messageDiv.remove();
        }
      },
    });

    return items;
  }

  /** Build menu items for a right-click on a .tool-call element. */
  function buildToolCallMenuItems(toolCallEl) {
    const items = [];
    const toolId = toolCallEl.getAttribute('data-tool-id') || '';
    // Human-readable tool name for menu item descriptions. Pulled from
    // the rendered summary so the user sees the same label the inline
    // tool-call uses, not the raw snake_case name.
    const nameEl = toolCallEl.querySelector('.tool-name');
    const toolName = nameEl ? (nameEl.textContent || '').trim() : 'tool';

    // Mirror the existing "Why?" inline button: only expose the
    // explanation action once the tool has finished running AND we
    // have an id to route the explainToolDecision request to.
    const isRunning = toolCallEl.classList.contains('running');
    if (toolId && !isRunning) {
      items.push({
        label: 'Why?',
        detail: toolName,
        action: () => {
          vscode.postMessage({ command: 'explainToolDecision', toolCallId: toolId });
          // Reflect the pending state on the inline button if present.
          const inlineBtn = toolCallEl.querySelector('.tool-why-btn');
          if (inlineBtn) {
            inlineBtn.disabled = true;
            inlineBtn.textContent = '...';
          }
        },
      });
    }
    const body = toolCallEl.querySelector('.tool-call-body');
    if (body && body.textContent) {
      items.push({
        label: 'Copy output',
        detail: toolName,
        action: () => {
          navigator.clipboard.writeText(body.textContent || '');
        },
      });
    }
    return items;
  }

  messagesContainer.addEventListener('contextmenu', (e) => {
    // Tool-call elements live as siblings of .message inside messagesContainer,
    // so check them first — otherwise a click inside a tool-call that also
    // happens to be inside a .message ancestor would pick the wrong menu.
    const toolCallEl = e.target.closest('.tool-call');
    if (toolCallEl && messagesContainer.contains(toolCallEl)) {
      const items = buildToolCallMenuItems(toolCallEl);
      if (items.length === 0) return;
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, items);
      return;
    }

    const messageDiv = e.target.closest('.message');
    if (!messageDiv) return;
    // If the user right-clicked on the action buttons strip, let the
    // native menu through — those buttons are not the message content.
    if (e.target.closest('.message-actions')) return;
    e.preventDefault();
    const codeBlock = e.target.closest('.code-block');
    showContextMenu(e.clientX, e.clientY, buildMessageMenuItems(messageDiv, codeBlock));
  });

  document.addEventListener('click', (e) => {
    if (!contextMenuEl.contains(e.target)) hideContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContextMenu();
  });
  window.addEventListener('blur', hideContextMenu);
  window.addEventListener('resize', hideContextMenu);

  // ------------------------------------------------------------------
  // Persistent empty-state welcome card. Rendered when the chat has no
  // messages — first launch, after Clear Chat, or when the user opens
  // the sidebar with a fresh session. Replaces the old one-shot
  // onboarding card, which disappeared after dismissal and left new
  // users with a blank panel on subsequent clears.
  //
  // The card offers:
  //   - A one-line status of the active backend + model
  //   - Quick action buttons that postMessage a whitelist of commands
  //     (Set API Key, Switch Backend, Show Commands palette)
  //   - Example prompt chips that pre-fill the input on click
  //   - Keyboard shortcut hints
  //
  // It is hidden automatically by appendMessage the moment the first
  // real message lands.
  // ------------------------------------------------------------------
  let emptyStateEl = null;

  function hideEmptyState() {
    if (emptyStateEl) {
      emptyStateEl.remove();
      emptyStateEl = null;
    }
  }

  function runExtensionCommand(commandId, args) {
    vscode.postMessage({ command: 'executeExtensionCommand', commandId, args: args || [] });
  }

  function renderEmptyState() {
    hideEmptyState();
    const card = document.createElement('div');
    card.className = 'empty-state-card';

    const title = document.createElement('div');
    title.className = 'empty-state-title';
    title.textContent = 'SideCar';
    card.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.className = 'empty-state-subtitle';
    subtitle.textContent = 'Local-first AI coding assistant for VS Code';
    card.appendChild(subtitle);

    // Backend status line — updates whenever window.currentModel changes.
    const status = document.createElement('div');
    status.className = 'empty-state-status';
    const modelName = window.currentModel || 'loading...';
    const statusIcon = document.createElement('span');
    statusIcon.className = 'empty-state-status-icon';
    statusIcon.textContent = '●';
    const statusText = document.createElement('span');
    statusText.textContent = 'Active model: ' + modelName;
    status.appendChild(statusIcon);
    status.appendChild(statusText);
    card.appendChild(status);

    // Quick actions — each one postMessages to run a real VS Code command.
    const actions = document.createElement('div');
    actions.className = 'empty-state-actions';
    const quickActions = [
      { label: 'Set / Refresh API Key', cmd: 'sidecar.setApiKey' },
      { label: 'Switch Backend', cmd: 'sidecar.switchBackend' },
      { label: 'Browse Commands', cmd: 'workbench.action.quickOpen', args: ['>SideCar: '] },
    ];
    for (const action of quickActions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'empty-state-action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => runExtensionCommand(action.cmd, action.args));
      actions.appendChild(btn);
    }
    card.appendChild(actions);

    // Starter prompt chips — click to pre-fill the input so the user
    // can edit before sending rather than auto-submitting.
    const chipsTitle = document.createElement('div');
    chipsTitle.className = 'empty-state-section-title';
    chipsTitle.textContent = 'Try asking...';
    card.appendChild(chipsTitle);

    const starters = [
      'Summarize the codebase in this workspace',
      'Find all TODO comments and list them with file:line',
      'Review the last 5 commits for bugs or risky changes',
      'What does the file in the active editor do?',
    ];
    const chipsContainer = document.createElement('div');
    chipsContainer.className = 'empty-state-chips';
    for (const text of starters) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'empty-state-chip';
      chip.textContent = text;
      chip.addEventListener('click', () => {
        const inputEl = document.getElementById('input');
        if (inputEl) {
          inputEl.value = text;
          inputEl.focus();
          // Trigger the autoresize handler the input uses elsewhere.
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      chipsContainer.appendChild(chip);
    }
    card.appendChild(chipsContainer);

    // Keyboard shortcut hints — the three most common bindings.
    const hintsTitle = document.createElement('div');
    hintsTitle.className = 'empty-state-section-title';
    hintsTitle.textContent = 'Shortcuts';
    card.appendChild(hintsTitle);

    const isMac = navigator.platform.toLowerCase().includes('mac');
    const mod = isMac ? '⌘' : 'Ctrl';
    const hints = [
      [mod + '⇧I', 'Toggle SideCar chat'],
      [mod + 'I', 'Inline chat in the editor'],
      [mod + '⇧P', 'Command palette — type "SideCar:"'],
    ];
    const hintList = document.createElement('dl');
    hintList.className = 'empty-state-hints';
    for (const [keys, desc] of hints) {
      const dt = document.createElement('dt');
      dt.textContent = keys;
      const dd = document.createElement('dd');
      dd.textContent = desc;
      hintList.appendChild(dt);
      hintList.appendChild(dd);
    }
    card.appendChild(hintList);

    messagesContainer.appendChild(card);
    emptyStateEl = card;
  }

  function maybeRenderEmptyState() {
    // Only render when no real messages are present. Ignores the card
    // itself if it's already there.
    const realMessages = messagesContainer.querySelector('.message');
    if (!realMessages && !emptyStateEl) {
      renderEmptyState();
    }
  }

  function appendMessage(role, content, isError = false) {
    hideEmptyState();
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

    addMessageActions(div, role === 'assistant' && !isError);
    messagesContainer.appendChild(div);
    virtualizer.observe(div);
    scrollToBottom();
    return div;
  }

  function startAssistantMessage() {
    hideEmptyState();
    currentAssistantText = '';
    lastRenderedLen = 0;
    streamBlockSafeEnd = 0;
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
  // Position past the last confirmed complete structural block (code fence or edit block).
  // findSafeRenderBoundary starts its block regex scans here instead of 0, turning the
  // O(total-text) rescan per chunk into O(new-text-since-last-block).
  let streamBlockSafeEnd = 0;

  /** Find the end position of all "safe" (fully closed) content in the text.
   *  Anything after this position may be a partial code block, partial bold, etc.
   *
   *  Uses streamBlockSafeEnd to scan only the new suffix of the text on each call —
   *  code blocks can't overlap, so any new block must start after the last known
   *  complete one. This turns the naive O(total-text) rescan into O(new-text). */
  function findSafeRenderBoundary(text) {
    let blockSafeEnd = streamBlockSafeEnd;

    // Scan for new complete code blocks starting from the last known safe position.
    const codeBlockRegex = /```[\w.]*:?[^\n]*\n[\s\S]*?```/g;
    codeBlockRegex.lastIndex = streamBlockSafeEnd;
    let m;
    while ((m = codeBlockRegex.exec(text)) !== null) {
      blockSafeEnd = m.index + m[0].length;
    }

    // Scan for new complete edit blocks from the same starting point.
    const editRegex = /<<<SEARCH:[^\n]+\n[\s\S]*?\n===\n[\s\S]*?\n>>>REPLACE/g;
    editRegex.lastIndex = streamBlockSafeEnd;
    while ((m = editRegex.exec(text)) !== null) {
      if (m.index + m[0].length > blockSafeEnd) {
        blockSafeEnd = m.index + m[0].length;
      }
    }

    // Advance the cache — only ever moves forward.
    streamBlockSafeEnd = blockSafeEnd;

    // For text after the last structural block, check for unclosed fences.
    const trailing = text.slice(blockSafeEnd);

    // Fast-path: skip regex when the marker isn't present at all.
    if (trailing.includes('`')) {
      const backtickCount = (trailing.match(/```/g) || []).length;
      if (backtickCount % 2 !== 0) return blockSafeEnd;
    }

    if (trailing.includes('<<<SEARCH:')) {
      const searchCount = (trailing.match(/<<<SEARCH:/g) || []).length;
      const replaceCount = (trailing.match(/>>>REPLACE/g) || []).length;
      if (searchCount > replaceCount) return blockSafeEnd;
    }

    // Find the last complete paragraph boundary in the trailing text.
    const lastBlankLine = trailing.lastIndexOf('\n\n');
    if (lastBlankLine !== -1) return blockSafeEnd + lastBlankLine + 2;

    // If there's a complete line, render up to it rather than a half-typed one.
    const lastNewline = trailing.lastIndexOf('\n');
    if (lastNewline !== -1) return blockSafeEnd + lastNewline + 1;

    return blockSafeEnd;
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
      addMessageActions(currentAssistantDiv, true);

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
    // Fast-path: in a correctly-rendered message every ** pair was already converted
    // to a <strong> element by appendInlineMarkdown, so no text node will contain '**'.
    // textContent concatenation is O(text chars) but avoids the more expensive
    // TreeWalker creation + node traversal in the common case.
    if (!root.textContent.includes('**')) return;

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

  function renderBatchProgressPanel() {
    const panel = document.getElementById('batch-progress-panel');
    const title = document.getElementById('batch-progress-title');
    const countEl = document.getElementById('batch-progress-count');
    const taskEl = document.getElementById('batch-progress-task');
    const list = document.getElementById('batch-progress-list');
    if (!panel || !title || !countEl || !taskEl || !list) return;

    if (!batchProgressState) {
      panel.classList.add('hidden');
      return;
    }

    const { kind, task, items, doneCount, totalCount } = batchProgressState;
    panel.classList.remove('hidden');
    title.textContent = kind === 'facets' ? 'Facets' : 'Forks';
    countEl.textContent = doneCount < totalCount ? `${doneCount}/${totalCount}` : '';
    taskEl.textContent = task.length > 80 ? task.slice(0, 80) + '…' : task;

    list.innerHTML = '';
    list.classList.toggle('facets', kind === 'facets');
    for (const item of items) {
      const el = document.createElement('span');
      el.className = `batch-progress-item bp-${item.status}`;

      const icon = document.createElement('span');
      icon.className = 'bp-icon';
      icon.textContent =
        item.status === 'running' ? '●' : item.status === 'done' ? '✓' : item.status === 'error' ? '✕' : '○';
      el.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'bp-label';
      label.textContent = item.label;
      el.appendChild(label);

      // Facets carry a preferred model — show it as a compact badge so the
      // graphic reads as "which specialist runs on which model".
      if (item.model) {
        const badge = document.createElement('span');
        badge.className = 'bp-model';
        badge.textContent = String(item.model).split('/').pop();
        el.appendChild(badge);
      }

      el.title = `${item.id} — ${item.status}${item.model ? ' · ' + item.model : ''}`;
      list.appendChild(el);
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

  function updateInputPlaceholder() {
    if (steerEnabled) {
      input.placeholder = 'Steer the agent… Enter to nudge, ⌘+Enter to interrupt';
    } else {
      input.placeholder = 'Ask SideCar…';
    }
  }

  function setLoading(loading) {
    isLoading = loading;
    sendBtn.disabled = false;
    updateSendButton();
    if (!loading) {
      steerEnabled = false;
      updateInputPlaceholder();
    }
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

  // Sortable DB result tables — event delegation on messagesContainer.
  // th[data-col] headers toggle asc/desc sort by rebuilding tbody row order.
  messagesContainer.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    const table = th.closest('table');
    if (!table) return;
    const colIdx = parseInt(th.dataset.col, 10);
    const currentSort = th.dataset.sort || '';
    const newSort = currentSort === 'asc' ? 'desc' : 'asc';

    // Reset all header sort indicators
    table.querySelectorAll('th[data-col]').forEach((h) => {
      h.dataset.sort = '';
      const arrow = h.querySelector('span');
      if (arrow) arrow.textContent = ' ⇕';
    });
    th.dataset.sort = newSort;
    const arrow = th.querySelector('span');
    if (arrow) arrow.textContent = newSort === 'asc' ? ' ↑' : ' ↓';

    // Sort tbody rows
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    const rows = Array.from(tbody.querySelectorAll('tr'));
    rows.sort((a, b) => {
      const aCell = a.querySelectorAll('td')[colIdx];
      const bCell = b.querySelectorAll('td')[colIdx];
      const aVal = aCell ? aCell.textContent || '' : '';
      const bVal = bCell ? bCell.textContent || '' : '';
      const aNum = parseFloat(aVal);
      const bNum = parseFloat(bVal);
      const cmp = !isNaN(aNum) && !isNaN(bNum) ? aNum - bNum : aVal.localeCompare(bVal);
      return newSort === 'asc' ? cmp : -cmp;
    });
    rows.forEach((row) => tbody.appendChild(row));
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

  function formatContextLength(n) {
    if (!n || typeof n !== 'number' || n <= 0) return '';
    if (n >= 1000) {
      const k = n / 1024;
      return (k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')) + 'K ctx';
    }
    return n + ' ctx';
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

        const nameRow = document.createElement('span');
        nameRow.className = 'model-name-row';

        const nameText = document.createElement('span');
        nameText.className = 'name-text';
        nameText.textContent = getModelDisplayName(model.name);
        nameRow.appendChild(nameText);

        if (model.installed) {
          nameSpan.classList.add('installed');
          const checkmark = document.createElement('span');
          checkmark.className = 'model-check';
          checkmark.textContent = '\u2713';
          nameRow.appendChild(checkmark);
        } else {
          const badge = document.createElement('span');
          badge.className = 'model-badge';
          badge.textContent = 'not installed';
          nameRow.appendChild(badge);
        }

        nameSpan.appendChild(nameRow);

        const ctxLabel = formatContextLength(model.contextLength);
        if (ctxLabel) {
          const ctxBadge = document.createElement('span');
          ctxBadge.className = 'model-ctx';
          ctxBadge.textContent = ctxLabel;
          nameSpan.appendChild(ctxBadge);
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

        if (model.installed) {
          const deleteBtn = document.createElement('button');
          deleteBtn.textContent = 'Delete';
          deleteBtn.className = 'model-action delete';
          deleteBtn.dataset.model = model.name;
          deleteBtn.dataset.deleteModel = 'true';
          item.appendChild(deleteBtn);
        }

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

        const nameRow = document.createElement('span');
        nameRow.className = 'model-name-row';

        const nameText = document.createElement('span');
        nameText.className = 'name-text';
        nameText.textContent = getModelDisplayName(model.name);
        nameRow.appendChild(nameText);

        if (model.installed) {
          nameSpan.classList.add('installed');
          const checkmark = document.createElement('span');
          checkmark.className = 'model-check';
          checkmark.textContent = '\u2713';
          nameRow.appendChild(checkmark);
        } else {
          const badge = document.createElement('span');
          badge.className = 'model-badge';
          badge.textContent = 'not installed';
          nameRow.appendChild(badge);
        }

        nameSpan.appendChild(nameRow);

        const ctxLabel = formatContextLength(model.contextLength);
        if (ctxLabel) {
          const ctxBadge = document.createElement('span');
          ctxBadge.className = 'model-ctx';
          ctxBadge.textContent = ctxLabel;
          nameSpan.appendChild(ctxBadge);
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

        if (model.installed) {
          const deleteBtn = document.createElement('button');
          deleteBtn.textContent = 'Delete';
          deleteBtn.className = 'model-action delete';
          deleteBtn.dataset.model = model.name;
          deleteBtn.dataset.deleteModel = 'true';
          item.appendChild(deleteBtn);
        }

        modelList.appendChild(item);
      }
    }
  }

  // Event delegation for model action buttons — avoids closure capture of model object
  modelList.addEventListener('click', (e) => {
    const btn = e.target.closest('.model-action');
    if (!btn) return;

    const modelName = btn.dataset.model;
    const isDelete = btn.dataset.deleteModel === 'true';
    const isInstalled = btn.dataset.installed === 'true';

    if (isDelete) {
      vscode.postMessage({ command: 'deleteModel', model: modelName });
    } else if (isInstalled) {
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
        // Clear first so re-sending init (the webviewReady handshake, or a
        // hide/show re-resolve) REPLACES the history instead of appending a
        // duplicate copy.
        messagesContainer.innerHTML = '';
        if (event.data.messages) {
          event.data.messages.forEach((msg, i) => {
            const c = msg.content;
            const text =
              typeof c === 'string'
                ? c
                : Array.isArray(c)
                  ? c
                      .filter((b) => b && b.type === 'text')
                      .map((b) => b.text)
                      .join('\n')
                  : '';
            // Skip the agent's plumbing messages — tool_result entries (role
            // "user", no text) and tool_use-only assistant turns. Rendering them
            // produced empty bubbles that made a restored tool-heavy conversation
            // look broken / like messages were lost.
            if (!text.trim()) return;
            const div = appendMessage(msg.role, text);
            // Keep the rendered bubble's index aligned with state.messages so
            // regenerate/edit (which index directly into state.messages) still
            // target the right message after skipping plumbing entries.
            div.dataset.msgIndex = String(i);
          });
          // Continue the live counter past the restored range so the next new
          // message gets the correct state.messages index.
          messageCounter = event.data.messages.length;
        }
        // After restoring history (or when none exists), show the empty
        // state if the chat is still blank. This is the first-paint path.
        maybeRenderEmptyState();
        break;

      case 'uiSettings':
        applyUiSettings(event.data);
        break;

      case 'setActiveBackendProfile':
        window.__activeBackendProfileId = event.data.activeBackendProfileId ?? null;
        // Re-render the menu if it's currently open so the checkmark
        // moves immediately without needing to close and reopen it.
        if (settingsMenu && !settingsMenu.classList.contains('hidden')) {
          renderBackendProfiles();
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

      // The legacy one-shot 'onboarding' card was replaced by the persistent
      // empty-state welcome (see renderEmptyState below). Kept as a no-op
      // case so older extension builds posting this command don't error.
      case 'onboarding':
        break;

      case 'injectPrompt':
        // Populate the input with a prompt seeded from the extension
        // (e.g. the CI-failure "send to agent" flow). Auto-resize the
        // textarea and focus so the user can review + press Enter.
        if (typeof content === 'string') {
          input.value = content;
          input.style.height = 'auto';
          input.style.height = Math.min(input.scrollHeight, 300) + 'px';
          input.focus();
        }
        break;

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

      case 'finalizeAssistantMessage':
        finishAssistantMessage();
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

      case 'contextFill': {
        const cbWrap = document.getElementById('context-bar-wrap');
        const cbBar = document.getElementById('context-bar');
        if (cbWrap && cbBar && msg.contextTotal > 0) {
          const pct = Math.min(100, (msg.contextUsed / msg.contextTotal) * 100);
          cbBar.style.width = pct + '%';
          cbBar.classList.toggle('ctx-warn', pct >= 60 && pct < 80);
          cbBar.classList.toggle('ctx-danger', pct >= 80);
          const usedK = msg.contextUsed >= 1000 ? `${Math.round(msg.contextUsed / 1000)}K` : msg.contextUsed;
          const totalK = msg.contextTotal >= 1000 ? `${Math.round(msg.contextTotal / 1000)}K` : msg.contextTotal;
          cbWrap.title = `Context: ${usedK} / ${totalK} tokens (${Math.round(pct)}%)`;
          cbWrap.classList.remove('hidden');
        }
        break;
      }

      case 'steerQueueUpdate': {
        steerEnabled = !!msg.steerEnabled;
        steerItems = Array.isArray(msg.steerQueue) ? msg.steerQueue : [];
        // Edit cursor becomes stale if the item was cancelled/drained.
        if (editingSteerId && !steerItems.some((s) => s.id === editingSteerId)) {
          editingSteerId = null;
        }
        updateInputPlaceholder();
        renderSteerStrip();
        break;
      }

      case 'editPlanCard': {
        if (msg.editPlan && Array.isArray(msg.editPlan.edits)) {
          renderEditPlanCard(msg.editPlan.edits);
          scrollToBottom();
        }
        break;
      }

      case 'editPlanProgress': {
        applyEditPlanProgress(msg.editProgress);
        break;
      }

      case 'resumeAvailable': {
        // Inline button in transcript — "moment-of-failure" discovery.
        const resumeBtn = document.createElement('button');
        resumeBtn.className = 'resume-button';
        resumeBtn.textContent = '▶ Resume';
        resumeBtn.title = 'Continue from where the response was cut off';
        resumeBtn.addEventListener('click', () => {
          vscode.postMessage({ command: 'resume' });
          resumeBtn.disabled = true;
          resumeBtn.textContent = 'Resuming...';
        });
        const resumeWrapper = document.createElement('div');
        resumeWrapper.style.padding = '8px 0';
        resumeWrapper.appendChild(resumeBtn);
        messagesContainer.appendChild(resumeWrapper);
        scrollToBottom();
        // Persistent strip above the input — "I've scrolled away"
        // recovery path (v0.65 chunk 7b). Carries the stashed steer
        // count so the user knows queued intent will ride along.
        resumePendingSteerCount = typeof msg.steerCount === 'number' ? msg.steerCount : 0;
        renderResumeStrip();
        break;
      }

      case 'done': {
        finishAssistantMessage();
        // Resync the message-index counter to the extension's authoritative
        // transcript length. A turn appends assistant + tool entries (and
        // transient status bubbles) this side never counted, so without this
        // the next user bubble's msgIndex drifts and delete/edit would target
        // the wrong entry in state.messages.
        if (typeof event.data.messageCount === 'number') {
          messageCounter = event.data.messageCount;
        }
        setLoading(false);
        toolOutputChars.clear();
        toolFullOutput.clear();
        userScrolledUp = false;
        // Clear the persistent resume strip — a successful completion
        // (normal or post-resume) means there's nothing to resume.
        hideResumeStrip();
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
        // Append bulk Accept / Revert All actions to the active edit-plan card.
        if (activeEditPlanCard && editPlanDonePaths.size > 0) {
          const actions = document.createElement('div');
          actions.className = 'edit-plan-bulk-actions';

          const keepBtn = document.createElement('button');
          keepBtn.className = 'edit-plan-bulk-keep';
          keepBtn.textContent = 'Keep All';
          keepBtn.addEventListener('click', () => {
            actions.remove();
            activeEditPlanCard = null;
          });

          const revertAllBtn = document.createElement('button');
          revertAllBtn.className = 'edit-plan-bulk-revert';
          revertAllBtn.textContent = 'Revert All';
          revertAllBtn.addEventListener('click', () => {
            revertAllBtn.disabled = true;
            revertAllBtn.textContent = 'Reverting…';
            for (const p of editPlanDonePaths) {
              const op = editPlanOps.get(p) || 'edit';
              vscode.postMessage({ command: 'rejectEditPlanFile', filePath: p, op });
            }
            // Disable all per-row revert buttons too
            for (const btn of activeEditPlanCard.querySelectorAll('.edit-plan-revert-btn')) {
              btn.disabled = true;
            }
            keepBtn.disabled = true;
            revertAllBtn.textContent = 'Reverted';
          });

          actions.appendChild(keepBtn);
          actions.appendChild(revertAllBtn);
          activeEditPlanCard.appendChild(actions);
          scrollToBottom();
        }
        break;
      }

      case 'suggestNextSteps': {
        const suggestions = msg.suggestions || [];
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
              vscode.postMessage({ command: 'userMessage', text });
            });
            container.appendChild(btn);
          }
          messagesContainer.appendChild(container);
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
        emptyStateEl = null; // innerHTML wipe already detached it
        // New conversation — any stashed resume-state is stale.
        hideResumeStrip();
        document.getElementById('context-bar-wrap')?.classList.add('hidden');
        maybeRenderEmptyState();
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

      case 'batchProgress': {
        const bp = event.data.batchProgress;
        if (bp) {
          batchProgressState = bp;
          renderBatchProgressPanel();
          // Auto-clear the panel 3s after all items finish.
          if (bp.doneCount >= bp.totalCount) {
            setTimeout(() => {
              if (batchProgressState && batchProgressState.doneCount >= batchProgressState.totalCount) {
                batchProgressState = null;
                renderBatchProgressPanel();
              }
            }, 3000);
          }
        }
        break;
      }

      case 'autoModeTaskUpdate': {
        const t = event.data.autoModeTask;
        if (!t) break;
        if (t.status === 'running') {
          autoModeCurrent = { taskN: t.taskN, total: t.total, text: t.text };
        } else {
          // Task finished — move to history, clear current if same text
          autoModeHistory.push({ text: t.text, status: t.status, errorMessage: t.errorMessage });
          if (autoModeCurrent && autoModeCurrent.text === t.text) autoModeCurrent = null;
        }
        if (autoModeDismissTimer) {
          clearTimeout(autoModeDismissTimer);
          autoModeDismissTimer = null;
        }
        renderAutoModeStrip();
        break;
      }

      case 'autoModeDone': {
        const r = event.data.autoModeResult;
        autoModeCurrent = null;
        // Append a summary entry to history
        if (r) {
          const label =
            r.stoppedReason === 'completed'
              ? `Session complete — ${r.tasksSucceeded} done`
              : `Session stopped (${r.stoppedReason}) — ${r.tasksSucceeded} done, ${r.tasksFailed} failed`;
          autoModeHistory.push({ text: label, status: 'done' });
        }
        renderAutoModeStrip();
        // Auto-dismiss after 8 s if user hasn't interacted
        autoModeDismissTimer = setTimeout(() => {
          autoModeHistory = [];
          autoModeCurrent = null;
          autoModeDismissTimer = null;
          renderAutoModeStrip();
        }, 8000);
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
        if (event.data.diffBlock) {
          const diffPre = document.createElement('pre');
          diffPre.className = 'confirm-diff-block';
          for (const line of event.data.diffBlock.split('\n')) {
            const span = document.createElement('span');
            span.textContent = line + '\n';
            if (line.startsWith('+') && !line.startsWith('+++')) span.className = 'diff-add';
            else if (line.startsWith('-') && !line.startsWith('---')) span.className = 'diff-del';
            else if (line.startsWith('@@')) span.className = 'diff-hunk';
            diffPre.appendChild(span);
          }
          confirmCard.appendChild(diffPre);
        }
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

        // Free-text answer row when custom responses are allowed. Without this
        // a clarify with no preset options was a dead end (no way to reply).
        if (allowCustom) {
          const customRow = document.createElement('div');
          customRow.className = 'clarify-custom';
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'clarify-custom-input';
          input.placeholder = options.length > 0 ? 'Or type your own answer…' : 'Type your answer…';
          const submit = document.createElement('button');
          submit.className = 'clarify-custom-submit';
          submit.textContent = 'Send';
          const submitCustom = () => {
            const value = input.value.trim();
            if (value) sendResponse(value);
          };
          submit.addEventListener('click', submitCustom);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submitCustom();
            }
          });
          customRow.appendChild(input);
          customRow.appendChild(submit);
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
            const toolKey = toolIdForOutput || activeToolForOutput.getAttribute('data-tool-id') || '_last';
            const prevChars = toolOutputChars.get(toolKey) || 0;
            const incoming = event.data.content || '';

            // Accumulate full plain-text output for all non-diff chunks so
            // "Show all" can expand in-place without an extension round-trip.
            if (!event.data.isDiff) {
              toolFullOutput.set(toolKey, (toolFullOutput.get(toolKey) || '') + incoming);
            }

            if (prevChars >= MAX_TOOL_OUTPUT_CHARS) {
              // Already truncated — just tally chars for the final badge
              toolOutputChars.set(toolKey, prevChars + incoming.length);
            } else if (event.data.isDiff) {
              const pre = document.createElement('pre');
              pre.className = 'tool-diff-patch';
              for (const line of incoming.split('\n')) {
                const span = document.createElement('span');
                if (line.startsWith('+') && !line.startsWith('+++')) {
                  span.className = 'diff-add';
                } else if (line.startsWith('-') && !line.startsWith('---')) {
                  span.className = 'diff-del';
                } else if (line.startsWith('@@')) {
                  span.className = 'diff-hunk';
                } else {
                  span.className = 'diff-ctx';
                }
                span.textContent = line + '\n';
                pre.appendChild(span);
              }
              body.appendChild(pre);
              toolOutputChars.set(toolKey, prevChars + incoming.length);
            } else {
              const remaining = MAX_TOOL_OUTPUT_CHARS - prevChars;
              if (incoming.length <= remaining) {
                body.textContent += incoming;
              } else {
                body.textContent += incoming.slice(0, remaining);
                body.dataset.truncated = 'true';
              }
              toolOutputChars.set(toolKey, prevChars + incoming.length);
            }
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

            // Copy button — copies full body text to clipboard
            const copyToolBtn = document.createElement('button');
            copyToolBtn.className = 'tool-copy-btn';
            copyToolBtn.textContent = 'Copy';
            copyToolBtn.title = 'Copy tool output to clipboard';
            copyToolBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              e.preventDefault();
              const bodyEl = matchedTool.querySelector('.tool-call-body');
              const fullText = bodyEl ? (bodyEl.textContent || '') + (bodyEl.dataset.fullOutput || '') : text;
              navigator.clipboard.writeText(fullText.trim()).then(() => {
                copyToolBtn.textContent = '✓';
                setTimeout(() => (copyToolBtn.textContent = 'Copy'), 1500);
              });
            });
            matchedSummary.appendChild(copyToolBtn);
          }

          // Append result output to the tool call body
          if (text) {
            const matchedBody = matchedTool.querySelector('.tool-call-body');
            if (matchedBody) {
              // Check if result is rendered HTML (viz, chart, or db table)
              if (
                text.trim().startsWith('<') &&
                (text.includes('sidecar-viz') ||
                  text.includes('sidecar-db-result') ||
                  text.includes('xmlns="http://www.w3.org/2000/svg"'))
              ) {
                const vizContainer = document.createElement('div');
                vizContainer.className = 'tool-result-viz';
                vizContainer.innerHTML = text;
                matchedBody.appendChild(vizContainer);
              } else {
                matchedBody.textContent += '\n' + text;
              }
            }
          }

          if (isError) {
            matchedTool.classList.add('error');
          } else {
            // Auto-collapse successful tool calls after a short delay so the
            // chat doesn't become an endless wall of expanded output blocks.
            setTimeout(() => {
              if (matchedTool && !matchedTool.classList.contains('error')) {
                matchedTool.open = false;
              }
            }, 800);
          }

          // Show truncation notice if output was cut
          const toolKey = resultToolId || matchedTool.getAttribute('data-tool-id') || '_last';
          const totalChars = toolOutputChars.get(toolKey) || 0;
          const matchedBody2 = matchedTool.querySelector('.tool-call-body');
          if (matchedBody2 && matchedBody2.dataset.truncated === 'true' && totalChars > MAX_TOOL_OUTPUT_CHARS) {
            const hidden = totalChars - MAX_TOOL_OUTPUT_CHARS;
            const fullText = toolFullOutput.get(toolKey) || null;
            const notice = document.createElement('div');
            notice.className = 'tool-truncation-notice';
            notice.innerHTML =
              '<span>▸ ' +
              hidden.toLocaleString() +
              ' more chars hidden</span>' +
              '<button class="tool-show-more-btn">Show all</button>';
            notice.querySelector('.tool-show-more-btn').addEventListener('click', () => {
              if (fullText !== null) {
                matchedBody2.textContent = fullText;
                notice.remove();
              }
            });
            matchedBody2.appendChild(notice);
            toolOutputChars.delete(toolKey);
            toolFullOutput.delete(toolKey);
          } else {
            toolOutputChars.delete(toolKey);
            toolFullOutput.delete(toolKey);
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
          // Check if result is rendered HTML (viz, chart, or db table)
          if (
            text.trim().startsWith('<') &&
            (text.includes('sidecar-viz') ||
              text.includes('sidecar-db-result') ||
              text.includes('xmlns="http://www.w3.org/2000/svg"'))
          ) {
            const vizBody = document.createElement('div');
            vizBody.className = 'tool-result-body tool-result-viz';
            vizBody.innerHTML = text;
            details.appendChild(vizBody);
          } else {
            const body = document.createElement('pre');
            body.className = 'tool-result-body';
            body.textContent = text;
            details.appendChild(body);
          }
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
        if (ollamaActions) {
          ollamaActions.classList.toggle('hidden', !event.data.isLocalOllama);
        }
        break;

      case 'setCurrentModel': {
        const full = event.data.currentModel || '';
        const shortened = full ? getModelDisplayName(full).replace(/\.(gguf|safetensors)$/i, '') : '';
        modelName.textContent = shortened || 'Select Model';
        modelName.title = full || 'Select Model';
        window.currentModel = full;
        window.currentModelSupportsTools = event.data.supportsTools !== false;
        updateChatOnlyBadge();
        modelPanel.classList.add('hidden');
        // If the empty state is showing, re-render so the model line
        // reflects the new backend immediately.
        if (emptyStateEl) renderEmptyState();
        break;
      }

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

      case 'threadSwitched': {
        appendMessage('assistant', content || 'Switched thread.');
        break;
      }

      case 'installProgress':
        installingModel = event.data.modelName;
        installProgress.classList.remove('hidden');
        installText.textContent =
          'Installing ' + event.data.modelName + (event.data.progress ? ': ' + event.data.progress : '...');
        if (event.data.percent !== undefined) {
          installBar.classList.remove('indeterminate');
          installBar.style.width = event.data.percent + '%';
        } else {
          installBar.classList.add('indeterminate');
          installBar.style.width = '';
        }
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

      case 'activeFileChanged':
        currentActiveFile = event.data.fileName
          ? { fileName: event.data.fileName, filePath: event.data.filePath || event.data.fileName }
          : null;
        renderActiveFileBar();
        break;

      case 'fileCompletionList': {
        const paths = event.data.completionFiles || [];
        atAcFiles = paths.map((p) => {
          const parts = p.replace(/\\/g, '/').split('/');
          const label = parts[parts.length - 1];
          const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
          return { label, dir, fullPath: p };
        });
        // Now that files are loaded, re-trigger the autocomplete if @ is still active
        updateAtAutocomplete();
        break;
      }

      case 'fileAttached':
        pendingFiles.push({ fileName: event.data.fileName, fileContent: event.data.fileContent });
        renderPendingFiles();
        break;

      case 'filesAttached':
        if (Array.isArray(event.data.files)) {
          for (const f of event.data.files) {
            pendingFiles.push({ fileName: f.fileName, fileContent: f.fileContent });
          }
          renderPendingFiles();
        }
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
            } else if (msg.errorActionCommand === 'compactContext') {
              actionBtn.textContent = 'Compacting...';
              actionBtn.disabled = true;
              vscode.postMessage({ command: 'compactContext' });
            } else if (msg.errorActionCommand === 'retry') {
              const lastUser = [...messagesContainer.querySelectorAll('.message.user')].pop();
              if (lastUser) {
                vscode.postMessage({ command: 'userMessage', text: lastUser.textContent || '' });
              }
            } else if (msg.errorType === 'model' && msg.errorModel) {
              actionBtn.textContent = 'Installing...';
              actionBtn.disabled = true;
              vscode.postMessage({ command: 'installModel', model: msg.errorModel });
            }
          });
          actionsRow.appendChild(actionBtn);
          // Connection errors: primary button opens Settings; also offer Retry so
          // the user can attempt again after fixing the config without retyping.
          if (msg.errorType === 'connection') {
            const retryBtn = document.createElement('button');
            retryBtn.className = 'error-action-btn';
            retryBtn.textContent = 'Retry';
            retryBtn.addEventListener('click', () => {
              const lastUser = [...messagesContainer.querySelectorAll('.message.user')].pop();
              if (lastUser) {
                vscode.postMessage({ command: 'userMessage', text: lastUser.textContent || '' });
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

      case 'voiceResult': {
        if (micBtn) {
          micBtn.textContent = '🎤';
          micBtn.disabled = false;
          micBtn.title = 'Voice input';
          micBtn.classList.remove('mic-recording', 'mic-processing');
        }
        if (typeof event.data.voiceText === 'string' && event.data.voiceText.trim()) {
          input.value = event.data.voiceText;
          input.style.height = 'auto';
          input.style.height = Math.min(input.scrollHeight, 300) + 'px';
          input.focus();
        } else if (event.data.voiceError) {
          const errDiv = document.createElement('div');
          errDiv.className = 'message assistant';
          errDiv.textContent = '⚠️ Voice error: ' + event.data.voiceError;
          messagesContainer.appendChild(errDiv);
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
        break;
      }

      case 'regenSectionResult': {
        const { msgIndex: regenMsgIdx, originalText: origText, newText } = event.data;
        if (typeof regenMsgIdx !== 'number' || !origText || !newText) break;
        const targetDiv = messagesContainer.querySelector(`.message.assistant[data-msg-index="${regenMsgIdx}"]`);
        if (!targetDiv) break;
        // Replace inside raw markdown, then re-render
        const raw = targetDiv.dataset.rawContent || '';
        const updated = raw.includes(origText) ? raw.replace(origText, newText) : raw + '\n\n' + newText;
        targetDiv.dataset.rawContent = updated;
        // Re-render the content area (keep action buttons)
        const existingActions = targetDiv.querySelector('.message-actions');
        targetDiv.innerHTML = '';
        targetDiv.appendChild(renderContent(updated, window.currentModelSupportsTools));
        postProcessMarkdown(targetDiv);
        if (existingActions) targetDiv.appendChild(existingActions);
        else addMessageActions(targetDiv, true);
        // Remove pending highlight if any
        targetDiv.querySelectorAll('.regen-pending').forEach((el) => el.classList.remove('regen-pending'));
        break;
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Selective regeneration bar
  // ---------------------------------------------------------------------------

  const regenBar = document.getElementById('regen-bar');
  const regenInstruction = document.getElementById('regen-instruction');
  const regenSubmitBtn = document.getElementById('regen-submit-btn');
  const regenDismissBtn = document.getElementById('regen-dismiss-btn');

  // Track the current selection: text + the assistant message div it lives in
  let regenSelectedText = '';
  let regenMsgDiv = null;
  let regenSelectionTimeout = null;

  document.addEventListener('selectionchange', () => {
    clearTimeout(regenSelectionTimeout);
    regenSelectionTimeout = setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        // Don't hide immediately — user may have clicked into the instruction input
        return;
      }
      const text = sel.toString().trim();
      // Only activate when the selection is inside an assistant message
      const range = sel.getRangeAt(0);
      const msgDiv =
        range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
          ? range.commonAncestorContainer.closest('.message.assistant')
          : range.commonAncestorContainer.parentElement?.closest('.message.assistant');
      if (!msgDiv) return;
      regenSelectedText = text;
      regenMsgDiv = msgDiv;
      regenBar.classList.remove('hidden');
      regenInstruction.value = '';
    }, 120);
  });

  regenDismissBtn.addEventListener('click', () => {
    regenBar.classList.add('hidden');
    regenSelectedText = '';
    regenMsgDiv = null;
    window.getSelection()?.removeAllRanges();
  });

  regenSubmitBtn.addEventListener('click', submitRegen);
  regenInstruction.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitRegen();
    }
    if (e.key === 'Escape') regenDismissBtn.click();
  });

  function submitRegen() {
    if (!regenSelectedText || !regenMsgDiv) return;
    const instruction = regenInstruction.value.trim();
    const msgIndex = parseInt(regenMsgDiv.dataset.msgIndex, 10);
    if (isNaN(msgIndex)) return;

    // Visual pending state
    regenSubmitBtn.disabled = true;
    regenSubmitBtn.textContent = '…';

    vscode.postMessage({
      command: 'regenSection',
      selectedText: regenSelectedText,
      instruction,
      msgIndex,
    });

    // Hide the bar immediately after submit (result arrives asynchronously)
    regenBar.classList.add('hidden');
    regenSelectedText = '';
    regenMsgDiv = null;
    window.getSelection()?.removeAllRanges();
    setTimeout(() => {
      regenSubmitBtn.disabled = false;
      regenSubmitBtn.textContent = 'Regenerate';
    }, 800);
  }

  // Tell the extension the webview is live and listening. The extension posts the
  // chat-history `init` in resolveWebviewView, which on a window reload races the
  // webview load and gets dropped — so the restored conversation never rendered
  // (looked like the chat didn't persist). The extension (re)sends init in
  // response to this, after the message listener above is registered.
  vscode.postMessage({ command: 'webviewReady' });
})();
