import { describe, it, expect, vi, beforeEach } from 'vitest';

const graphMock = {
  fileCount: vi.fn(() => 1),
  getFileContent: vi.fn((_f: string) => undefined as string | undefined),
  getSymbolsInFile: vi.fn((_f: string) => [] as Array<{ name: string; startLine: number; endLine: number }>),
};

vi.mock('./runtime.js', () => ({ getDefaultToolRuntime: () => ({ symbolGraph: graphMock }) }));
vi.mock('./shared.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getRoot: () => '/repo' };
});

import { propertyTestTools } from './propertyTest.js';

const exec = propertyTestTools[0].executor;

const FILE = [
  'def rotate(a, b):', //                line 1 (startLine 0)
  '    # property: symmetric', //        line 2
  '    # bounds: -1 <= result <= 1', //  line 3
  '    return a @ b', //                 line 4
].join('\n');

beforeEach(() => {
  graphMock.fileCount.mockReturnValue(1);
  graphMock.getFileContent.mockReturnValue(FILE);
  graphMock.getSymbolsInFile.mockReturnValue([{ name: 'rotate', startLine: 0, endLine: 3 }]);
});

describe('synthesize_property_test tool', () => {
  it('requires file and function', async () => {
    expect(await exec({ function: 'f' })).toMatch(/`file` and `function` are required/);
    expect(await exec({ file: 'a.py' })).toMatch(/`file` and `function` are required/);
  });

  it('errors when the function is not in the file', async () => {
    graphMock.getSymbolsInFile.mockReturnValue([{ name: 'other', startLine: 0, endLine: 3 }]);
    expect(await exec({ file: 'src/geo.py', function: 'rotate' })).toMatch(/not found/);
  });

  it('prompts to declare properties when the kernel has none', async () => {
    graphMock.getFileContent.mockReturnValue('def rotate(a, b):\n    return a @ b');
    const out = await exec({ file: 'src/geo.py', function: 'rotate' });
    expect(out).toMatch(/declares no properties/);
    expect(out).toContain('# property: symmetric');
  });

  it('emits a runnable Hypothesis test with the dotted module import', async () => {
    const out = await exec({ file: 'src/geo.py', function: 'rotate' });
    expect(out).toContain('```python');
    expect(out).toContain('from src.geo import rotate');
    expect(out).toContain('def test_rotate_properties(a, b):');
    expect(out).toContain('np.allclose(result, rotate(b, a))'); // symmetry
    expect(out).toContain('np.all(result >= -1) and np.all(result <= 1)'); // bound
  });

  it('reports the graph is still indexing when empty', async () => {
    graphMock.fileCount.mockReturnValue(0);
    expect(await exec({ file: 'src/geo.py', function: 'rotate' })).toMatch(/still indexing/);
  });
});
