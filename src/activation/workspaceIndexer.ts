import { window, workspace, ExtensionContext, StatusBarAlignment } from 'vscode';
import { logger, kv } from '../system/logger.js';
import { getFilePatterns } from '../config/workspace.js';
import { setSymbolGraph, setSymbolEmbeddings } from '../agent/tools.js';
import type { WorkspaceIndex } from '../config/workspaceIndex.js';
import type { SymbolIndexer } from '../config/symbolIndexer.js';
import type { SidecarDir } from '../config/sidecarDir.js';
import type { SideCarConfig } from '../config/settings.js';
import type { PkiTreeProvider } from '../views/pkiView.js';

/** Vectors-per-graph-symbol above which the PKI is assumed to be indexing
 *  something outside the workspace's real source tree. */
const PKI_BLOAT_RATIO = 3;

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
  onIndexingStatus?: (phase: 'indexing' | 'ready', detail?: string) => void,
): void {
  if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) return;

  const indexStatus = window.createStatusBarItem(StatusBarAlignment.Left, 0);
  indexStatus.text = '$(sync~spin) SideCar: Indexing workspace...';
  indexStatus.show();
  context.subscriptions.push(indexStatus);
  onIndexingStatus?.('indexing', 'Indexing workspace…');

  workspaceIndex
    .initialize(getFilePatterns())
    .then(async () => {
      const count = workspaceIndex.getFileCount();
      logger.info(`[SideCar] Workspace indexed: ${count} files`);
      indexStatus.text = `$(check) SideCar: ${count} files indexed`;
      setTimeout(() => indexStatus.dispose(), 5000);

      // Build symbol graph after workspace index is ready. Captured so the PKI
      // replay below can await it — replaySymbolsToEmbeddingIndex reads
      // graph.indexedFilePaths(), so running it before the graph finishes
      // building queues only the few symbols parsed so far (dogfooding: a large
      // repo embedded ~13 of thousands because the replay raced the graph build).
      const symbolGraphReady = symbolIndexer
        .initialize(getFilePatterns())
        .then(() => {
          const symCount = symbolIndexer.getGraph().symbolCount();
          logger.info(`[SideCar] Symbol graph built: ${symCount} symbols`);
          workspaceIndex.setSymbolIndexer(symbolIndexer);
          setSymbolGraph(symbolIndexer.getGraph());
        })
        .catch((err) => logger.warn('[SideCar] Symbol graph build failed:', err));

      // Build semantic embedding index (background, non-blocking)
      if (config.enableSemanticSearch) {
        const { EmbeddingIndex } = await import('../config/embeddingIndex.js');
        const embeddingIndex = new EmbeddingIndex(sidecarDir);
        context.subscriptions.push(embeddingIndex);
        embeddingIndex
          .initialize()
          .then(() => {
            workspaceIndex.setEmbeddingIndex(embeddingIndex);
            logger.info(`[SideCar] Embedding index ready: ${embeddingIndex.getCount()} cached vectors`);
            for (const file of workspaceIndex.getFiles()) {
              embeddingIndex.queuePath(file.relativePath, workspace.workspaceFolders![0].uri.fsPath);
            }
          })
          .catch((err) => logger.warn('[SideCar] Embedding index failed:', err.message || err));
      }

      // Project Knowledge Index — symbol-level semantic index
      if (!config.projectKnowledgeEnabled) {
        onIndexingStatus?.('ready');
      }
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
              logger.warn('[SideCar]', err.message);
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

            // Show a progress indicator while symbols are being embedded.
            // On a cold start (no cache) this can take 30s–2min for large
            // workspaces, so we keep the status bar item visible until the
            // queue drains rather than letting it silently spin.
            const wasFirstRun = symbolEmbeddings.getCount() === 0;
            const pkiStatus = window.createStatusBarItem(StatusBarAlignment.Left, 0);
            pkiStatus.text = '$(loading~spin) SideCar: Indexing symbols…';
            context.subscriptions.push(pkiStatus);

            symbolEmbeddings.setOnDrained(() => {
              onIndexingStatus?.('ready');
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

            // Wait for the symbol graph to FINISH building before touching it —
            // otherwise indexedFilePaths() is partial, which would make the
            // reconcile below delete live symbols and leave the replay with
            // almost nothing to queue. The graph's hash-match short-circuit
            // means indexSymbol won't fire for cached/unchanged files, so that
            // replay is the only thing that queues them.
            await symbolGraphReady;

            // Drop symbols whose files are gone. The graph re-derives its file
            // set from disk each initialize; the PKI never did, so it only grew
            // (dogfood: 96.7% of a 330 MB index pointed at deleted
            // `.stryker-tmp/sandbox-*` copies). Runs BEFORE the Merkle tree is
            // wired so orphans never enter it. Skipped on an empty graph — a
            // failed graph build must not be read as "every file vanished".
            const liveFiles = new Set(symbolIndexer.getGraph().indexedFilePaths());
            if (liveFiles.size > 0) {
              const dropped = await symbolEmbeddings.reconcileFiles(liveFiles);
              if (dropped > 0) {
                logger.info(`[PKI] reconciled${kv({ dropped, liveFiles: liveFiles.size })}`);
              }
            }

            if (config.merkleIndexEnabled) {
              const { MerkleTree } = await import('../config/merkleTree.js');
              const merkleTree = new MerkleTree();
              await symbolEmbeddings.setMerkleTree(merkleTree);
              logger.info(
                `[SideCar] Merkle tree wired: rootHash=${symbolEmbeddings.getMerkleRoot().slice(0, 8) || '(empty)'}`,
              );
            }

            const cachedCount = symbolEmbeddings.getCount();
            logger.info(`[SideCar] Symbol embedding index ready: ${cachedCount} cached symbol vectors`);

            const replay = await symbolIndexer.replaySymbolsToEmbeddingIndex();
            const graphSymbols = symbolIndexer.getGraph().symbolCount();
            const replayFields = kv({
              queued: replay.queued,
              filesRead: replay.filesRead,
              filesSkipped: replay.filesSkipped,
              graphSymbols,
            });
            if (replay.queued === 0 && graphSymbols > 0) {
              logger.warn(`[PKI] replay queued nothing despite a non-empty graph${replayFields}`);
            } else {
              logger.info(`[PKI] replay complete${replayFields}`);
            }

            // Backstop for the next orphan source reconcile doesn't know about.
            // A healthy index tracks the graph within a small factor; a large
            // multiple means something is seeding symbols the graph never saw.
            if (graphSymbols > 0 && cachedCount > graphSymbols * PKI_BLOAT_RATIO) {
              logger.warn(
                `[PKI] index is disproportionate to the symbol graph${kv({
                  vectors: cachedCount,
                  graphSymbols,
                  ratio: (cachedCount / graphSymbols).toFixed(1),
                })} — likely an unexcluded directory of copied sources; run "SideCar: Rebuild Project Knowledge Index" if retrieval looks wrong`,
              );
            }
            if (replay.queued > 0) {
              // A warm-cache reload after heavy repo churn can queue thousands
              // of re-embeds (dogfood: 5,713 after a day's branch work) — that
              // was previously INVISIBLE because the spinner only showed on
              // first run, and the chat showed nothing at all.
              pkiStatus.text = `$(loading~spin) SideCar: Indexing ${replay.queued} changed symbols…`;
              pkiStatus.show();
              onIndexingStatus?.('indexing', `Indexing ${replay.queued} changed symbols…`);
            } else {
              onIndexingStatus?.('ready');
            }
          })
          .catch((err) => {
            logger.warn('[SideCar] Symbol embedding index failed:', err?.message || err);
            onIndexingStatus?.('ready');
          });
      }
    })
    .catch((err) => {
      logger.error('[SideCar] Workspace indexing failed:', err);
      indexStatus.text = '$(warning) SideCar: Indexing failed';
      setTimeout(() => indexStatus.dispose(), 5000);
      onIndexingStatus?.('ready');
    });
}
