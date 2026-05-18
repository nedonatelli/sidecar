import * as nodePath from 'path';
import * as fsPromises from 'fs/promises';

// ---------------------------------------------------------------------------
// Monorepo Detector — auto-discover packages in Nx / Turborepo / pnpm /
// yarn-workspaces / Lerna layouts. No VS Code API dependency so this
// module works in tests without mocking vscode.
// ---------------------------------------------------------------------------

export type MonorepoType = 'nx' | 'turbo' | 'pnpm' | 'yarn' | 'lerna' | 'none';

export interface MonorepoPackage {
  name: string;
  relativePath: string; // forward-slash, relative to workspace root
  absolutePath: string;
}

export interface MonorepoInfo {
  type: MonorepoType;
  packages: MonorepoPackage[];
}

export interface FsAdapter {
  readFile(filePath: string): Promise<string | null>;
  listDir(dirPath: string): Promise<string[]>;
  isDir(filePath: string): Promise<boolean>;
}

const defaultFs: FsAdapter = {
  async readFile(filePath: string): Promise<string | null> {
    try {
      return await fsPromises.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  },
  async listDir(dirPath: string): Promise<string[]> {
    try {
      return await fsPromises.readdir(dirPath);
    } catch {
      return [];
    }
  },
  async isDir(filePath: string): Promise<boolean> {
    try {
      const s = await fsPromises.stat(filePath);
      return s.isDirectory();
    } catch {
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function readPackageName(absPath: string, fs: FsAdapter): Promise<string> {
  const raw = await fs.readFile(nodePath.join(absPath, 'package.json'));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.length > 0) return parsed.name;
    } catch {
      /* malformed package.json — fall through */
    }
  }
  return nodePath.basename(absPath);
}

function toRelPath(...segments: string[]): string {
  return nodePath.join(...segments).replace(/\\/g, '/');
}

async function expandGlob(root: string, pattern: string, fs: FsAdapter): Promise<string[]> {
  const norm = pattern.replace(/^\.\//, '').replace(/\\/g, '/');

  // "packages/*" or "apps/*" — one level wildcard
  if (norm.endsWith('/*') || norm.endsWith('/**')) {
    const baseRel = norm.replace(/\/\*+$/, '');
    const absBase = nodePath.join(root, baseRel);
    const entries = await fs.listDir(absBase);
    const result: string[] = [];
    for (const entry of entries) {
      const abs = nodePath.join(absBase, entry);
      if (await fs.isDir(abs)) {
        result.push(toRelPath(baseRel, entry));
      }
    }
    return result;
  }

  // Literal path
  const abs = nodePath.join(root, norm);
  if (await fs.isDir(abs)) return [norm.replace(/\\/g, '/')];
  return [];
}

async function buildPackages(root: string, patterns: string[], fs: FsAdapter): Promise<MonorepoPackage[]> {
  const seen = new Set<string>();
  const packages: MonorepoPackage[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue; // exclusion patterns
    const dirs = await expandGlob(root, pattern, fs);
    for (const relDir of dirs) {
      if (seen.has(relDir)) continue;
      seen.add(relDir);
      const absPath = nodePath.join(root, relDir);
      const name = await readPackageName(absPath, fs);
      packages.push({ name, relativePath: relDir, absolutePath: absPath });
    }
  }
  return packages;
}

function parsePnpmWorkspaceYaml(content: string): string[] {
  const lines = content.split('\n');
  const result: string[] = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const match = line.match(/^\s*-\s+['"]?(.+?)['"]?\s*$/);
      if (match) {
        result.push(match[1].trim());
      } else if (line.trim() !== '' && !/^\s/.test(line)) {
        inPackages = false;
      }
    }
  }
  return result;
}

function extractWorkspacePatterns(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { workspaces?: unknown };
    if (Array.isArray(parsed.workspaces)) return parsed.workspaces.filter((s): s is string => typeof s === 'string');
    if (parsed.workspaces && typeof parsed.workspaces === 'object') {
      const ws = parsed.workspaces as { packages?: unknown };
      if (Array.isArray(ws.packages)) return ws.packages.filter((s): s is string => typeof s === 'string');
    }
  } catch {
    /* malformed JSON */
  }
  return [];
}

// Fallback: scan conventional monorepo directories (packages/, apps/, libs/, services/)
async function scanDefaultDirs(root: string, fs: FsAdapter): Promise<MonorepoPackage[]> {
  const candidates = ['packages', 'apps', 'libs', 'services'];
  const seen = new Set<string>();
  const results: MonorepoPackage[] = [];
  for (const dir of candidates) {
    const absDir = nodePath.join(root, dir);
    const entries = await fs.listDir(absDir);
    for (const entry of entries) {
      if (entry.startsWith('.') || entry.startsWith('_')) continue;
      const abs = nodePath.join(absDir, entry);
      if (!(await fs.isDir(abs))) continue;
      const relPath = toRelPath(dir, entry);
      if (seen.has(relPath)) continue;
      seen.add(relPath);
      const name = await readPackageName(abs, fs);
      results.push({ name, relativePath: relPath, absolutePath: abs });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function detectMonorepo(root: string, fs: FsAdapter = defaultFs): Promise<MonorepoInfo> {
  // 1. pnpm-workspace.yaml
  const pnpmYaml = await fs.readFile(nodePath.join(root, 'pnpm-workspace.yaml'));
  if (pnpmYaml !== null) {
    const patterns = parsePnpmWorkspaceYaml(pnpmYaml);
    if (patterns.length > 0) {
      return { type: 'pnpm', packages: await buildPackages(root, patterns, fs) };
    }
  }

  // 2. nx.json — detect Nx workspace; read package roots from package.json workspaces or dirs
  const nxJson = await fs.readFile(nodePath.join(root, 'nx.json'));
  if (nxJson !== null) {
    const rootPkg = await fs.readFile(nodePath.join(root, 'package.json'));
    const patterns = extractWorkspacePatterns(rootPkg);
    const pkgs = patterns.length > 0 ? await buildPackages(root, patterns, fs) : await scanDefaultDirs(root, fs);
    return { type: 'nx', packages: pkgs };
  }

  // 3. turbo.json — Turborepo delegates workspace protocol to npm/pnpm/yarn
  const turboJson = await fs.readFile(nodePath.join(root, 'turbo.json'));
  if (turboJson !== null) {
    const rootPkg = await fs.readFile(nodePath.join(root, 'package.json'));
    const patterns = extractWorkspacePatterns(rootPkg);
    const pkgs = patterns.length > 0 ? await buildPackages(root, patterns, fs) : await scanDefaultDirs(root, fs);
    return { type: 'turbo', packages: pkgs };
  }

  // 4. lerna.json
  const lernaJson = await fs.readFile(nodePath.join(root, 'lerna.json'));
  if (lernaJson !== null) {
    try {
      const parsed = JSON.parse(lernaJson) as { packages?: unknown };
      const patterns = Array.isArray(parsed.packages)
        ? parsed.packages.filter((s): s is string => typeof s === 'string')
        : ['packages/*'];
      return { type: 'lerna', packages: await buildPackages(root, patterns, fs) };
    } catch {
      /* malformed — fall through */
    }
  }

  // 5. package.json workspaces (yarn / npm)
  const rootPkg = await fs.readFile(nodePath.join(root, 'package.json'));
  const patterns = extractWorkspacePatterns(rootPkg);
  if (patterns.length > 0) {
    return { type: 'yarn', packages: await buildPackages(root, patterns, fs) };
  }

  // 6. Structural fallback: conventional directories
  const fallback = await scanDefaultDirs(root, fs);
  if (fallback.length > 0) {
    return { type: 'none', packages: fallback };
  }

  return { type: 'none', packages: [] };
}
