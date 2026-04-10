/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  disposeShellSession,
  TOOL_REGISTRY,
  SPAWN_AGENT_DEFINITION,
  getToolDefinitions,
  findTool,
  setSymbolGraph,
} from './tools.js';
import type { MCPManager } from './mcpManager.js';

// Mock vscode
vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/test-workspace' } }],
    fs: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      createDirectory: vi.fn(),
      readDirectory: vi.fn(),
      stat: vi.fn(),
    },
    findFiles: vi.fn(),
    getDiagnostics: vi.fn(),
  },
  languages: {
    getDiagnostics: vi.fn(),
  },
  Uri: {
    joinPath: (base: any, ...segs: string[]) => {
      const joined = base.fsPath + '/' + segs.join('/');
      return { fsPath: joined, path: joined };
    },
    file: (p: string) => ({ fsPath: p, path: p }),
  },
}));

// Mock config/settings
vi.mock('../config/settings.js', () => ({
  getConfig: vi.fn(() => ({
    shellMaxOutputMB: 10,
    shellTimeout: 120,
    customTools: [],
  })),
}));

// Mock terminal/shellSession
vi.mock('../terminal/shellSession.js', () => ({
  ShellSession: vi.fn(() => ({
    isAlive: true,
    dispose: vi.fn(),
    execute: vi.fn(),
    checkBackground: vi.fn(),
    executeBackground: vi.fn(),
  })),
}));

// Mock github/git
vi.mock('../github/git.js', () => ({
  GitCLI: vi.fn(() => ({
    diff: vi.fn(),
    status: vi.fn(),
    stage: vi.fn(),
    commit: vi.fn(),
    log: vi.fn(),
    push: vi.fn(),
    pull: vi.fn(),
    getCurrentBranch: vi.fn(),
    createBranch: vi.fn(),
    switchBranch: vi.fn(),
    listBranches: vi.fn(),
    stash: vi.fn(),
  })),
}));

// Mock agent/securityScanner
vi.mock('./securityScanner.js', () => ({
  scanFile: vi.fn(() => Promise.resolve([])),
  formatIssues: vi.fn(() => ''),
}));

// Mock webSearch
vi.mock('./webSearch.js', () => ({
  searchWeb: vi.fn(() => Promise.resolve([])),
  formatSearchResults: vi.fn(() => ''),
  checkInternetConnectivity: vi.fn(() => Promise.resolve(true)),
}));

describe('tools.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disposeShellSession();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('TOOL_REGISTRY', () => {
    it('should have defined tool registry', () => {
      expect(TOOL_REGISTRY).toBeDefined();
      expect(Array.isArray(TOOL_REGISTRY)).toBe(true);
      expect(TOOL_REGISTRY.length).toBeGreaterThan(0);
    });

    it('should have read_file tool', () => {
      const readFileTool = TOOL_REGISTRY.find((t) => t.definition.name === 'read_file');
      expect(readFileTool).toBeDefined();
      expect(readFileTool?.requiresApproval).toBe(false);
      expect(readFileTool?.definition.input_schema.properties.path).toBeDefined();
    });

    it('should have write_file tool with approval requirement', () => {
      const writeFileTool = TOOL_REGISTRY.find((t) => t.definition.name === 'write_file');
      expect(writeFileTool).toBeDefined();
      expect(writeFileTool?.requiresApproval).toBe(true);
      expect(writeFileTool?.definition.input_schema.properties.content).toBeDefined();
    });

    it('should have edit_file tool with approval requirement', () => {
      const editFileTool = TOOL_REGISTRY.find((t) => t.definition.name === 'edit_file');
      expect(editFileTool).toBeDefined();
      expect(editFileTool?.requiresApproval).toBe(true);
    });

    it('should have search_files tool', () => {
      const searchTool = TOOL_REGISTRY.find((t) => t.definition.name === 'search_files');
      expect(searchTool).toBeDefined();
      expect(searchTool?.requiresApproval).toBe(false);
    });

    it('should have run_command tool with approval', () => {
      const runCmdTool = TOOL_REGISTRY.find((t) => t.definition.name === 'run_command');
      expect(runCmdTool).toBeDefined();
      expect(runCmdTool?.requiresApproval).toBe(true);
    });

    it('should have git tools', () => {
      const gitTools = TOOL_REGISTRY.filter((t) => t.definition.name.startsWith('git_'));
      expect(gitTools.length).toBeGreaterThan(0);

      const gitToolNames = gitTools.map((t) => t.definition.name);
      expect(gitToolNames).toContain('git_diff');
      expect(gitToolNames).toContain('git_status');
      expect(gitToolNames).toContain('git_commit');
      expect(gitToolNames).toContain('git_push');
      expect(gitToolNames).toContain('git_pull');
    });

    it('should have web_search tool', () => {
      const searchTool = TOOL_REGISTRY.find((t) => t.definition.name === 'web_search');
      expect(searchTool).toBeDefined();
      expect(searchTool?.requiresApproval).toBe(false);
    });

    it('should have list_directory tool', () => {
      const listTool = TOOL_REGISTRY.find((t) => t.definition.name === 'list_directory');
      expect(listTool).toBeDefined();
      expect(listTool?.requiresApproval).toBe(false);
    });

    it('should have get_diagnostics tool', () => {
      const diagTool = TOOL_REGISTRY.find((t) => t.definition.name === 'get_diagnostics');
      expect(diagTool).toBeDefined();
      expect(diagTool?.requiresApproval).toBe(false);
    });

    it('should have run_tests tool', () => {
      const testTool = TOOL_REGISTRY.find((t) => t.definition.name === 'run_tests');
      expect(testTool).toBeDefined();
      expect(testTool?.requiresApproval).toBe(true);
    });
  });

  describe('SPAWN_AGENT_DEFINITION', () => {
    it('should define spawn_agent tool', () => {
      expect(SPAWN_AGENT_DEFINITION).toBeDefined();
      expect(SPAWN_AGENT_DEFINITION.name).toBe('spawn_agent');
      expect(SPAWN_AGENT_DEFINITION.input_schema.properties.task).toBeDefined();
    });
  });

  describe('getToolDefinitions', () => {
    it('should return built-in tool definitions without mcp manager', () => {
      const defs = getToolDefinitions();
      expect(Array.isArray(defs)).toBe(true);
      expect(defs.length).toBeGreaterThan(0);

      // Check for expected tools
      const names = defs.map((d) => d.name);
      expect(names).toContain('read_file');
      expect(names).toContain('write_file');
      expect(names).toContain('spawn_agent');
    });

    it('should include MCP tools when manager provided', () => {
      const mockMcpManager = {
        getToolDefinitions: vi.fn(() => [
          {
            name: 'test_mcp_tool',
            description: 'Test MCP tool',
            input_schema: { type: 'object', properties: {} },
          },
        ]),
        getTool: vi.fn(),
      } as any as MCPManager;

      const defs = getToolDefinitions(mockMcpManager);
      const names = defs.map((d) => d.name);
      expect(names).toContain('test_mcp_tool');
    });

    it('should include custom tools from config', () => {
      // Custom tools are loaded from config, which we've mocked
      const defs = getToolDefinitions();
      expect(Array.isArray(defs)).toBe(true);
    });
  });

  describe('findTool', () => {
    it('should find built-in tool by name', () => {
      const tool = findTool('read_file');
      expect(tool).toBeDefined();
      expect(tool?.definition.name).toBe('read_file');
      expect(tool?.executor).toBeDefined();
    });

    it('should return undefined for unknown tool without MCP manager', () => {
      const tool = findTool('unknown_tool');
      expect(tool).toBeUndefined();
    });

    it('should find MCP tool when manager provided', () => {
      const mockMcpManager = {
        getTool: vi.fn((name) =>
          name === 'mcp_tool' ? { definition: { name: 'mcp_tool' }, executor: () => {} } : undefined,
        ),
        getToolDefinitions: vi.fn(() => []),
      } as any as MCPManager;

      const tool = findTool('mcp_tool', mockMcpManager);
      expect(tool).toBeDefined();
      expect(mockMcpManager.getTool).toHaveBeenCalledWith('mcp_tool');
    });

    it('should find multiple tools by different names', () => {
      const tools = ['read_file', 'write_file', 'edit_file', 'run_command'];
      for (const toolName of tools) {
        const tool = findTool(toolName);
        expect(tool).toBeDefined();
        expect(tool?.definition.name).toBe(toolName);
      }
    });
  });

  describe('disposeShellSession', () => {
    it('should be callable without error', () => {
      expect(() => disposeShellSession()).not.toThrow();
    });

    it('should be safe to call multiple times', () => {
      expect(() => {
        disposeShellSession();
        disposeShellSession();
      }).not.toThrow();
    });
  });

  describe('setSymbolGraph', () => {
    it('should accept a symbol graph', () => {
      const mockGraph = {
        lookupSymbol: vi.fn(() => []),
        getDependents: vi.fn(() => []),
        findReferences: vi.fn(() => []),
      } as any;

      expect(() => setSymbolGraph(mockGraph)).not.toThrow();
    });
  });

  describe('tool input schemas', () => {
    it('should have well-formed input schemas', () => {
      for (const tool of TOOL_REGISTRY) {
        const schema = tool.definition.input_schema;
        expect(schema.type).toBe('object');
        expect(schema.properties).toBeDefined();
        if (schema.required && schema.required.length > 0) {
          for (const req of schema.required) {
            expect(schema.properties[req]).toBeDefined();
          }
        }
      }
    });

    it('read_file should have path as required property', () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'read_file');
      expect(tool?.definition.input_schema.required).toContain('path');
    });

    it('write_file should require path and content', () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'write_file');
      expect(tool?.definition.input_schema.required).toContain('path');
      expect(tool?.definition.input_schema.required).toContain('content');
    });

    it('edit_file should require search and replace text', () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'edit_file');
      expect(tool?.definition.input_schema.required).toContain('search');
      expect(tool?.definition.input_schema.required).toContain('replace');
    });

    it('git_commit should require message', () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'git_commit');
      expect(tool?.definition.input_schema.required).toContain('message');
    });
  });

  describe('tool executors - basic validation', () => {
    it('should have executor function for each tool', async () => {
      for (const tool of TOOL_REGISTRY) {
        expect(tool.executor).toBeDefined();
        expect(typeof tool.executor).toBe('function');
      }
    });

    it('readFile executor should reject empty paths', async () => {
      const readFileTool = TOOL_REGISTRY.find((t) => t.definition.name === 'read_file');
      const result = await readFileTool!.executor({ path: '' });
      expect(result).toContain('Error');
      expect(result.toLowerCase()).toContain('empty');
    });

    it('readFile executor should reject paths with backticks', async () => {
      const readFileTool = TOOL_REGISTRY.find((t) => t.definition.name === 'read_file');
      const result = await readFileTool!.executor({ path: 'file`name.txt' });
      expect(result).toContain('Error');
      expect(result).toContain('invalid');
    });

    it('readFile executor should reject absolute paths', async () => {
      const readFileTool = TOOL_REGISTRY.find((t) => t.definition.name === 'read_file');
      const result = await readFileTool!.executor({ path: '/etc/passwd' });
      expect(result).toContain('Error');
      expect(result.toLowerCase()).toContain('absolute');
    });

    it('readFile executor should reject path traversal', async () => {
      const readFileTool = TOOL_REGISTRY.find((t) => t.definition.name === 'read_file');
      const result = await readFileTool!.executor({ path: '../../../etc/passwd' });
      expect(result).toContain('Error');
      expect(result).toContain('..');
    });

    it('readFile executor should warn about sensitive files', async () => {
      const readFileTool = TOOL_REGISTRY.find((t) => t.definition.name === 'read_file');
      const result = await readFileTool!.executor({ path: '.env' });
      expect(result).toContain('Warning');
      expect(result.toLowerCase()).toContain('secret');
    });

    it('readFile executor should warn about .pem files', async () => {
      const readFileTool = TOOL_REGISTRY.find((t) => t.definition.name === 'read_file');
      const result = await readFileTool!.executor({ path: 'key.pem' });
      expect(result).toContain('Warning');
    });

    it('readFile executor should warn about .key files', async () => {
      const readFileTool = TOOL_REGISTRY.find((t) => t.definition.name === 'read_file');
      const result = await readFileTool!.executor({ path: 'secret.key' });
      expect(result).toContain('Warning');
    });

    it('readFile executor should warn about credentials.json', async () => {
      const readFileTool = TOOL_REGISTRY.find((t) => t.definition.name === 'read_file');
      const result = await readFileTool!.executor({ path: 'credentials.json' });
      expect(result).toContain('Warning');
    });

    it('readFile executor should warn about id_rsa', async () => {
      const readFileTool = TOOL_REGISTRY.find((t) => t.definition.name === 'read_file');
      const result = await readFileTool!.executor({ path: 'id_rsa' });
      expect(result).toContain('Warning');
    });

    it('readFile executor should warn about token.json', async () => {
      const readFileTool = TOOL_REGISTRY.find((t) => t.definition.name === 'read_file');
      const result = await readFileTool!.executor({ path: 'token.json' });
      expect(result).toContain('Warning');
    });

    it('writeFile executor should reject empty paths', async () => {
      const writeFileTool = TOOL_REGISTRY.find((t) => t.definition.name === 'write_file');
      const result = await writeFileTool!.executor({ path: '', content: 'test' });
      expect(result).toContain('Error');
    });

    it('editFile executor should reject empty paths', async () => {
      const editFileTool = TOOL_REGISTRY.find((t) => t.definition.name === 'edit_file');
      const result = await editFileTool!.executor({ path: '', search: 'a', replace: 'b' });
      expect(result).toContain('Error');
    });

    it('editFile executor should reject path traversal', async () => {
      const editFileTool = TOOL_REGISTRY.find((t) => t.definition.name === 'edit_file');
      const result = await editFileTool!.executor({ path: '../../etc/passwd', search: 'a', replace: 'b' });
      expect(result).toContain('Error');
    });
  });

  describe('displayDiagram executor', () => {
    it('should exist in tool registry', () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'display_diagram');
      expect(tool).toBeDefined();
      expect(tool?.requiresApproval).toBe(false);
    });

    it('should have path as required', () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'display_diagram');
      expect(tool?.definition.input_schema.required).toContain('path');
    });

    it('should reject invalid paths', async () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'display_diagram');
      const result = await tool!.executor({ path: '../../../etc/passwd' });
      expect(result).toContain('Error');
    });
  });

  describe('find_references executor', () => {
    it('should exist in tool registry', () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'find_references');
      expect(tool).toBeDefined();
    });

    it('should require symbol parameter', () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'find_references');
      expect(tool?.definition.input_schema.required).toContain('symbol');
    });

    it('should handle missing symbol graph gracefully', async () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'find_references');
      // Clear symbol graph to test unavailable case
      setSymbolGraph(null as any);
      const result = await tool!.executor({ symbol: 'testSymbol' });
      expect(result).toContain('not available');
    });

    it('should handle empty symbol name when graph is available', async () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'find_references');
      // Set a mock symbol graph
      const mockGraph = {
        lookupSymbol: vi.fn(() => []),
        getDependents: vi.fn(() => []),
        findReferences: vi.fn(() => []),
      } as any;
      setSymbolGraph(mockGraph);
      const result = await tool!.executor({ symbol: '' });
      expect(result).toContain('Error');
    });
  });

  describe('web_search executor', () => {
    it('should exist in tool registry', () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'web_search');
      expect(tool).toBeDefined();
    });

    it('should require query parameter', () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'web_search');
      expect(tool?.definition.input_schema.required).toContain('query');
    });

    it('should handle empty query', async () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'web_search');
      const result = await tool!.executor({ query: '' });
      expect(result).toContain('Error');
    });
  });

  describe('approval requirements', () => {
    it('file-modifying tools should require approval', () => {
      const approval = TOOL_REGISTRY.filter((t) => t.requiresApproval);
      const names = approval.map((t) => t.definition.name);

      expect(names).toContain('write_file');
      expect(names).toContain('edit_file');
      expect(names).toContain('run_command');
      expect(names).toContain('git_stage');
      expect(names).toContain('git_commit');
    });

    it('read-only tools should not require approval', () => {
      const readOnly = TOOL_REGISTRY.filter((t) => !t.requiresApproval);
      const names = readOnly.map((t) => t.definition.name);

      expect(names).toContain('read_file');
      expect(names).toContain('search_files');
      expect(names).toContain('git_status');
      expect(names).toContain('git_diff');
    });
  });

  describe('tool descriptions', () => {
    it('should have non-empty descriptions for all tools', () => {
      for (const tool of TOOL_REGISTRY) {
        expect(tool.definition.description).toBeDefined();
        expect(tool.definition.description.length).toBeGreaterThan(0);
      }
    });

    it('SPAWN_AGENT_DEFINITION should have description', () => {
      expect(SPAWN_AGENT_DEFINITION.description).toBeDefined();
      expect(SPAWN_AGENT_DEFINITION.description.length).toBeGreaterThan(0);
    });
  });

  describe('run_command executor', () => {
    it('should exist in tool registry with approval', () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'run_command');
      expect(tool).toBeDefined();
      expect(tool?.requiresApproval).toBe(true);
    });

    it('should have command as required parameter', () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'run_command');
      expect(tool?.definition.input_schema.required).toContain('command');
    });
  });

  describe('list_directory executor', () => {
    it('should exist in tool registry', () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'list_directory');
      expect(tool).toBeDefined();
    });

    it('should have path as optional parameter', () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'list_directory');
      expect(tool?.definition.input_schema.properties.path).toBeDefined();
    });
  });

  describe('git tools collection', () => {
    const gitToolNames = [
      'git_diff',
      'git_status',
      'git_stage',
      'git_commit',
      'git_log',
      'git_push',
      'git_pull',
      'git_branch',
      'git_stash',
    ];

    for (const toolName of gitToolNames) {
      it(`should have ${toolName} tool`, () => {
        const tool = TOOL_REGISTRY.find((t) => t.definition.name === toolName);
        expect(tool).toBeDefined();
        expect(tool?.definition.description).toBeDefined();
      });
    }
  });

  describe('search_files executor', () => {
    it('should exist in tool registry', () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'search_files');
      expect(tool).toBeDefined();
    });

    it('should have pattern as required parameter', () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'search_files');
      expect(tool?.definition.input_schema.required).toContain('pattern');
    });
  });

  describe('grep executor', () => {
    it('should exist in tool registry', () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'grep');
      expect(tool).toBeDefined();
    });

    it('should have pattern as required parameter', () => {
      const tool = TOOL_REGISTRY.find((t) => t.definition.name === 'grep');
      expect(tool?.definition.input_schema.required).toContain('pattern');
    });
  });
});
