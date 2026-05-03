import { window, workspace, ExtensionContext, StatusBarAlignment } from 'vscode';
import { getFilePatterns } from '../config/workspace.js';
import { setSymbolGraph, setSymbolEmbeddings } from '../agent/tools.js';
import type { WorkspaceIndex } from '../config/workspaceIndex.js';
import type { SymbolIndexer } from '../config/symbolIndexer.js';
import type { SidecarDir } from '../config/sidecarDir.js';
import type { SideCarConfig } from '../config/settings.js';

/**
 * Kick off workspace indexing (symbol graph + optional semantic/PKI embeddings)
 * in the background. Extracted from extension.ts to keep the entry point lean.
 */
export function initWorkspaceIndex(
  context: ExtensionContext,
  workspaceIndex: WorkspaceIndex,
  symbolIndexer: SymbolIndexer,
  sidecarDir: SidecarDir,
  config: SideCarConfig,
): void {
  if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) return;

  const indexStatus = window.createStatusBarItem(StatusBarAlignment.Left, 0);
  indexStatus.text = '$(sync~spin) SideCar: Indexing workspace...';
  indexStatus.show();
  context.subscriptions.push(indexStatus);

  workspaceIndex
    .initialize(getFilePatterns())
    .then(async () => {
      const count = workspaceIndex.getFileCount();
      console.log(`[SideCar] Workspace indexed: ${count} files`);
      indexStatus.text = `$(check) SideCar: ${count} files indexed`;
      setTimeout(() => indexStatus.dispose(), 5000);

      // Build symbol graph after workspace index is ready
      symbolIndexer
        .initialize(getFilePatterns())
        .then(() => {
          const symCount = symbolIndexer.getGraph().symbolCount();
          console.log(`[SideCar] Symbol graph built: ${symCount} symbols`);
          workspaceIndex.setSymbolIndexer(symbolIndexer);
          setSymbolGraph(symbolIndexer.getGraph());
        })
        .catch((err) => console.warn('[SideCar] Symbol graph build failed:', err));

      // Build semantic embedding index (background, non-blocking)
      if (config.enableSemanticSearch) {
        const { EmbeddingIndex } = await import('../config/embeddingIndex.js');
        const embeddingIndex = new EmbeddingIndex(sidecarDir);
        context.subscriptions.push(embeddingIndex);
        embeddingIndex
          .initialize()
          .then(() => {
            workspaceIndex.setEmbeddingIndex(embeddingIndex);
            console.log(`[SideCar] Embedding index ready: ${embeddingIndex.getCount()} cached vectors`);
            for (const file of workspaceIndex.getFiles()) {
              embeddingIndex.queuePath(file.relativePath, workspace.workspaceFolders![0].uri.fsPath);
            }
          })
          .catch((err) => console.warn('[SideCar] Embedding index failed:', err.message || err));
      }

      // Project Knowledge Index — symbol-level semantic index (v0.61 b.2)
      if (config.projectKnowledgeEnabled) {
        const { SymbolEmbeddingIndex } = await import('../config/symbolEmbeddingIndex.js');
        if (config.projectKnowledgeBackend === 'lance') {
          console.warn(
            '[SideCar] sidecar.projectKnowledge.backend=lance is reserved for a future release; using `flat` instead.',
          );
          void window.showWarningMessage(
            'SideCar: Project Knowledge backend "lance" is not available in this build — using "flat" instead.',
          );
        }
        const symbolEmbeddings = new SymbolEmbeddingIndex(sidecarDir);
        context.subscriptions.push(symbolEmbeddings);
        symbolEmbeddings
          .initialize()
          .then(async () => {
            symbolIndexer.setSymbolEmbeddings(symbolEmbeddings, config.projectKnowledgeMaxSymbolsPerFile);
            setSymbolEmbeddings(symbolEmbeddings);
            workspaceIndex.setSymbolEmbeddings(symbolEmbeddings);
            if (config.merkleIndexEnabled) {
              const { MerkleTree } = await import('../config/merkleTree.js');
              const merkleTree = new MerkleTree();
              symbolEmbeddings.setMerkleTree(merkleTree);
              console.log(
                `[SideCar] Merkle tree wired: rootHash=${symbolEmbeddings.getMerkleRoot().slice(0, 8) || '(empty)'}`,
              );
            }
            console.log(`[SideCar] Symbol embedding index ready: ${symbolEmbeddings.getCount()} cached symbol vectors`);
            for (const file of workspaceIndex.getFiles()) {
              symbolIndexer.queueUpdate(file.relativePath);
            }
          })
          .catch((err) => console.warn('[SideCar] Symbol embedding index failed:', err?.message || err));
      }
    })
    .catch((err) => {
      console.error('[SideCar] Workspace indexing failed:', err);
      indexStatus.text = '$(warning) SideCar: Indexing failed';
      setTimeout(() => indexStatus.dispose(), 5000);
    });
}
