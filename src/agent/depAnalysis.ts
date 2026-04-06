import { workspace, Uri } from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface DepAnalysisResult {
  packageManager: string;
  totalDeps: number;
  prodDeps: string[];
  devDeps: string[];
  unusedDeps: string[];
  outdatedInfo: string;
}

/**
 * Analyze project dependencies — works for Node.js projects.
 * Returns dependency counts, lists, and checks for unused deps.
 */
export async function analyzeDependencies(): Promise<string> {
  const rootUri = workspace.workspaceFolders?.[0]?.uri;
  if (!rootUri) return 'No workspace folder open.';
  const cwd = rootUri.fsPath;

  // Try package.json first (Node.js)
  try {
    const pkgBytes = await workspace.fs.readFile(Uri.joinPath(rootUri, 'package.json'));
    const pkg = JSON.parse(Buffer.from(pkgBytes).toString('utf-8'));
    return await analyzeNodeDeps(pkg, cwd);
  } catch {
    // no package.json
  }

  // Try pyproject.toml (Python)
  try {
    await workspace.fs.stat(Uri.joinPath(rootUri, 'pyproject.toml'));
    return await analyzePythonDeps(cwd);
  } catch {
    // not found
  }

  // Try go.mod (Go)
  try {
    await workspace.fs.stat(Uri.joinPath(rootUri, 'go.mod'));
    return await analyzeGoDeps(cwd);
  } catch {
    // not found
  }

  return 'No supported package manifest found (package.json, pyproject.toml, go.mod).';
}

async function analyzeNodeDeps(pkg: Record<string, unknown>, cwd: string): Promise<string> {
  const deps = Object.keys((pkg.dependencies as Record<string, string>) || {});
  const devDeps = Object.keys((pkg.devDependencies as Record<string, string>) || {});

  const lines = [
    '# Dependency Analysis',
    '',
    `**Package:** ${pkg.name || 'unknown'}`,
    `**Version:** ${pkg.version || 'unknown'}`,
    '',
    '## Summary',
    '',
    `| Type | Count |`,
    `|------|-------|`,
    `| Production | ${deps.length} |`,
    `| Development | ${devDeps.length} |`,
    `| **Total** | **${deps.length + devDeps.length}** |`,
  ];

  if (deps.length > 0) {
    lines.push('', '## Production Dependencies', '');
    for (const d of deps.sort()) {
      const ver = (pkg.dependencies as Record<string, string>)[d];
      lines.push(`- \`${d}\` ${ver}`);
    }
  }

  if (devDeps.length > 0) {
    lines.push('', '## Dev Dependencies', '');
    for (const d of devDeps.sort()) {
      const ver = (pkg.devDependencies as Record<string, string>)[d];
      lines.push(`- \`${d}\` ${ver}`);
    }
  }

  // Check for unused deps by scanning source files for imports
  try {
    const unusedProd = await findUnusedNodeDeps(deps, cwd);
    if (unusedProd.length > 0) {
      lines.push('', '## Potentially Unused (production)', '');
      lines.push('> These packages are in dependencies but no import was found in `src/`:');
      lines.push('');
      for (const d of unusedProd) lines.push(`- \`${d}\``);
    }
  } catch {
    // skip unused check
  }

  // Check for outdated
  try {
    const { stdout } = await execAsync('npm outdated --json', { cwd, timeout: 30_000 });
    const outdated = JSON.parse(stdout || '{}');
    const entries = Object.entries(outdated);
    if (entries.length > 0) {
      lines.push('', '## Outdated Packages', '');
      lines.push('| Package | Current | Wanted | Latest |');
      lines.push('|---------|---------|--------|--------|');
      for (const [name, info] of entries) {
        const i = info as { current?: string; wanted?: string; latest?: string };
        lines.push(`| ${name} | ${i.current || '?'} | ${i.wanted || '?'} | ${i.latest || '?'} |`);
      }
    }
  } catch {
    // npm outdated returns non-zero when packages are outdated
  }

  return lines.join('\n');
}

async function findUnusedNodeDeps(deps: string[], cwd: string): Promise<string[]> {
  const unused: string[] = [];
  for (const dep of deps) {
    try {
      const { stdout } = await execAsync(
        `grep -r "${dep}" src/ --include="*.ts" --include="*.js" --include="*.tsx" --include="*.jsx" -l`,
        { cwd, timeout: 10_000 },
      );
      if (!stdout.trim()) unused.push(dep);
    } catch {
      // grep returns non-zero when no matches — that means unused
      unused.push(dep);
    }
  }
  return unused;
}

async function analyzePythonDeps(cwd: string): Promise<string> {
  const lines = ['# Dependency Analysis (Python)', ''];
  try {
    const { stdout } = await execAsync('pip list --format=json', { cwd, timeout: 15_000 });
    const pkgs = JSON.parse(stdout) as { name: string; version: string }[];
    lines.push(`**Installed packages:** ${pkgs.length}`, '');
    lines.push('| Package | Version |');
    lines.push('|---------|---------|');
    for (const p of pkgs.slice(0, 50)) {
      lines.push(`| ${p.name} | ${p.version} |`);
    }
    if (pkgs.length > 50) lines.push(`| ... and ${pkgs.length - 50} more | |`);
  } catch {
    lines.push('Could not list Python packages. Is pip installed?');
  }
  return lines.join('\n');
}

async function analyzeGoDeps(cwd: string): Promise<string> {
  const lines = ['# Dependency Analysis (Go)', ''];
  try {
    const { stdout } = await execAsync('go list -m all', { cwd, timeout: 15_000 });
    const mods = stdout
      .trim()
      .split('\n')
      .filter((l) => l.includes(' '));
    lines.push(`**Module dependencies:** ${mods.length}`, '');
    lines.push('| Module | Version |');
    lines.push('|--------|---------|');
    for (const m of mods.slice(0, 50)) {
      const [name, ver] = m.split(' ');
      lines.push(`| ${name} | ${ver || '?'} |`);
    }
    if (mods.length > 50) lines.push(`| ... and ${mods.length - 50} more | |`);
  } catch {
    lines.push('Could not list Go modules. Is go installed?');
  }
  return lines.join('\n');
}
