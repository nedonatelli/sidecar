import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { profileCode } from './profiling.js';
import type { ToolExecutorContext } from './shared.js';

// ---------------------------------------------------------------------------
// Tests for profiling.ts — profile_code tool.
//
// All shell execution is stubbed via the toolRuntime mock so no real
// processes are spawned. Tests cover:
//   - disabled guard (profilingEnabled = false)
//   - ecosystem auto-detection (node/python/go/rust)
//   - script-required guard for node and python
//   - no output fallback
//   - parse hotspots: python cProfile, go bench, rust bench, node --prof
//   - raw-output fallback when no structured hotspots found
//   - shell errors
// ---------------------------------------------------------------------------

function makeSession(stdout: string, exitCode = 0, throws?: Error) {
  return {
    execute: vi.fn(async () => {
      if (throws) throw throws;
      return { stdout, exitCode, timedOut: false };
    }),
    executeBackground: vi.fn(),
    checkBackground: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeRuntime(session: ReturnType<typeof makeSession>) {
  return { getShellSession: vi.fn(() => session) };
}

function makeContext(
  profilingEnabled: boolean,
  topN: number,
  session: ReturnType<typeof makeSession>,
): ToolExecutorContext {
  return {
    config: { profilingEnabled, profilingTopN: topN } as never,
    toolRuntime: makeRuntime(session) as never,
  } as ToolExecutorContext;
}

// Stub workspace.fs.stat so ecosystem detection works
vi.mock('vscode', async (importOriginal) => {
  const mod = await importOriginal<typeof import('vscode')>();
  return {
    ...mod,
    workspace: {
      ...mod.workspace,
      fs: {
        stat: vi.fn().mockRejectedValue(new Error('not found')),
      },
    },
  };
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('profileCode — guard paths', () => {
  it('returns disabled message when profilingEnabled is false', async () => {
    const session = makeSession('');
    const ctx = makeContext(false, 10, session);
    const result = await profileCode({}, ctx);
    expect(result).toContain('disabled');
    expect(session.execute).not.toHaveBeenCalled();
  });

  it('returns ecosystem-detection error when no manifest files are found', async () => {
    const session = makeSession('');
    const ctx = makeContext(true, 10, session);
    const result = await profileCode({}, ctx);
    expect(result).toContain('Could not detect');
    expect(session.execute).not.toHaveBeenCalled();
  });

  it('returns script-required error for node without script', async () => {
    const session = makeSession('');
    const ctx = makeContext(true, 10, session);
    const result = await profileCode({ ecosystem: 'node' }, ctx);
    expect(result).toContain('requires a `script` parameter');
    expect(session.execute).not.toHaveBeenCalled();
  });

  it('returns script-required error for python without script', async () => {
    const session = makeSession('');
    const ctx = makeContext(true, 10, session);
    const result = await profileCode({ ecosystem: 'python' }, ctx);
    expect(result).toContain('requires a `script` parameter');
    expect(session.execute).not.toHaveBeenCalled();
  });

  it('returns error message when session.execute throws', async () => {
    const session = makeSession('', 0, new Error('shell broken'));
    const ctx = makeContext(true, 10, session);
    const result = await profileCode({ ecosystem: 'go' }, ctx);
    expect(result).toContain('Profiling failed');
    expect(result).toContain('shell broken');
  });

  it('returns no-output message when stdout is empty', async () => {
    const session = makeSession('   ', 0);
    const ctx = makeContext(true, 10, session);
    const result = await profileCode({ ecosystem: 'go' }, ctx);
    expect(result).toContain('no output');
  });
});

describe('profileCode — Python cProfile parsing', () => {
  const pythonOutput = `
         5 function calls in 2.345 seconds

   Ordered by: cumulative time

   ncalls  tottime  percall  cumtime  percall filename:lineno(function)
        1    0.000    0.000    2.345    2.345 main.py:1(<module>)
     1000    1.234    0.001    1.234    0.001 mymodule.py:45(slow_fn)
      500    0.888    0.002    0.888    0.002 helper.py:12(helper)
`;

  it('parses python cProfile output and returns top-N hotspots', async () => {
    const session = makeSession(pythonOutput);
    const ctx = makeContext(true, 2, session);
    const result = await profileCode({ ecosystem: 'python', script: 'main.py' }, ctx);
    expect(result).toContain('Top 2 hotspots (python)');
    expect(result).toContain('<module>');
    expect(result).toContain('slow_fn');
    // helper is rank 3, should not appear in top-2 list
    expect(result).not.toContain('1. **helper**');
  });

  it('includes cumulative time in output', async () => {
    const session = makeSession(pythonOutput);
    const ctx = makeContext(true, 3, session);
    const result = await profileCode({ ecosystem: 'python', script: 'main.py' }, ctx);
    expect(result).toContain('cumulative');
  });
});

describe('profileCode — Go benchmark parsing', () => {
  const goOutput = `
goos: linux
goarch: amd64
BenchmarkFoo-8            1000000              1234 ns/op             512 B/op              8 allocs/op
BenchmarkBar-8             500000              2500 ns/op            1024 B/op             16 allocs/op
BenchmarkBaz-8            2000000               600 ns/op             256 B/op              4 allocs/op
PASS
`;

  it('parses go benchmark output and sorts by ns/op descending', async () => {
    const session = makeSession(goOutput);
    const ctx = makeContext(true, 3, session);
    const result = await profileCode({ ecosystem: 'go' }, ctx);
    expect(result).toContain('Top 3 hotspots (go)');
    // BenchmarkBar is slowest (2500 ns/op), should be rank 1
    // Use a non-greedy match to capture names with hyphens
    const rank1Match = result.match(/1\.\s+\*\*([^\*]+)\*\*/);
    expect(rank1Match?.[1]).toBe('BenchmarkBar-8');
  });

  it('limits output to top_n', async () => {
    const session = makeSession(goOutput);
    const ctx = makeContext(true, 1, session);
    const result = await profileCode({ ecosystem: 'go', top_n: 1 } as never, ctx);
    expect(result).toContain('Top 1 hotspots');
    // Check the hotspot list only (not the raw <details> section)
    const hotspotList = result.split('<details>')[0];
    expect(hotspotList).not.toContain('BenchmarkBaz');
  });
});

describe('profileCode — Rust benchmark parsing', () => {
  const rustOutput = `
running 3 tests
test bench_alpha ... bench:       5,678 ns/iter (+/- 234)
test bench_beta  ... bench:       1,234 ns/iter (+/- 56)
test bench_gamma ... bench:      12,000 ns/iter (+/- 800)
`;

  it('parses rust bench output and sorts by ns/iter descending', async () => {
    const session = makeSession(rustOutput);
    const ctx = makeContext(true, 3, session);
    const result = await profileCode({ ecosystem: 'rust' }, ctx);
    expect(result).toContain('Top 3 hotspots (rust)');
    // bench_gamma is slowest
    const rank1Match = result.match(/1\.\s+\*\*(\S+)\*\*/);
    expect(rank1Match?.[1]).toBe('bench_gamma');
  });
});

describe('profileCode — Node.js --prof parsing', () => {
  const nodeOutput = `
Statistical profiling result from node.js

 [Bottom up (heavy) profile]:
  Note: percentage in the first column is a resource usage of the funciton.

   ticks  total  nonlib   name
   1234   45.2%  50.1%  Function: slowFunc /src/app.js:42
    876   32.1%  35.6%  Function: helperFn /src/helpers.js:10
    432   15.8%  17.5%  Function: initSetup /src/init.js:5
`;

  it('parses node --prof-process output from the heavy profile section', async () => {
    const session = makeSession(nodeOutput);
    const ctx = makeContext(true, 2, session);
    const result = await profileCode({ ecosystem: 'node', script: 'src/index.js' }, ctx);
    expect(result).toContain('Top 2 hotspots (node)');
    expect(result).toContain('slowFunc');
    expect(result).toContain('helperFn');
    // initSetup is rank 3 — should not appear in the hotspot list (raw output in <details> is ok)
    const hotspotList = result.split('<details>')[0];
    expect(hotspotList).not.toContain('initSetup');
  });

  it('includes tick percentage in output', async () => {
    const session = makeSession(nodeOutput);
    const ctx = makeContext(true, 3, session);
    const result = await profileCode({ ecosystem: 'node', script: 'src/index.js' }, ctx);
    expect(result).toContain('45.2%');
  });
});

describe('profileCode — raw fallback', () => {
  it('returns raw output when no hotspots can be parsed', async () => {
    const session = makeSession('some unexpected profiler output that does not match any format');
    const ctx = makeContext(true, 5, session);
    const result = await profileCode({ ecosystem: 'go' }, ctx);
    expect(result).toContain('No structured hotspots parsed');
    expect(result).toContain('unexpected profiler output');
  });
});

describe('profileCode — command routing', () => {
  function captureCmd(session: ReturnType<typeof makeSession>): string {
    return (session.execute.mock.calls as unknown[][])[0][0] as string;
  }

  it('routes go to go test -bench', async () => {
    const session = makeSession('BenchmarkFoo-8    1000000    500 ns/op');
    const ctx = makeContext(true, 5, session);
    await profileCode({ ecosystem: 'go' }, ctx);
    const cmd = captureCmd(session);
    expect(cmd).toContain('go test');
    expect(cmd).toContain('-bench=.');
  });

  it('routes rust to cargo bench', async () => {
    const session = makeSession('test bench_a ... bench: 100 ns/iter (+/- 5)');
    const ctx = makeContext(true, 5, session);
    await profileCode({ ecosystem: 'rust' }, ctx);
    const cmd = captureCmd(session);
    expect(cmd).toContain('cargo bench');
  });

  it('routes python to cProfile with the provided script', async () => {
    const session = makeSession('ncalls  tottime\n     1    0.001    0.001    0.001    0.001 s.py:1(<module>)');
    const ctx = makeContext(true, 5, session);
    await profileCode({ ecosystem: 'python', script: 'main.py' }, ctx);
    const cmd = captureCmd(session);
    expect(cmd).toContain('cProfile');
    expect(cmd).toContain('main.py');
  });

  it('routes node to --prof with the provided script', async () => {
    const session = makeSession('');
    const ctx = makeContext(true, 5, session);
    await profileCode({ ecosystem: 'node', script: 'src/index.js' }, ctx);
    const cmd = captureCmd(session);
    expect(cmd).toContain('--prof');
    expect(cmd).toContain('src/index.js');
  });
});
