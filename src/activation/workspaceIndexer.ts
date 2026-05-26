import { window, workspace, ExtensionContext, StatusBarAlignment } from 'vscode';
import { getFilePatterns } from '../config/workspace.js';
import { setSymbolGraph, setSymbolEmbeddings } from '../agent/tools.js';
import type { WorkspaceIndex } from '../config/workspaceIndex.js';
import type { SymbolIndexer } from '../config/symbolIndexer.js';
import type { SidecarDir } from '../config/sidecarDir.js';
import type { SideCarConfig } from '../config/settings.js';
import type { PkiTreeProvider } from '../views/pkiView.js';

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
  pkiProvider?: PkiTreeProvider,
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

      // Project Knowledge Index — symbol-level semantic index
      if (config.projectKnowledgeEnabled) {
        const { SymbolEmbeddingIndex } = await import('../config/symbolEmbeddingIndex.js');
        let pkiStore:
          | import('../config/vectorStore.js').VectorStore<import('../config/symbolEmbeddingIndex.js').SymbolMetadata>
          | undefined;
        if (config.projectKnowledgeBackend === 'lance' && sidecarDir.isReady()) {
          try {
            const { LanceVectorStore } = await import('../config/vectorStore.js');
            pkiStore = new LanceVectorStore(sidecarDir.getPath('pki-lance'), 'symbols', 384);
          } catch (err) {
            const { UnsupportedBackendError } = await import('../config/vectorStore.js');
            if (err instanceof UnsupportedBackendError) {
              console.warn('[SideCar]', err.message);
              void window.showWarningMessage(
                'SideCar: Project Knowledge backend "lance" is not available — install @lancedb/lancedb or switch to "flat".',
              );
            } else {
              throw err;
            }
          }
        }
        const symbolEmbeddings = new SymbolEmbeddingIndex(sidecarDir, pkiStore);
        context.subscriptions.push(symbolEmbeddings);
        symbolEmbeddings
          .initialize()
          .then(async () => {
            symbolIndexer.setSymbolEmbeddings(symbolEmbeddings, config.projectKnowledgeMaxSymbolsPerFile);
            setSymbolEmbeddings(symbolEmbeddings);
            workspaceIndex.setSymbolEmbeddings(symbolEmbeddings);
            pkiProvider?.setIndex(symbolEmbeddings, symbolIndexer, workspaceIndex);
            if (config.merkleIndexEnabled) {
              const { MerkleTree } = await import('../config/merkleTree.js');
              const merkleTree = new MerkleTree();
              symbolEmbeddings.setMerkleTree(merkleTree);
              console.log(
                `[SideCar] Merkle tree wired: rootHash=${symbolEmbeddings.getMerkleRoot().slice(0, 8) || '(empty)'}`,
              );
            }
            const cachedCount = symbolEmbeddings.getCount();
            console.log(`[SideCar] Symbol embedding index ready: ${cachedCount} cached symbol vectors`);

            // Show a progress indicator while symbols are being embedded.
            // On a cold start (no cache) this can take 30s–2min for large
            // workspaces, so we keep the status bar item visible until the
            // queue drains rather than letting it silently spin.
            const wasFirstRun = cachedCount === 0;
            const pkiStatus = window.createStatusBarItem(StatusBarAlignment.Left, 0);
            pkiStatus.text = '$(loading~spin) SideCar: Indexing symbols…';
            context.subscriptions.push(pkiStatus);

            symbolEmbeddings.setOnDrained(() => {
              const count = symbolEmbeddings.getCount();
              pkiStatus.text = `$(check) SideCar PKI: ${count} symbols`;
              pkiStatus.show();
              setTimeout(() => pkiStatus.dispose(), 5_000);

              if (wasFirstRun && !context.globalState.get<boolean>('sidecar.pkiIndexedFirst', false)) {
                void context.globalState.update('sidecar.pkiIndexedFirst', true);
                void window.showInformationMessage(
                  `SideCar: Project Knowledge Index ready — ${count} symbols indexed. Future opens will be instant.`,
                );
              }
            });

            // Show the indicator before queuing files so users see it
            // immediately rather than only after the first batch fires.
            if (wasFirstRun) pkiStatus.show();

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
