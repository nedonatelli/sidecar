import { workspace, Uri } from 'vscode';
import * as path from 'path';
import type { SideCarClient } from '../ollama/client.js';
import type { ChatMessage } from '../ollama/types.js';
import type { WorkspaceIndex } from '../config/workspaceIndex.js';

const MAX_CONFIG_READ = 8000;

const INIT_SYSTEM_PROMPT = `You are a senior software engineer onboarding onto a new project. Given the project metadata below, write a concise SIDECAR.md file that will help an AI coding assistant understand this codebase.

Structure your output EXACTLY as follows (use these headings):

# Project: <name>

<One-paragraph summary: what this project does, who it's for, what problem it solves.>

## Tech Stack
<Bullet list of languages, frameworks, runtime, key dependencies.>

## Architecture
<Brief description of the project's architecture: entry points, module organization, data flow. Reference specific directories.>

## Key Files & Directories
<Table or bullet list of the most important files/directories and what they do.>

## Development
<How to install, build, run, and test. Use the actual commands from the project's config.>

## Code Conventions
<Observed patterns: naming conventions, file organization, import style, error handling, testing patterns.>

## Important Notes
<Anything unusual or non-obvious: custom tooling, required env vars, gotchas, deployment notes.>

Be specific and concrete — reference actual file paths, command names, and patterns you see in the provided context. Do not include generic advice. If something is unclear from the provided context, omit it rather than guessing.

Output ONLY the markdown content. No preambles, no closing remarks.`;

/** Detect the project name from config files or workspace folder name. */
function detectProjectName(rootPath: string, configs: Map<string, string>): string {
  const pkgJson = configs.get('package.json');
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson);
      if (pkg.name) return pkg.name;
    } catch {
      // ignore
    }
  }
  const pyproject = configs.get('pyproject.toml');
  if (pyproject) {
    const match = pyproject.match(/^name\s*=\s*"([^"]+)"/m);
    if (match) return match[1];
  }
  const cargoToml = configs.get('Cargo.toml');
  if (cargoToml) {
    const match = cargoToml.match(/^name\s*=\s*"([^"]+)"/m);
    if (match) return match[1];
  }
  const goMod = configs.get('go.mod');
  if (goMod) {
    const match = goMod.match(/^module\s+(\S+)/m);
    if (match) return match[1].split('/').pop() || match[1];
  }
  return path.basename(rootPath);
}

/** Read root-level config files that help the LLM understand the project. */
async function readConfigFiles(rootUri: Uri): Promise<Map<string, string>> {
  const configFiles = [
    'package.json',
    'tsconfig.json',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
    'build.gradle',
    'build.gradle.kts',
    'pom.xml',
    'Makefile',
    'CMakeLists.txt',
    'Gemfile',
    'composer.json',
    'README.md',
    '.eslintrc.json',
    '.prettierrc',
    'jest.config.ts',
    'jest.config.js',
    'vitest.config.ts',
    'vite.config.ts',
    'webpack.config.js',
    'Dockerfile',
    'docker-compose.yml',
    'docker-compose.yaml',
    '.env.example',
  ];

  const results = new Map<string, string>();

  for (const fileName of configFiles) {
    try {
      const fileUri = Uri.joinPath(rootUri, fileName);
      const bytes = await workspace.fs.readFile(fileUri);
      let content = Buffer.from(bytes).toString('utf-8');
      if (content.length > MAX_CONFIG_READ) {
        content = content.slice(0, MAX_CONFIG_READ) + '\n... (truncated)';
      }
      results.set(fileName, content);
    } catch {
      // File doesn't exist — skip
    }
  }

  return results;
}

/** Read a sample of source files to help the LLM detect code conventions. */
async function readSampleSourceFiles(rootUri: Uri): Promise<string> {
  const patterns = ['**/*.ts', '**/*.js', '**/*.py', '**/*.go', '**/*.rs', '**/*.java', '**/*.rb'];
  const excludePattern = '**/{node_modules,.git,out,dist,.venv,venv,__pycache__,.next,coverage,build}/**';
  const sampleFiles: string[] = [];
  const maxSamples = 5;
  const maxPerFile = 2000;

  for (const pattern of patterns) {
    if (sampleFiles.length >= maxSamples) break;
    const uris = await workspace.findFiles(pattern, excludePattern, maxSamples - sampleFiles.length);
    for (const uri of uris) {
      if (sampleFiles.length >= maxSamples) break;
      try {
        const stat = await workspace.fs.stat(uri);
        if (stat.size > 50_000) continue; // Skip large files
        const bytes = await workspace.fs.readFile(uri);
        let content = Buffer.from(bytes).toString('utf-8');
        if (content.length > maxPerFile) {
          content = content.slice(0, maxPerFile) + '\n... (truncated)';
        }
        const relPath = path.relative(rootUri.fsPath, uri.fsPath);
        sampleFiles.push(`### ${relPath}\n\`\`\`\n${content}\n\`\`\``);
      } catch {
        // Skip unreadable files
      }
    }
  }

  return sampleFiles.join('\n\n');
}

/** Gather file extension statistics from the workspace index. */
function gatherFileStats(workspaceIndex: WorkspaceIndex | null): string {
  if (!workspaceIndex || workspaceIndex.getFileCount() === 0) return '';

  const extCounts = new Map<string, number>();
  let totalSize = 0;

  for (const file of workspaceIndex.getFiles()) {
    const ext = path.extname(file.relativePath) || '(no ext)';
    extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
    totalSize += file.sizeBytes;
  }

  const sorted = [...extCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const lines = sorted.map(([ext, count]) => `  ${ext}: ${count} files`);

  return [
    `Total files: ${workspaceIndex.getFileCount()}`,
    `Total size: ${(totalSize / 1024).toFixed(0)} KB`,
    '',
    'File types:',
    ...lines,
  ].join('\n');
}

/** Build the full context prompt that the LLM will use to generate SIDECAR.md. */
export async function buildInitContext(workspaceIndex: WorkspaceIndex | null): Promise<string | null> {
  const rootUri = workspace.workspaceFolders?.[0]?.uri;
  if (!rootUri) return null;

  const sections: string[] = [];

  // 1. Config files
  const configs = await readConfigFiles(rootUri);
  if (configs.size > 0) {
    sections.push('## Configuration Files\n');
    for (const [name, content] of configs) {
      sections.push(`### ${name}\n\`\`\`\n${content}\n\`\`\`\n`);
    }
  }

  // 2. File tree from workspace index
  const fileTree = workspaceIndex?.getFileTree();
  if (fileTree) {
    sections.push(`## File Tree\n\`\`\`\n${fileTree}\n\`\`\`\n`);
  }

  // 3. File statistics
  const stats = gatherFileStats(workspaceIndex);
  if (stats) {
    sections.push(`## File Statistics\n\`\`\`\n${stats}\n\`\`\`\n`);
  }

  // 4. Sample source files for convention detection
  const samples = await readSampleSourceFiles(rootUri);
  if (samples) {
    sections.push(`## Sample Source Files\n${samples}\n`);
  }

  // 5. Project name hint
  const projectName = detectProjectName(rootUri.fsPath, configs);
  sections.unshift(`# Analyzing Project: ${projectName}\n`);

  return sections.join('\n');
}

/** Generate SIDECAR.md content using the LLM. */
export async function generateInit(
  client: SideCarClient,
  workspaceIndex: WorkspaceIndex | null,
): Promise<string | null> {
  const context = await buildInitContext(workspaceIndex);
  if (!context) return null;

  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: `Analyze this project and generate a SIDECAR.md file:\n\n${context}`,
    },
  ];

  client.updateSystemPrompt(INIT_SYSTEM_PROMPT);

  return client.complete(messages, 4096);
}
