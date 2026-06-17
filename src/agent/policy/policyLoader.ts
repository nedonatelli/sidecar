import * as fs from 'fs';
import { logger } from '../../system/logger.js';
import * as path from 'path';

export type ToolPermLevel = 'allow' | 'ask' | 'deny';

export interface RepoPolicy {
  version: 1;
  toolPermissions?: Record<string, ToolPermLevel>;
}

const PERM_ORDER: Record<ToolPermLevel, number> = { allow: 0, ask: 1, deny: 2 };

export function mergePermLevel(user: ToolPermLevel | undefined, policy: ToolPermLevel): ToolPermLevel {
  if (user === undefined) return policy;
  return PERM_ORDER[user] >= PERM_ORDER[policy] ? user : policy;
}

let activePolicy: RepoPolicy | null = null;

export function setActivePolicy(policy: RepoPolicy | null): void {
  activePolicy = policy;
}

export function getActivePolicy(): RepoPolicy | null {
  return activePolicy;
}

export async function loadRepoPolicy(workspaceRoot: string): Promise<RepoPolicy | null> {
  const policyPath = path.join(workspaceRoot, '.sidecar', 'policy.json');
  let raw: string;
  try {
    raw = await fs.promises.readFile(policyPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('[SideCar] Failed to read .sidecar/policy.json:', err);
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn('[SideCar] .sidecar/policy.json is not valid JSON — ignored');
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || (parsed as Record<string, unknown>).version !== 1) {
    logger.warn('[SideCar] .sidecar/policy.json must have "version": 1 — ignored');
    return null;
  }

  return parsed as RepoPolicy;
}
