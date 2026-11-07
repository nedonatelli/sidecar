// The audit-recovery notice at activation is non-modal and waits for the
// user's answer. It was awaited, so the shadow sweep, spend-tracker init and
// spend restore did not run until the user answered it. (#427)
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { window, workspace } from 'vscode';

const { spendTracker, sweepStaleShadows } = vi.hoisted(() => ({
  spendTracker: { init: vi.fn(), restoreFromDisk: vi.fn(async () => {}) },
  sweepStaleShadows: vi.fn(async () => ({})),
}));

vi.mock('../config/sidecarDir.js', () => ({
  SidecarDir: class {
    initialize = async () => true;
  },
}));
vi.mock('../agent/processLifecycle.js', () => ({
  getProcessRegistry: () => ({ setManifestPath: () => {}, sweepOrphans: async () => {}, dispose: () => {} }),
}));
vi.mock('../ollama/spendTracker.js', () => ({ spendTracker }));
vi.mock('../agent/audit/auditBuffer.js', () => ({
  getDefaultAuditBuffer: () => ({ setPersistence: () => {}, restore: () => {} }),
}));
vi.mock('../agent/audit/auditBufferPersistence.js', () => ({
  createWorkspaceAuditBufferPersistence: () => ({
    load: async () => ({ entries: [{ path: 'a.ts' }], commits: [] }),
    clear: async () => {},
  }),
}));
vi.mock('../agent/shadow/shadowSweep.js', () => ({ sweepStaleShadows, formatSweepResult: () => '' }));
vi.mock('../agent/skillLoader.js', () => ({
  SkillLoader: class {
    count = 0;
    setBuiltinPath() {}
    async initialize() {}
    async loadRegistrySkills() {}
  },
}));
vi.mock('../agent/skillRegistrySync.js', () => ({ syncSkillRegistries: async () => [] }));
vi.mock('../config/workspaceIndex.js', () => ({
  WorkspaceIndex: class {
    setSidecarDir() {}
    dispose() {}
  },
}));
vi.mock('../config/symbolIndexer.js', () => ({
  SymbolIndexer: class {
    dispose() {}
  },
}));

import { initCoreServices } from './servicesInit.js';

describe('initCoreServices — audit recovery notice', () => {
  let storageDir: string | undefined;
  afterEach(() => {
    if (storageDir) fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('runs the shadow sweep and spend restore while the recovery notice is still unanswered', async () => {
    (workspace as unknown as { onDidChangeConfiguration: unknown }).onDidChangeConfiguration ??= () => ({
      dispose: () => {},
    });
    // The user never answers the notice.
    const notice = vi.spyOn(window, 'showInformationMessage').mockReturnValue(new Promise(() => {}) as never);
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-init-')).replace(/\\/g, '/');
    const storage = { fsPath: storageDir };
    initCoreServices({
      subscriptions: [],
      extensionPath: process.cwd(),
      storageUri: storage,
      globalStorageUri: storage,
    } as never);

    await vi.waitFor(() => expect(spendTracker.restoreFromDisk).toHaveBeenCalled());
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining('buffered change'),
      expect.anything(),
      'Review',
      'Discard',
    );
    expect(sweepStaleShadows).toHaveBeenCalled();
    expect(spendTracker.init).toHaveBeenCalled();
  });
});
