import * as path from 'path';
import { commands, window, workspace, ExtensionContext } from 'vscode';
import { getConfig } from '../config/settings.js';
import { SidecarDir } from '../config/sidecarDir.js';
import { WorkspaceIndex } from '../config/workspaceIndex.js';
import { SymbolIndexer } from '../config/symbolIndexer.js';
import { SkillLoader } from '../agent/skillLoader.js';
import { getProcessRegistry } from '../agent/processLifecycle.js';
import { spendTracker } from '../ollama/spendTracker.js';
import { setApiAuditDir } from '../agent/apiAuditLog.js';

const HOURLY_MS = 60 * 60 * 1000;
const DAILY_MS = 24 * HOURLY_MS;

export interface InitializedServices {
  sidecarDir: SidecarDir;
  skillLoader: SkillLoader;
  workspaceIndex: WorkspaceIndex;
  symbolIndexer: SymbolIndexer;
}

/**
 * Initialize the core services: .sidecar/ directory, process registry, audit
 * buffer recovery, shadow sweep, spend tracker, skill loader, workspace index,
 * and symbol indexer.
 * Extracted from extension.ts to keep the entry point under 150 lines.
 */
export function initCoreServices(context: ExtensionContext): InitializedServices {
  const sidecarDir = new SidecarDir();
  if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
    sidecarDir.initialize().then(
      async (ok) => {
        if (!ok) return;
        console.log('[SideCar] .sidecar/ directory ready');

        const processRegistry = getProcessRegistry();
        processRegistry.setManifestPath(sidecarDir.getPath('pids.json'));
        await processRegistry.sweepOrphans().catch((err) => {
          console.warn('[SideCar] Process orphan sweep failed:', err);
        });

        await initAuditBufferRecovery();
        void initShadowSweep();

        spendTracker.init(sidecarDir);
        void spendTracker.restoreFromDisk();
      },
      (err) => console.warn('[SideCar] .sidecar/ init failed:', err),
    );
  }

  // Load built-in + user + project skills (background, non-blocking)
  const skillLoader = new SkillLoader();
  skillLoader.setBuiltinPath(path.join(context.extensionPath, 'skills'));

  const runSkillSync = async () => {
    try {
      await skillLoader.initialize();
      const skillCfg = getConfig();
      const { syncSkillRegistries } = await import('../agent/skillRegistrySync.js');
      const refs = await syncSkillRegistries({
        config: {
          skillsUserRegistry: skillCfg.skillsUserRegistry,
          skillsTeamRegistries: skillCfg.skillsTeamRegistries,
          skillsAutoPull: skillCfg.skillsAutoPull,
          skillsTrustedRegistries: skillCfg.skillsTrustedRegistries,
          skillsOffline: skillCfg.skillsOffline,
        },
        trustPrompt: async (ref) => {
          const choice = await window.showInformationMessage(
            `SideCar: trust skill registry \`${ref.url}\`? ` +
              `Its skills will be available in your picker and can suggest tool calls to the agent ` +
              `(still bounded by your per-skill allowed-tools guardrails).`,
            { modal: true },
            'Trust this registry',
            'Skip',
          );
          return choice === 'Trust this registry';
        },
        log: (line) => console.log(line),
      });
      if (refs.length > 0) {
        await skillLoader.loadRegistrySkills(refs);
      }
    } catch (err) {
      console.warn('[SideCar] Skill loading failed:', err);
    }
  };

  void runSkillSync();

  // Register manual sync command
  context.subscriptions.push(
    commands.registerCommand('sidecar.skills.sync', async () => {
      await window.withProgress(
        { location: 15 /* Notification */, title: 'SideCar: Syncing skill registries…', cancellable: false },
        () => runSkillSync(),
      );
      void window.showInformationMessage(`SideCar: Skill registries synced. ${skillLoader.count} skills loaded.`);
    }),
  );

  // Schedule background syncs for hourly / daily autoPull
  const autoPull = getConfig().skillsAutoPull;
  if (autoPull === 'hourly' || autoPull === 'daily') {
    const intervalMs = autoPull === 'hourly' ? HOURLY_MS : DAILY_MS;
    const timer = setInterval(() => void runSkillSync(), intervalMs);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  setApiAuditDir(sidecarDir);

  const workspaceIndex = new WorkspaceIndex();
  workspaceIndex.setSidecarDir(sidecarDir);
  context.subscriptions.push(workspaceIndex);

  const symbolIndexer = new SymbolIndexer(sidecarDir);
  context.subscriptions.push(symbolIndexer);

  return { sidecarDir, skillLoader, workspaceIndex, symbolIndexer };
}

async function initAuditBufferRecovery(): Promise<void> {
  const { getDefaultAuditBuffer } = await import('../agent/audit/auditBuffer.js');
  const { createWorkspaceAuditBufferPersistence } = await import('../agent/audit/auditBufferPersistence.js');
  const persistence = createWorkspaceAuditBufferPersistence();
  const buf = getDefaultAuditBuffer();
  buf.setPersistence(persistence);

  let recovered: Awaited<ReturnType<typeof persistence.load>>;
  try {
    recovered = await persistence.load();
  } catch (err) {
    console.warn('[SideCar] Audit buffer load failed:', err);
    return;
  }
  if (!recovered || (recovered.entries.length === 0 && recovered.commits.length === 0)) return;

  const nChanges = recovered.entries.length;
  const nCommits = recovered.commits.length;
  const commitSuffix = nCommits > 0 ? ` + ${nCommits} commit${nCommits === 1 ? '' : 's'}` : '';
  const choice = await window.showInformationMessage(
    `SideCar audit: ${nChanges} buffered change${nChanges === 1 ? '' : 's'}${commitSuffix} from your previous session. What would you like to do?`,
    { modal: false },
    'Review',
    'Discard',
  );
  if (choice === 'Discard') {
    await persistence.clear();
    return;
  }
  buf.restore(recovered);
}

async function initShadowSweep(): Promise<void> {
  const cfg = getConfig();
  if (cfg.shadowWorkspaceSweepOnActivation === false) return;
  const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;
  try {
    const { sweepStaleShadows, formatSweepResult } = await import('../agent/shadow/shadowSweep.js');
    const result = await sweepStaleShadows(root);
    const summary = formatSweepResult(result);
    if (summary) console.warn(`[SideCar] ${summary}`);
  } catch (err) {
    console.warn('[SideCar] Shadow sweep failed:', err);
  }
}
