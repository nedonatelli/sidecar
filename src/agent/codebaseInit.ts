import { workspace, Uri } from 'vscode';
import * as path from 'path';
import type { SideCarClient } from '../ollama/client.js';
import type { ChatMessage } from '../ollama/types.js';
import type { WorkspaceIndex } from '../config/workspaceIndex.js';

const MAX_CONFIG_READ = 8000;

const INIT_SYSTEM_PROMPT = `You are a senior software engineer onboarding onto a new project. Given the project metadata below, write a concise SIDECAR.md file that will help an AI coding assistant understand this codebase quickly and accurately.

Structure your output EXACTLY as follows (use these headings):

# Project: <name>

<One-paragraph summary: what this project does, who it's for, and what makes it different from similar tools. Focus on the unique value proposition — not a generic description that could apply to any project in this space.>

## Tech Stack
<Bullet list of languages, frameworks, runtime, and key dependencies. Only include dependencies that are architecturally significant — skip trivial utilities.>

## Architecture
<Describe the high-level architecture: entry points, module boundaries, data flow, and key design patterns (e.g., event-driven, plugin-based, MVC). Reference specific directories and explain HOW they relate to each other, not just what they contain. If there are multiple subsystems, explain how they communicate.>

## Key Files & Directories
<Markdown table of the most important files/directories with a brief description of each. Prioritize: entry points, core business logic, configuration, and public API surfaces. Skip test files, build output, and generated code.>

## Development
<How to install, build, run, and test. Use the EXACT commands from the project's config files. Include any prerequisites (runtime versions, required services, env setup).>

## Code Conventions
<Patterns observed in the sample source files: naming conventions (files, functions, variables), module/import style, error handling approach, testing patterns, and any project-specific idioms. Only list conventions you can actually see evidence for.>

## Important Notes
<Non-obvious things that would trip up a new contributor or an AI assistant: custom tooling, required environment variables, unusual build steps, deployment gotchas, areas of active refactoring, or files/directories with special significance that aren't obvious from their names. If a CLAUDE.md or similar AI-instruction file exists, mention it.>

Rules:
- Be specific and concrete — reference actual file paths, command names, and patterns from the provided context.
- Do not include generic advice or boilerplate that could apply to any project.
- If something is unclear from the provided context, omit it rather than guessing.
- Keep the entire document under 120 lines — brevity matters more than completeness.

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

/** Common entry-point file names to prioritize when sampling. */
const ENTRY_POINT_PATTERNS = [
  '**/main.{ts,js,py,go,rs,java,rb}',
  '**/index.{ts,js}',
  '**/app.{ts,js,py}',
  '**/extension.{ts,js}',
  '**/mod.rs',
  '**/lib.rs',
  '**/server.{ts,js,py,go}',
  '**/cli.{ts,js,py}',
];

const SOURCE_PATTERNS = ['**/*.ts', '**/*.js', '**/*.py', '**/*.go', '**/*.rs', '**/*.java', '**/*.rb'];
const EXCLUDE_PATTERN = '**/{node_modules,.git,out,dist,.venv,venv,__pycache__,.next,coverage,build,.sidecar}/**';

/** Read a sample of source files to help the LLM detect code conventions.
 *  Prioritizes entry-point files, then samples from distinct directories for diversity. */
async function readSampleSourceFiles(rootUri: Uri): Promise<string> {
  const sampleFiles: string[] = [];
  const seenPaths = new Set<string>();
  const seenDirs = new Set<string>();
  const maxSamples = 8;
  const maxPerFile = 2000;

  async function addFile(uri: Uri): Promise<boolean> {
    const relPath = path.relative(rootUri.fsPath, uri.fsPath);
    if (seenPaths.has(relPath)) return false;
    try {
      const stat = await workspace.fs.stat(uri);
      if (stat.size > 50_000) return false;
      const bytes = await workspace.fs.readFile(uri);
      let content = Buffer.from(bytes).toString('utf-8');
      if (content.length > maxPerFile) {
        content = content.slice(0, maxPerFile) + '\n... (truncated)';
      }
      seenPaths.add(relPath);
      seenDirs.add(path.dirname(relPath));
      sampleFiles.push(`### ${relPath}\n\`\`\`\n${content}\n\`\`\``);
      return true;
    } catch {
      return false;
    }
  }

  // Phase 1: grab entry-point files first
  for (const pattern of ENTRY_POINT_PATTERNS) {
    if (sampleFiles.length >= maxSamples) break;
    const uris = await workspace.findFiles(pattern, EXCLUDE_PATTERN, 3);
    for (const uri of uris) {
      if (sampleFiles.length >= maxSamples) break;
      await addFile(uri);
    }
  }

  // Phase 2: fill remaining slots from diverse directories
  for (const pattern of SOURCE_PATTERNS) {
    if (sampleFiles.length >= maxSamples) break;
    const uris = await workspace.findFiles(pattern, EXCLUDE_PATTERN, 20);
    for (const uri of uris) {
      if (sampleFiles.length >= maxSamples) break;
      const relPath = path.relative(rootUri.fsPath, uri.fsPath);
      const dir = path.dirname(relPath);
      // Prefer files from directories we haven't seen yet
      if (seenDirs.has(dir)) continue;
      await addFile(uri);
    }
  }

  // Phase 3: if still under quota, fill from any remaining files
  if (sampleFiles.length < maxSamples) {
    for (const pattern of SOURCE_PATTERNS) {
      if (sampleFiles.length >= maxSamples) break;
      const uris = await workspace.findFiles(pattern, EXCLUDE_PATTERN, 20);
      for (const uri of uris) {
        if (sampleFiles.length >= maxSamples) break;
        await addFile(uri);
      }
    }
  }

  return sampleFiles.join('\n\n');
}

/** Read CLAUDE.md or similar AI instruction files if they exist. */
async function readAIInstructions(rootUri: Uri): Promise<string> {
  const candidates = ['CLAUDE.md', '.claude/CLAUDE.md', '.github/copilot-instructions.md', 'AGENTS.md'];
  const found: string[] = [];

  for (const candidate of candidates) {
    try {
      const fileUri = Uri.joinPath(rootUri, candidate);
      const bytes = await workspace.fs.readFile(fileUri);
      let content = Buffer.from(bytes).toString('utf-8');
      if (content.length > MAX_CONFIG_READ) {
        content = content.slice(0, MAX_CONFIG_READ) + '\n... (truncated)';
      }
      found.push(`### ${candidate}\n\`\`\`\n${content}\n\`\`\``);
    } catch {
      // Doesn't exist — skip
    }
  }

  return found.join('\n\n');
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

  // 5. Existing AI instruction files (CLAUDE.md, etc.)
  const aiInstructions = await readAIInstructions(rootUri);
  if (aiInstructions) {
    sections.push(`## Existing AI Instructions\n${aiInstructions}\n`);
  }

  // 6. Project name hint
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
