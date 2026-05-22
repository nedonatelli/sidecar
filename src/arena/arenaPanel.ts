import * as vscode from 'vscode';
import type { SideCarClient } from '../ollama/client.js';
import type { StreamEvent } from '../ollama/types.js';
import type { EloStore } from './eloStore.js';
import type { ArenaToPanel, PanelToArena } from './types.js';

// ---------------------------------------------------------------------------
// ArenaPanel — side-by-side model comparison webview.
//
// One WebviewPanel per VS Code window. Hosts N columns (2–4 models) that
// stream responses in parallel for the same user prompt. Vote buttons
// record ELO wins via the injected EloStore. Multi-turn: after a vote
// the prompt bar is re-enabled for the next round.
// ---------------------------------------------------------------------------

export class ArenaPanel {
  static readonly viewType = 'sidecar.arenaPanel';
  private static current: ArenaPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  /** Models for the current session (may change via changeModels). */
  private models: string[] = [];
  /** Abort controller for any in-flight fan-out. */
  private abortController: AbortController | undefined;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly client: SideCarClient,
    private readonly eloStore: EloStore,
    private readonly onChangeModels: () => Promise<string[] | undefined>,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage(
      async (msg: PanelToArena) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static create(
    context: vscode.ExtensionContext,
    client: SideCarClient,
    eloStore: EloStore,
    initialModels: string[],
    onChangeModels: () => Promise<string[] | undefined>,
  ): ArenaPanel {
    if (ArenaPanel.current) {
      ArenaPanel.current.panel.reveal(vscode.ViewColumn.One);
      ArenaPanel.current.updateModels(initialModels);
      return ArenaPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(ArenaPanel.viewType, 'SideCar Arena', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    });

    ArenaPanel.current = new ArenaPanel(panel, client, eloStore, onChangeModels);
    ArenaPanel.current.updateModels(initialModels);
    return ArenaPanel.current;
  }

  updateModels(models: string[]): void {
    this.models = models;
    this.postMessage({
      command: 'init',
      models,
      ratings: this.eloStore.getRatings(),
      stats: this.eloStore.getState(),
    });
  }

  private async handleMessage(msg: PanelToArena): Promise<void> {
    switch (msg.command) {
      case 'ready':
        this.postMessage({
          command: 'init',
          models: this.models,
          ratings: this.eloStore.getRatings(),
          stats: this.eloStore.getState(),
        });
        break;

      case 'startChat':
        await this.runChatSession(msg.models, msg.prompt);
        break;

      case 'vote':
        await this.handleVote(msg.winnerIndex);
        break;

      case 'changeModels': {
        const next = await this.onChangeModels();
        if (next && next.length >= 2) this.updateModels(next);
        break;
      }

      case 'startAgent':
        // Agent mode: delegate to external command — the panel fires this
        // message and the command handler (arenaCommands.ts) handles the
        // fork dispatch + review. The panel just records the vote afterward
        // via a separate `vote` message from the fork review outcome.
        await vscode.commands.executeCommand('sidecar.arena.agent', {
          models: msg.models,
          task: msg.task,
        });
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Chat fan-out
  // ---------------------------------------------------------------------------

  private currentLaneModels: string[] = [];

  private async runChatSession(models: string[], prompt: string): Promise<void> {
    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    this.currentLaneModels = models;
    const lanes = models.map((model, i) => ({
      model,
      label: model,
      elo: this.eloStore.getRating(model),
      index: i,
    }));

    this.postMessage({ command: 'sessionStart', lanes });

    // Fan out to all models in parallel — each lane streams independently.
    const lanePromises = lanes.map(({ model, index }) => this.streamLane(index, model, prompt, signal));

    // We fire-and-forget the fan-out — errors per lane are already
    // reported via `laneError` messages so the UI handles them inline.
    await Promise.allSettled(lanePromises);
  }

  private async streamLane(laneIndex: number, model: string, prompt: string, signal: AbortSignal): Promise<void> {
    const messages = [{ role: 'user' as const, content: prompt }];
    try {
      for await (const event of this.client.streamChat(
        messages,
        signal,
        undefined,
        undefined,
        model,
      ) as AsyncIterable<StreamEvent>) {
        if (signal.aborted) break;
        if (event.type === 'text') {
          this.postMessage({ command: 'chunk', laneIndex, text: event.text });
        }
      }
      this.postMessage({ command: 'laneDone', laneIndex });
    } catch (err) {
      if (signal.aborted) {
        this.postMessage({ command: 'laneDone', laneIndex });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.postMessage({ command: 'laneError', laneIndex, error: msg });
    }
  }

  // ---------------------------------------------------------------------------
  // Voting
  // ---------------------------------------------------------------------------

  private async handleVote(winnerIndex: number): Promise<void> {
    const winner = this.currentLaneModels[winnerIndex];
    if (!winner) return;
    const losers = this.currentLaneModels.filter((_, i) => i !== winnerIndex);
    await this.eloStore.recordWin(winner, losers);
    this.postMessage({
      command: 'eloUpdate',
      ratings: this.eloStore.getRatings(),
      stats: this.eloStore.getState(),
    });
  }

  // ---------------------------------------------------------------------------
  // HTML / CSS / JS
  // ---------------------------------------------------------------------------

  private postMessage(msg: ArenaToPanel): void {
    void this.panel.webview.postMessage(msg);
  }

  private buildHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SideCar Arena</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  /* ── Toolbar ── */
  #toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  #toolbar .title {
    font-weight: 600;
    font-size: 13px;
    margin-right: 4px;
    color: var(--vscode-foreground);
  }
  #toolbar button {
    padding: 3px 10px;
    border-radius: 3px;
    border: 1px solid var(--vscode-button-secondaryBorder, #555);
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
    font-size: 12px;
    cursor: pointer;
  }
  #toolbar button:hover { filter: brightness(1.15); }
  #toolbar button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: transparent;
  }
  #mode-indicator {
    margin-left: auto;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  /* ── Model pills ── */
  #model-pills { display: flex; flex-wrap: wrap; gap: 6px; }
  .model-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--vscode-badge-background, #3a3d41);
    color: var(--vscode-badge-foreground, #fff);
    font-size: 11px;
    font-weight: 500;
  }
  .model-pill .elo { opacity: 0.7; font-size: 10px; }

  /* ── Lane grid ── */
  #lanes {
    display: flex;
    flex: 1;
    overflow: hidden;
    gap: 1px;
    background: var(--vscode-panel-border, #333);
  }
  .lane {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--vscode-editor-background);
    min-width: 0;
  }
  .lane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    background: var(--vscode-sideBar-background, #252526);
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    flex-shrink: 0;
  }
  .lane-model-name {
    font-size: 12px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lane-elo {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    margin-left: 6px;
  }
  .lane-status {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    margin-left: 6px;
  }
  .lane-response {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px;
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .lane-response.error { color: var(--vscode-errorForeground); }
  .lane-footer {
    display: flex;
    justify-content: center;
    padding: 6px;
    border-top: 1px solid var(--vscode-panel-border, #333);
    flex-shrink: 0;
  }
  .vote-btn {
    padding: 4px 18px;
    border-radius: 4px;
    border: 1px solid var(--vscode-button-secondaryBorder, #555);
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .vote-btn:hover:not(:disabled) {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: transparent;
  }
  .vote-btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .vote-btn.winner {
    background: #1a7f37;
    color: #fff;
    border-color: transparent;
  }

  /* ── Spinner animation ── */
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner {
    display: inline-block;
    width: 10px; height: 10px;
    border: 2px solid var(--vscode-foreground);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-right: 4px;
    vertical-align: middle;
  }

  /* ── Prompt bar ── */
  #prompt-bar {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 8px 12px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-top: 1px solid var(--vscode-panel-border, #444);
    flex-shrink: 0;
  }
  #prompt-input {
    flex: 1;
    min-height: 32px;
    max-height: 120px;
    padding: 5px 8px;
    border-radius: 4px;
    border: 1px solid var(--vscode-input-border, #555);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: inherit;
    font-size: 13px;
    resize: vertical;
    outline: none;
  }
  #prompt-input:focus { border-color: var(--vscode-focusBorder); }
  #send-btn {
    padding: 5px 16px;
    border-radius: 4px;
    border: none;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font-size: 13px;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }
  #send-btn:disabled { opacity: 0.45; cursor: not-allowed; }

  /* ── ELO leaderboard ── */
  #leaderboard {
    padding: 6px 12px 4px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-top: 1px solid var(--vscode-panel-border, #333);
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    flex-shrink: 0;
  }
  .lb-entry { display: flex; gap: 4px; }
  .lb-model { font-weight: 500; color: var(--vscode-foreground); }
  .lb-score { }
  .lb-record { opacity: 0.7; }

  /* ── Empty state ── */
  #empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--vscode-descriptionForeground);
    gap: 8px;
    font-size: 13px;
  }
  #empty-state h2 { font-size: 18px; color: var(--vscode-foreground); margin-bottom: 4px; }
</style>
</head>
<body>
<div id="toolbar">
  <span class="title">⚔ Arena</span>
  <div id="model-pills"></div>
  <button id="change-models-btn">Change models</button>
  <span id="mode-indicator"></span>
</div>

<div id="lanes">
  <div id="empty-state">
    <h2>Model Arena</h2>
    <p>Select models and type a prompt to compare responses side-by-side.</p>
  </div>
</div>

<div id="leaderboard"></div>

<div id="prompt-bar">
  <textarea id="prompt-input" placeholder="Type a prompt and press Send…" rows="1"></textarea>
  <button id="send-btn">Send</button>
</div>

<script>
const vscode = acquireVsCodeApi();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let models = [];
let ratings = {};
let stats = { wins: {}, losses: {}, totalMatches: 0 };
let laneStates = []; // { text, done, error, voted }
let sessionActive = false;
let votedThisRound = false;
let winnerIndex = -1;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $lanes = document.getElementById('lanes');
const $pills = document.getElementById('model-pills');
const $prompt = document.getElementById('prompt-input');
const $send = document.getElementById('send-btn');
const $leaderboard = document.getElementById('leaderboard');
const $emptyState = document.getElementById('empty-state');
const $modeIndicator = document.getElementById('mode-indicator');

function elo(model) { return ratings[model] ?? 1200; }

// ---------------------------------------------------------------------------
// Render pills
// ---------------------------------------------------------------------------
function renderPills() {
  $pills.innerHTML = models
    .map(m => \`<span class="model-pill">\${escHtml(shortLabel(m))} <span class="elo">\${elo(m)}</span></span>\`)
    .join('');
}

// ---------------------------------------------------------------------------
// Render leaderboard
// ---------------------------------------------------------------------------
function renderLeaderboard() {
  const all = Object.entries(ratings)
    .sort(([,a],[,b]) => b - a)
    .slice(0, 8);
  if (all.length === 0) { $leaderboard.innerHTML = ''; return; }
  $leaderboard.innerHTML = '<span style="opacity:.6;margin-right:4px">ELO:</span>' +
    all.map(([m, r]) => {
      const w = (stats.wins || {})[m] ?? 0;
      const l = (stats.losses || {})[m] ?? 0;
      return \`<span class="lb-entry"><span class="lb-model">\${escHtml(shortLabel(m))}</span><span class="lb-score">\${r}</span><span class="lb-record">(\${w}W \${l}L)</span></span>\`;
    }).join('');
}

// ---------------------------------------------------------------------------
// Build N-column lane grid
// ---------------------------------------------------------------------------
function buildLanes(lanes) {
  $emptyState.remove(); // Remove placeholder if present
  $lanes.innerHTML = '';
  laneStates = lanes.map(() => ({ text: '', done: false, error: false }));
  votedThisRound = false;
  winnerIndex = -1;

  lanes.forEach(({ model, label, elo: eloVal }, i) => {
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.id = 'lane-' + i;
    lane.innerHTML = \`
      <div class="lane-header">
        <span class="lane-model-name" title="\${escHtml(model)}">\${escHtml(shortLabel(model))}</span>
        <span class="lane-elo">\${eloVal}</span>
        <span class="lane-status" id="status-\${i}"><span class="spinner"></span></span>
      </div>
      <div class="lane-response" id="resp-\${i}"></div>
      <div class="lane-footer">
        <button class="vote-btn" id="vote-\${i}" onclick="vote(\${i})" disabled>👑 Best</button>
      </div>
    \`;
    $lanes.appendChild(lane);
  });
}

// ---------------------------------------------------------------------------
// Streaming updates
// ---------------------------------------------------------------------------
function appendChunk(laneIndex, text) {
  laneStates[laneIndex].text += text;
  const el = document.getElementById('resp-' + laneIndex);
  if (el) {
    el.textContent = laneStates[laneIndex].text;
    el.scrollTop = el.scrollHeight;
  }
  // Enable vote buttons as soon as any lane has content
  if (!votedThisRound) enableVoteButtons();
}

function markDone(laneIndex) {
  laneStates[laneIndex].done = true;
  const statusEl = document.getElementById('status-' + laneIndex);
  if (statusEl) statusEl.innerHTML = '✓';
  checkAllDone();
}

function markError(laneIndex, error) {
  laneStates[laneIndex].done = true;
  laneStates[laneIndex].error = true;
  const el = document.getElementById('resp-' + laneIndex);
  if (el) { el.textContent = '⚠ ' + error; el.classList.add('error'); }
  const statusEl = document.getElementById('status-' + laneIndex);
  if (statusEl) statusEl.innerHTML = '✗';
  checkAllDone();
}

function checkAllDone() {
  if (laneStates.every(s => s.done) && !votedThisRound) enableVoteButtons();
}

function enableVoteButtons() {
  for (let i = 0; i < laneStates.length; i++) {
    const btn = document.getElementById('vote-' + i);
    if (btn && !laneStates[i].error) btn.disabled = false;
  }
}

function vote(index) {
  if (votedThisRound) return;
  votedThisRound = true;
  winnerIndex = index;

  // Visual feedback
  for (let i = 0; i < laneStates.length; i++) {
    const btn = document.getElementById('vote-' + i);
    if (!btn) continue;
    btn.disabled = true;
    if (i === index) { btn.textContent = '👑 Winner'; btn.classList.add('winner'); }
  }

  // Re-enable prompt bar for next round
  setSessionActive(false);
  $prompt.focus();

  vscode.postMessage({ command: 'vote', winnerIndex: index });
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------
$send.addEventListener('click', sendPrompt);
$prompt.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
});

function sendPrompt() {
  const text = $prompt.value.trim();
  if (!text || sessionActive || models.length < 2) return;
  setSessionActive(true);
  $prompt.value = '';
  vscode.postMessage({ command: 'startChat', models, prompt: text });
}

document.getElementById('change-models-btn').addEventListener('click', () => {
  vscode.postMessage({ command: 'changeModels' });
});

function setSessionActive(active) {
  sessionActive = active;
  $send.disabled = active;
  $prompt.disabled = active;
}

// ---------------------------------------------------------------------------
// Incoming messages from extension
// ---------------------------------------------------------------------------
window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.command) {
    case 'init':
      models = msg.models;
      ratings = msg.ratings || {};
      stats = msg.stats || { wins: {}, losses: {}, totalMatches: 0 };
      renderPills();
      renderLeaderboard();
      break;

    case 'sessionStart':
      buildLanes(msg.lanes);
      setSessionActive(true);
      break;

    case 'chunk':
      appendChunk(msg.laneIndex, msg.text);
      break;

    case 'laneDone':
      markDone(msg.laneIndex);
      break;

    case 'laneError':
      markError(msg.laneIndex, msg.error);
      break;

    case 'eloUpdate':
      ratings = msg.ratings || {};
      stats = msg.stats || stats;
      renderPills();
      renderLeaderboard();
      // Update per-lane ELO badges
      (msg.stats ? Object.keys(msg.ratings) : []).forEach((m, _) => {
        // refresh all lane ELO badges
      });
      break;
  }
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function shortLabel(model) {
  // "qwen3-coder:30b-a3b-q4_K_M" → "qwen3-coder:30b"
  const parts = model.split(':');
  if (parts.length < 2) return model;
  const tag = parts[1].split('-')[0];
  return parts[0] + ':' + tag;
}

// Signal ready
vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
  }

  dispose(): void {
    this.abortController?.abort();
    ArenaPanel.current = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
