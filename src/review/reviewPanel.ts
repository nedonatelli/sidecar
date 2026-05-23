/**
 * WebviewPanel-based diff review for fork and facet batch results.
 *
 * Replaces the QuickPick-based `reviewForkBatch` / `reviewFacetBatch` with
 * a side-by-side panel showing all results simultaneously, inline colored
 * diffs, and per-item action buttons.
 *
 * Public API:
 *   reviewForkBatchWithPanel(batch, deps, context) → ForkReviewOutcome
 *   reviewFacetBatchWithPanel(batch, deps, context) → FacetReviewOutcome
 *
 * Both match the `review?: typeof reviewForkBatch` slot in the respective
 * command deps so the activation layer can swap them in without touching
 * any other file.
 */

import { ExtensionContext, ViewColumn, WebviewPanel, window } from 'vscode';
import { GitCLI } from '../github/git.js';
import { planForkReview } from '../agent/fork/forkReview.js';
import { planFacetReview } from '../agent/facets/facetReview.js';
import type { ForkDispatchBatchResult } from '../agent/fork/forkDispatcher.js';
import type { FacetDispatchBatchResult } from '../agent/facets/facetDispatcher.js';
import type { ForkReviewDeps, ForkReviewOutcome } from '../agent/fork/forkReview.js';
import type { FacetReviewDeps, FacetReviewOutcome } from '../agent/facets/facetReview.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface ReviewItemData {
  id: string;
  label: string;
  diff: string;
  files: readonly string[];
  linesAdded: number;
  linesRemoved: number;
  durationMs: number;
  charsConsumed: number;
  outputSnippet: string;
  overlapsWith?: readonly string[];
}

type ExtToPanel =
  | { command: 'init'; mode: 'fork' | 'facet'; items: ReviewItemData[] }
  | { command: 'applyResult'; id: string; ok: boolean; errorMessage?: string };

type PanelToExt =
  | { command: 'ready' }
  | { command: 'applyFork'; forkId: string }
  | { command: 'acceptFacet'; facetId: string }
  | { command: 'rejectFacet'; facetId: string }
  | { command: 'skipFacet'; facetId: string }
  | { command: 'dismiss' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

async function applyPatch(
  mainRoot: string,
  diff: string,
  applyDiff?: (root: string, d: string) => Promise<string>,
): Promise<void> {
  if (applyDiff) {
    await applyDiff(mainRoot, diff);
  } else {
    const git = new GitCLI(mainRoot);
    await git.applyPatch(diff, { check: true });
    await git.applyPatch(diff, { stage: true });
  }
}

// ---------------------------------------------------------------------------
// Panel class
// ---------------------------------------------------------------------------

class ReviewPanel {
  private readonly disposables: { dispose(): void }[] = [];
  private dismissed = false;

  private constructor(
    private readonly panel: WebviewPanel,
    private readonly onMsg: (msg: PanelToExt) => void,
  ) {
    this.disposables.push(panel.webview.onDidReceiveMessage((msg: PanelToExt) => onMsg(msg)));
    panel.onDidDispose(() => {
      for (const d of this.disposables) d.dispose();
      if (!this.dismissed) {
        this.dismissed = true;
        onMsg({ command: 'dismiss' });
      }
    });
  }

  static create(context: ExtensionContext, title: string, onMsg: (msg: PanelToExt) => void): ReviewPanel {
    const nonce = crypto.randomUUID().replace(/-/g, '');
    const panel = window.createWebviewPanel('sidecar.reviewPanel', title, ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.webview.html = buildHtml(nonce);
    return new ReviewPanel(panel, onMsg);
  }

  post(msg: ExtToPanel): void {
    void this.panel.webview.postMessage(msg);
  }

  dispose(): void {
    this.dismissed = true;
    this.panel.dispose();
  }
}

// ---------------------------------------------------------------------------
// HTML / CSS / JS builder
// ---------------------------------------------------------------------------

function buildHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Review</title>
<style>
*,*::before,*::after{box-sizing:border-box}
body{margin:0;padding:12px 16px 0;font-family:var(--vscode-font-family,sans-serif);font-size:var(--vscode-font-size,13px);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
.header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px}
.header h2{margin:0;font-size:1.1em}
.fork-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:10px;margin-bottom:60px}
.facet-list{display:flex;flex-direction:column;gap:10px;margin-bottom:60px}
.card{border:1px solid var(--vscode-panel-border,rgba(128,128,128,.35));border-radius:6px;overflow:hidden;background:var(--vscode-sideBar-background,var(--vscode-editor-background));display:flex;flex-direction:column}
.card.selected{border-color:var(--vscode-focusBorder,#007fd4)}
.card.accepted{border-color:var(--vscode-gitDecoration-addedResourceForeground,#4ec9b0);opacity:.85}
.card.rejected{border-color:var(--vscode-gitDecoration-deletedResourceForeground,#f44747);opacity:.6}
.card-header{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--vscode-sideBarSectionHeader-background,rgba(128,128,128,.1));cursor:pointer;user-select:none}
.card-title{font-weight:600;flex:1}
.stats{display:flex;gap:6px;font-size:11px;color:var(--vscode-descriptionForeground)}
.stat-add{color:var(--vscode-gitDecoration-addedResourceForeground,#4ec9b0)}
.stat-del{color:var(--vscode-gitDecoration-deletedResourceForeground,#f44747)}
.overlap-warn{font-size:11px;color:var(--vscode-editorWarning-foreground,#cca700);padding:4px 10px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.2))}
.diff-wrap{flex:1;max-height:240px;overflow:auto}
.diff-wrap pre{margin:0;padding:5px 8px;font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,12px);line-height:1.5;white-space:pre}
.diff-add{color:var(--vscode-gitDecoration-addedResourceForeground,#4ec9b0)}
.diff-del{color:var(--vscode-gitDecoration-deletedResourceForeground,#f44747)}
.diff-hunk{color:var(--vscode-textLink-foreground,#3794ff)}
.diff-ctx{color:var(--vscode-editor-foreground);opacity:.7}
.no-diff{padding:10px;color:var(--vscode-descriptionForeground);font-style:italic}
.snippet{padding:5px 10px;font-size:11px;color:var(--vscode-descriptionForeground);border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.2));max-height:52px;overflow:hidden;white-space:pre-wrap;word-break:break-word}
.card-actions{display:flex;gap:6px;padding:8px 10px;border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.2))}
.card-status{padding:8px 10px;border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.2));font-size:12px}
.ok{color:var(--vscode-gitDecoration-addedResourceForeground,#4ec9b0)}
.err{color:var(--vscode-gitDecoration-deletedResourceForeground,#f44747)}
.card-radio{display:flex;align-items:center;gap:6px;cursor:pointer}
input[type=radio]{cursor:pointer;accent-color:var(--vscode-focusBorder,#007fd4)}
.bottom-bar{position:fixed;bottom:0;left:0;right:0;background:var(--vscode-editor-background);border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.35));padding:10px 16px;display:flex;gap:8px}
button{padding:4px 12px;border:1px solid var(--vscode-button-border,transparent);border-radius:3px;cursor:pointer;font-size:12px;font-family:inherit}
.btn-p{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.btn-p:hover{background:var(--vscode-button-hoverBackground)}
.btn-p:disabled{opacity:.45;cursor:not-allowed}
.btn-s{background:transparent;color:var(--vscode-foreground);border-color:var(--vscode-panel-border,rgba(128,128,128,.4))}
.btn-s:hover{background:rgba(128,128,128,.1)}
.btn-acc{background:rgba(78,201,176,.12);color:var(--vscode-gitDecoration-addedResourceForeground,#4ec9b0);border-color:currentColor}
.btn-acc:hover{background:rgba(78,201,176,.22)}
.btn-rej{background:rgba(244,71,71,.1);color:var(--vscode-gitDecoration-deletedResourceForeground,#f44747);border-color:currentColor}
.btn-rej:hover{background:rgba(244,71,71,.2)}
.btn-skip{background:transparent;color:var(--vscode-descriptionForeground);border-color:var(--vscode-panel-border,rgba(128,128,128,.4))}
.skipped{margin-top:10px;margin-bottom:60px}
.skipped p{margin:2px 0;font-size:11px;color:var(--vscode-descriptionForeground)}
.skipped strong{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--vscode-descriptionForeground)}
</style>
</head>
<body>
<div id="root"><p style="color:var(--vscode-descriptionForeground)">Loading…</p></div>
<script nonce="${nonce}">
var vsc = acquireVsCodeApi();
var mode = 'fork';
var items = [];
var pending = {};   // facet: id -> true when still pending

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fmtMs(ms) {
  return ms >= 1000 ? (ms/1000).toFixed(1)+'s' : ms+'ms';
}
function renderDiff(patch) {
  if (!patch) return '<p class="no-diff">No changes</p>';
  var lines = patch.split('\\n');
  var html = '';
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    var cls = 'diff-ctx';
    if (l.startsWith('+') && !l.startsWith('+++')) cls = 'diff-add';
    else if (l.startsWith('-') && !l.startsWith('---')) cls = 'diff-del';
    else if (l.startsWith('@@')) cls = 'diff-hunk';
    html += '<span class="' + cls + '">' + esc(l) + '\\n</span>';
  }
  return '<pre>' + html + '</pre>';
}

// ---- fork ----

function renderForks() {
  var html = '<div class="fork-grid" id="grid">';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    html += '<div class="card" data-id="' + esc(it.id) + '">';
    html += '<div class="card-header" onclick="selFork(\'' + esc(it.id) + '\')">';
    html += '<label class="card-radio"><input type="radio" name="w" value="' + esc(it.id) + '"><span class="card-title">' + esc(it.label) + '</span></label>';
    html += '<div class="stats"><span>' + it.files.length + ' file' + (it.files.length!==1?'s':'') + '</span>';
    html += '<span class="stat-add">+' + it.linesAdded + '</span><span class="stat-del">-' + it.linesRemoved + '</span>';
    html += '<span>' + fmtMs(it.durationMs) + '</span></div>';
    html += '</div>';
    if (it.outputSnippet) html += '<div class="snippet">' + esc(it.outputSnippet) + '</div>';
    html += '<div class="diff-wrap">' + renderDiff(it.diff) + '</div></div>';
  }
  html += '</div>';
  if (items.length > 0) {
    html += '<div class="bottom-bar"><button class="btn-p" id="applyBtn" disabled onclick="doApply()">Apply Selected Fork</button><button class="btn-s" onclick="vsc.postMessage({command:\'dismiss\'})">Dismiss</button></div>';
  }
  document.getElementById('root').innerHTML = html;
}

function selFork(id) {
  var cards = document.querySelectorAll('.card');
  for (var i = 0; i < cards.length; i++) cards[i].classList.remove('selected');
  var card = document.querySelector('.card[data-id="' + id + '"]');
  if (card) card.classList.add('selected');
  var radio = card && card.querySelector('input[type=radio]');
  if (radio) radio.checked = true;
  var btn = document.getElementById('applyBtn');
  if (btn) btn.disabled = false;
}

function doApply() {
  var radio = document.querySelector('input[type=radio]:checked');
  if (!radio) return;
  var id = radio.value;
  var btn = document.getElementById('applyBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }
  var card = document.querySelector('.card[data-id="' + id + '"]');
  if (card) card.style.opacity = '0.6';
  vsc.postMessage({command:'applyFork', forkId:id});
}

// ---- facet ----

function renderFacets() {
  var html = '<div class="facet-list" id="list">';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    pending[it.id] = true;
    html += '<div class="card" data-id="' + esc(it.id) + '">';
    html += '<div class="card-header"><span class="card-title">' + esc(it.label) + '</span>';
    html += '<div class="stats"><span>' + it.files.length + ' file' + (it.files.length!==1?'s':'') + '</span>';
    html += '<span class="stat-add">+' + it.linesAdded + '</span><span class="stat-del">-' + it.linesRemoved + '</span>';
    html += '<span>' + fmtMs(it.durationMs) + '</span></div></div>';
    if (it.overlapsWith && it.overlapsWith.length > 0) {
      html += '<div class="overlap-warn">⚠ Overlaps with: ' + esc(it.overlapsWith.join(', ')) + '</div>';
    }
    if (it.outputSnippet) html += '<div class="snippet">' + esc(it.outputSnippet) + '</div>';
    html += '<div class="diff-wrap">' + renderDiff(it.diff) + '</div>';
    html += '<div class="card-actions" id="act-' + esc(it.id) + '">';
    html += '<button class="btn-acc" onclick="doAccept(\'' + esc(it.id) + '\')">Accept</button>';
    html += '<button class="btn-rej" onclick="doReject(\'' + esc(it.id) + '\')">Reject</button>';
    html += '<button class="btn-skip" onclick="doSkip(\'' + esc(it.id) + '\')">Skip</button>';
    html += '</div></div>';
  }
  html += '</div>';
  html += '<div class="bottom-bar"><button class="btn-s" onclick="vsc.postMessage({command:\'dismiss\'})">Done</button></div>';
  document.getElementById('root').innerHTML = html;
}

function setCardStatus(id, cls, msg) {
  var card = document.querySelector('.card[data-id="' + id + '"]');
  if (card) {
    card.classList.remove('selected');
    if (cls) card.classList.add(cls);
  }
  var act = document.getElementById('act-' + id);
  if (act) act.outerHTML = '<div class="card-status ' + (cls==='accepted'?'ok':cls==='rejected'||cls==='failed'?'err':'') + '">' + esc(msg) + '</div>';
}

function doAccept(id) {
  var act = document.getElementById('act-' + id);
  if (act) { var btns = act.querySelectorAll('button'); for(var i=0;i<btns.length;i++) btns[i].disabled=true; if(btns[0]) btns[0].textContent='Applying…'; }
  vsc.postMessage({command:'acceptFacet', facetId:id});
}
function doReject(id) {
  setCardStatus(id, 'rejected', 'Rejected');
  vsc.postMessage({command:'rejectFacet', facetId:id});
}
function doSkip(id) {
  var act = document.getElementById('act-' + id);
  if (act) act.style.opacity = '0.4';
  vsc.postMessage({command:'skipFacet', facetId:id});
}

// ---- message handler ----

window.addEventListener('message', function(e) {
  var msg = e.data;
  if (msg.command === 'init') {
    mode = msg.mode;
    items = msg.items;
    if (mode === 'fork') renderForks();
    else renderFacets();
  } else if (msg.command === 'applyResult') {
    if (mode === 'fork') {
      var btn = document.getElementById('applyBtn');
      var card = document.querySelector('.card[data-id="' + msg.id + '"]');
      if (msg.ok) {
        if (btn) btn.textContent = '✓ Applied';
        if (card) { card.style.opacity='1'; card.classList.add('accepted'); }
      } else {
        if (btn) { btn.disabled=false; btn.textContent='Apply Selected Fork'; }
        if (card) { card.style.opacity='1'; var e2=document.createElement('div'); e2.className='card-status err'; e2.textContent='Failed: '+(msg.errorMessage||'unknown'); card.appendChild(e2); }
      }
    } else {
      if (msg.ok) setCardStatus(msg.id, 'accepted', '✓ Applied');
      else setCardStatus(msg.id, 'failed', '✗ Failed: '+(msg.errorMessage||'unknown'));
    }
  }
});

vsc.postMessage({command:'ready'});
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Public review functions
// ---------------------------------------------------------------------------

export async function reviewForkBatchWithPanel(
  batch: ForkDispatchBatchResult,
  deps: ForkReviewDeps,
  context: ExtensionContext,
): Promise<ForkReviewOutcome> {
  const plan = planForkReview(batch);
  const skippedLabels = plan.skipped.map((s) => s.label);

  if (plan.reviewable.length === 0) {
    const msg =
      plan.skipped.length === 0
        ? 'No fork results to review.'
        : `No fork produced a reviewable diff (${plan.skipped.length} skipped).`;
    deps.ui.showInfo(msg);
    return { winnerIndex: null, appliedOk: false, skippedLabels };
  }

  return new Promise<ForkReviewOutcome>((resolve) => {
    let resolved = false;
    const resolveOnce = (outcome: ForkReviewOutcome) => {
      if (resolved) return;
      resolved = true;
      panel.dispose();
      resolve(outcome);
    };

    const panel = ReviewPanel.create(context, 'Fork Review', async (msg) => {
      switch (msg.command) {
        case 'ready': {
          const items: ReviewItemData[] = plan.reviewable.map((f) => {
            const { added, removed } = countDiffLines(f.pendingDiff);
            const forkResult = batch.results.find((r) => r.forkId === f.forkId);
            return {
              id: f.forkId,
              label: f.label,
              diff: f.pendingDiff.slice(0, 12_000),
              files: f.files,
              linesAdded: added,
              linesRemoved: removed,
              durationMs: f.durationMs,
              charsConsumed: f.charsConsumed,
              outputSnippet: (forkResult?.output ?? '').slice(-280).trimStart(),
            };
          });
          panel.post({ command: 'init', mode: 'fork', items });
          break;
        }
        case 'applyFork': {
          const fork = plan.reviewable.find((f) => f.forkId === msg.forkId);
          if (!fork) return;
          try {
            await applyPatch(deps.mainRoot, fork.pendingDiff, deps.applyDiff);
            panel.post({ command: 'applyResult', id: msg.forkId, ok: true });
            resolveOnce({ winnerIndex: fork.index, appliedOk: true, skippedLabels });
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            panel.post({ command: 'applyResult', id: msg.forkId, ok: false, errorMessage });
          }
          break;
        }
        case 'dismiss':
          resolveOnce({ winnerIndex: null, appliedOk: false, skippedLabels });
          break;
      }
    });
  });
}

export async function reviewFacetBatchWithPanel(
  batch: FacetDispatchBatchResult,
  deps: FacetReviewDeps,
  context: ExtensionContext,
): Promise<FacetReviewOutcome> {
  const plan = planFacetReview(batch);

  if (plan.entries.length === 0) {
    deps.ui.showInfo('No facet diffs to review.');
    return { applied: [], rejected: [], failed: [], cancelledRemaining: [] };
  }

  return new Promise<FacetReviewOutcome>((resolve) => {
    const applied: string[] = [];
    const rejected: string[] = [];
    const failed: { facetId: string; error: string }[] = [];
    const pendingIds = new Set<string>(plan.entries.map((e) => e.facetId));
    let resolved = false;

    const resolveOnce = () => {
      if (resolved) return;
      resolved = true;
      const cancelledRemaining = [...pendingIds];
      panel.dispose();
      resolve({ applied, rejected, failed, cancelledRemaining });
    };

    const panel = ReviewPanel.create(context, 'Facet Review', async (msg) => {
      switch (msg.command) {
        case 'ready': {
          const items: ReviewItemData[] = plan.entries.map((e) => {
            const { added, removed } = countDiffLines(e.pendingDiff);
            const facetResult = batch.results.find((r) => r.facetId === e.facetId);
            return {
              id: e.facetId,
              label: e.displayName,
              diff: e.pendingDiff.slice(0, 12_000),
              files: e.files,
              linesAdded: added,
              linesRemoved: removed,
              durationMs: facetResult?.durationMs ?? 0,
              charsConsumed: facetResult?.charsConsumed ?? 0,
              outputSnippet: (facetResult?.output ?? '').slice(-280).trimStart(),
              overlapsWith: e.overlapsWith,
            };
          });
          panel.post({ command: 'init', mode: 'facet', items });
          break;
        }
        case 'acceptFacet': {
          const entry = plan.entries.find((e) => e.facetId === msg.facetId);
          if (!entry) return;
          try {
            await applyPatch(deps.mainRoot, entry.pendingDiff, deps.applyDiff);
            applied.push(msg.facetId);
            pendingIds.delete(msg.facetId);
            panel.post({ command: 'applyResult', id: msg.facetId, ok: true });
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            failed.push({ facetId: msg.facetId, error });
            pendingIds.delete(msg.facetId);
            panel.post({ command: 'applyResult', id: msg.facetId, ok: false, errorMessage: error });
          }
          break;
        }
        case 'rejectFacet':
          rejected.push(msg.facetId);
          pendingIds.delete(msg.facetId);
          break;
        case 'skipFacet':
          // stays in pendingIds → shows as cancelledRemaining on dismiss
          break;
        case 'dismiss':
          resolveOnce();
          break;
      }
    });
  });
}
