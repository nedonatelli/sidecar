import { describe, it, expect, vi, beforeEach } from 'vitest';

const graphMock = {
  fileCount: vi.fn(() => 1),
  getFileContent: vi.fn((_p: string) => '' as string | undefined),
  getCallers: vi.fn((_s: string) => [] as Array<{ callerName: string; callerFile: string; line: number }>),
  getCallees: vi.fn((_s: string) => [] as Array<{ calleeName: string; callerFile: string; line: number }>),
  findReferences: vi.fn((_s: string, _p?: unknown) => [] as Array<{ file: string; line: number; context: string }>),
  getTypeUsers: vi.fn((_s: string) => [] as Array<{ userName: string; userFile: string; line: number; role: string }>),
};

vi.mock('./runtime.js', () => ({ getDefaultToolRuntime: () => ({ symbolGraph: graphMock }) }));

import { codeGraphQueryTools } from './codeGraphQuery.js';
const exec = codeGraphQueryTools[0].executor;

beforeEach(() => {
  graphMock.fileCount.mockReturnValue(1);
  graphMock.getCallers.mockReturnValue([{ callerName: 'handleLogin', callerFile: 'auth/routes.ts', line: 42 }]);
  graphMock.getCallees.mockReturnValue([{ calleeName: 'hashToken', callerFile: 'auth/core.ts', line: 10 }]);
  graphMock.findReferences.mockReturnValue([{ file: 'auth/core.ts', line: 5, context: 'requireAuth(req)' }]);
  graphMock.getTypeUsers.mockReturnValue([]);
});

describe('query_code_graph', () => {
  it('requires a symbol', async () => {
    expect(await exec({ relation: 'callers' })).toMatch(/`symbol` is required/);
  });

  it('reports the graph is indexing when empty', async () => {
    graphMock.fileCount.mockReturnValue(0);
    expect(await exec({ symbol: 'x' })).toMatch(/still indexing/);
  });

  it('callers relation lists calling functions with locations', async () => {
    const out = await exec({ symbol: 'requireAuth', relation: 'callers' });
    expect(out).toContain('Callers of `requireAuth`');
    expect(out).toContain('handleLogin — auth/routes.ts:42');
  });

  it('callees relation lists what the function calls', async () => {
    const out = await exec({ symbol: 'requireAuth', relation: 'callees' });
    expect(out).toContain('hashToken — auth/core.ts:10');
  });

  it('references relation lists mentions with context', async () => {
    const out = await exec({ symbol: 'requireAuth', relation: 'references' });
    expect(out).toContain('auth/core.ts:5 — requireAuth(req)');
  });

  it('type-users relation includes the role', async () => {
    graphMock.getTypeUsers.mockReturnValue([{ userName: 'login', userFile: 'auth/routes.ts', line: 8, role: 'param' }]);
    const out = await exec({ symbol: 'AuthConfig', relation: 'type-users' });
    expect(out).toContain('login — auth/routes.ts:8 [param]');
  });

  it('neighborhood combines callers + callees + references', async () => {
    const out = await exec({ symbol: 'requireAuth' }); // default relation
    expect(out).toContain('Neighborhood of `requireAuth`');
    expect(out).toContain('Called by');
    expect(out).toContain('Calls');
    expect(out).toContain('Referenced at');
    expect(out).toContain('handleLogin');
    expect(out).toContain('hashToken');
  });

  it('neighborhood reports no edges cleanly', async () => {
    graphMock.getCallers.mockReturnValue([]);
    graphMock.getCallees.mockReturnValue([]);
    graphMock.findReferences.mockReturnValue([]);
    const out = await exec({ symbol: 'orphan' });
    expect(out).toMatch(/no edges in the code graph/);
  });
});
