import { workspace } from 'vscode';
import type { ToolDefinition } from '../../ollama/types.js';
import type { RegisteredTool } from './shared.js';
import { detectMonorepo } from '../../config/monorepoDetector.js';

const definition: ToolDefinition = {
  name: 'monorepo_packages',
  description:
    'List all packages discovered in the monorepo. Returns the detected layout type ' +
    '(nx / turbo / pnpm / yarn / lerna) and each package name with its workspace-relative path. ' +
    'Use the `relativePath` as the `pathPrefix` argument to `project_knowledge_search` to scope ' +
    'a semantic symbol search to a single package.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
  nondeterministicOutput: true,
};

export const monorepoPackagesTool: RegisteredTool = {
  definition,
  requiresApproval: false,
  executor: async () => {
    const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'No workspace folder is open.';

    const info = await detectMonorepo(root);

    if (info.packages.length === 0) {
      return info.type === 'none'
        ? 'No monorepo layout detected in this workspace. ' +
            'Expected one of: pnpm-workspace.yaml, nx.json, turbo.json, lerna.json, ' +
            'package.json#workspaces, or a packages/ / apps/ / libs/ / services/ directory.'
        : `Monorepo type: ${info.type} — no packages found under the configured workspace roots.`;
    }

    const lines: string[] = [
      `Monorepo type: **${info.type}**`,
      `Packages (${info.packages.length}):`,
      '',
      '| Name | Path |',
      '|------|------|',
    ];
    for (const pkg of info.packages) {
      lines.push(`| ${pkg.name} | ${pkg.relativePath} |`);
    }
    lines.push(
      '',
      'Tip: pass a `relativePath` value as `pathPrefix` to `project_knowledge_search` ' +
        'to restrict semantic symbol search to that package.',
    );
    return lines.join('\n');
  },
};

export const monorepoTools: RegisteredTool[] = [monorepoPackagesTool];
