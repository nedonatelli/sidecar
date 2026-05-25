import type { ExtensionContext } from 'vscode';
import type { SidecarDir } from '../config/sidecarDir.js';
import { getConfig } from '../config/settings.js';
import { ResearchStore } from '../agent/research/researchStore.js';
import { setResearchStore } from '../agent/tools/research.js';
import { registerResearchView } from '../views/researchView.js';

export function initResearchSetup(context: ExtensionContext, sidecarDir: SidecarDir): void {
  if (!getConfig().researchEnabled) return;

  const store = new ResearchStore(sidecarDir);
  setResearchStore(store);
  registerResearchView(context, store);
}
