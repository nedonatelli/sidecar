// ---------------------------------------------------------------------------
// Skill Sync & Registry — git-native distribution across machines/teams.
//
//
// Two tiers beyond the existing project-level `.sidecar/skills/` + user-level
// `~/.claude/commands/`:
//
//   1. **User registry** — one git URL or local folder
//      (`sidecar.skills.userRegistry`). Cloned into
//      `~/.sidecar/user-skills/`. Syncs user-owned skills across
//      machines without any custom service.
//
//   2. **Team registries** — N git URLs (`sidecar.skills.teamRegistries`),
//      each cloned into `~/.sidecar/team-skills/<slug>/`. Tag by
//      origin registry so overlapping teams can resolve collisions.
//
// Not shipping in this chunk: marketplace tier, `autoUpdate` schedule,
// version pinning. Those are follow-ups per the roadmap.
//
// Trust model: a registry URL not in `sidecar.skills.trustedRegistries`
// triggers a first-install prompt via the injected `trustPrompt` callback.
// Prompting is the caller's concern (VS Code modal) so this module stays
// headless and unit-testable.
//
// Offline mode (`sidecar.skills.offline: true`) short-circuits every
// network call — the already-cached clones keep loading via SkillLoader,
// but no pull / clone is attempted.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GitCLI } from '../github/git.js';

export type RegistryTier = 'user' | 'team';

export interface RegistryRef {
  /** Source URL from the user's settings — git remote or local path. */
  url: string;
  /** Absolute local path the SkillLoader will scan. */
  managedDir: string;
  /** Human-readable label for logs / prompts. */
  label: string;
  tier: RegistryTier;
  /** True when `url` resolves to an existing on-disk directory (no clone/pull). */
  isLocal: boolean;
}

export interface SkillSyncConfigSlice {
  skillsUserRegistry: string;
  skillsTeamRegistries: string[];
  skillsAutoPull: 'on-start' | 'hourly' | 'daily' | 'manual';
  skillsTrustedRegistries: string[];
  skillsOffline: boolean;
}

export interface SyncOptions {
  config: SkillSyncConfigSlice;
  /** Absolute home directory — defaults to `os.homedir()`. Testing hook. */
  homeDir?: string;
  /**
   * Called when a registry URL is not in `trustedRegistries` and has no
   * cache yet. Return `true` to proceed with the clone, `false` to
   * skip this registry for the session. Defaults to accepting (useful
   * in headless tests); production callers should wire a VS Code modal.
   */
  trustPrompt?: (ref: RegistryRef) => Promise<boolean>;
  /** Sink for progress / error lines. Defaults to `console.log`. */
  log?: (line: string) => void;
  /** Git client — injectable for tests. */
  git?: GitCLI;
}

/**
 * Run the sync. Returns the list of registries whose `managedDir` is
 * now populated and ready for the SkillLoader to scan. Safe to call
 * multiple times — pulls are idempotent, skipped registries stay
 * skipped, and offline mode returns only cached refs.
 */
export async function syncSkillRegistries(opts: SyncOptions): Promise<RegistryRef[]> {
  const home = opts.homeDir ?? os.homedir();
  const log = opts.log ?? ((line: string) => console.log(line));
  const trustPrompt = opts.trustPrompt ?? (async () => true);
  const git = opts.git ?? new GitCLI(path.join(home, '.sidecar'));
  const trustedUrls = new Set(opts.config.skillsTrustedRegistries);

  const refs = await collectRegistryRefs(opts.config, home);
  const synced: RegistryRef[] = [];

  for (const ref of refs) {
    // Local folders skip git entirely — they're in-place, always "synced."
    if (ref.isLocal) {
      synced.push(ref);
      continue;
    }

    const cached = await fs.promises.access(ref.managedDir).then(
      () => true,
      () => false,
    );

    // Offline mode: keep cached registries but never fetch.
    if (opts.config.skillsOffline) {
      if (cached) synced.push(ref);
      continue;
    }

    // Validate URL scheme to prevent git ext:: and other protocol exploits.
    if (!isAllowedGitUrl(ref.url)) {
      log(
        `[SideCar] Skill registry ${ref.label} skipped — URL scheme not allowed (must be https://, http://, ssh://, or git@).`,
      );
      continue;
    }

    // Trust prompt fires on first install AND whenever the URL is not in the
    // trusted list, regardless of whether a stale cache exists.
    if (!trustedUrls.has(ref.url)) {
      const ok = await trustPrompt(ref);
      if (!ok) {
        log(`[SideCar] Skill registry ${ref.label} skipped — user declined trust.`);
        continue;
      }
    }

    try {
      if (!cached) {
        await fs.promises.mkdir(path.dirname(ref.managedDir), { recursive: true });
        await git.clone(ref.url, ref.managedDir);
        log(`[SideCar] Cloned ${ref.label} into ${ref.managedDir}.`);
      } else if (opts.config.skillsAutoPull === 'on-start') {
        // Pull against the existing clone. GitCLI's `pull()` uses its
        // configured cwd, so make a registry-scoped client.
        const scoped = new GitCLI(ref.managedDir);
        await scoped.pull();
        log(`[SideCar] Pulled ${ref.label}.`);
      }
      synced.push(ref);
    } catch (err) {
      // Use console.warn so persistent pull failures surface in the extension
      // host developer tools rather than being silently swallowed by console.log.
      const msg = err instanceof Error ? err.message : String(err);
      log(`[SideCar] Failed to sync ${ref.label}: ${msg}`);
      console.warn(`[SideCar] Skill registry sync failed for ${ref.label}: ${msg}`);
      // Still include a cached ref even when pull fails — stale skills
      // beat no skills for an offline-ish scenario.
      if (cached) synced.push(ref);
    }
  }

  return synced;
}

/**
 * Translate config slices into `RegistryRef[]`. Exposed for tests and
 * for callers (like the status-bar tooltip) that want to show what
 * registries are configured without actually syncing them.
 */
export async function collectRegistryRefs(config: SkillSyncConfigSlice, homeDir: string): Promise<RegistryRef[]> {
  const refs: RegistryRef[] = [];
  const sidecarDir = path.join(homeDir, '.sidecar');

  if (config.skillsUserRegistry.trim().length > 0) {
    const url = config.skillsUserRegistry.trim();
    const isLocal = await looksLikeLocalPath(url);
    refs.push({
      url,
      managedDir: isLocal ? url : path.join(sidecarDir, 'user-skills'),
      label: 'user registry',
      tier: 'user',
      isLocal,
    });
  }

  for (const rawUrl of config.skillsTeamRegistries) {
    const url = (rawUrl ?? '').trim();
    if (!url) continue;
    const isLocal = await looksLikeLocalPath(url);
    const slug = slugifyRegistryUrl(url);
    refs.push({
      url,
      managedDir: isLocal ? url : path.join(sidecarDir, 'team-skills', slug),
      label: `team registry \`${slug}\``,
      tier: 'team',
      isLocal,
    });
  }

  return refs;
}

/**
 * Validate a git remote URL against an allowlist of safe schemes.
 * Blocks ext::, fd::, and other git transport protocols that can execute
 * arbitrary commands on the local machine.
 */
function isAllowedGitUrl(url: string): boolean {
  return (
    url.startsWith('https://') ||
    url.startsWith('http://') ||
    url.startsWith('ssh://') ||
    url.startsWith('git@') ||
    url.startsWith('git://')
  );
}

/**
 * Decide whether a user-supplied value is a local filesystem path vs a
 * git URL. Uses the "path exists as directory" signal — deliberately
 * conservative because mislabeling a git URL as local would silently
 * skip the clone and leave the registry empty. Absolute-looking paths
 * that don't exist yet are treated as git URLs; if the user actually
 * meant a local path that doesn't exist, they'll see a git-clone
 * failure with the URL they typed, which is the right diagnostic.
 */
async function looksLikeLocalPath(url: string): Promise<boolean> {
  if (!path.isAbsolute(url) && !url.startsWith('~')) return false;
  const expanded = url.startsWith('~') ? path.join(os.homedir(), url.slice(1)) : url;
  try {
    return (await fs.promises.stat(expanded)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Derive a stable directory name from a git URL. Strips the protocol
 * and replaces path separators with dashes so the result is filesystem-
 * safe and readable. Repeated URLs produce repeated slugs — idempotent.
 */
export function slugifyRegistryUrl(url: string): string {
  return url
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^git@/, '')
    .replace(/\.git$/, '')
    .replace(/:/g, '-')
    .replace(/[/\\]/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
