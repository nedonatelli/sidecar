import { workspace, Uri } from 'vscode';
import type { ToolDefinition } from '../../ollama/types.js';
import { getRootUri, type ToolExecutorContext, type RegisteredTool } from './shared.js';
import { getDefaultToolRuntime } from './runtime.js';
import { getConfig } from '../../config/settings.js';

type Ecosystem = 'node' | 'python' | 'go' | 'rust';

interface Hotspot {
  rank: number;
  name: string;
  time: string;
  detail?: string;
}

async function detectEcosystem(): Promise<Ecosystem | null> {
  const root = getRootUri();
  const checks: [string, Ecosystem][] = [
    ['package.json', 'node'],
    ['requirements.txt', 'python'],
    ['setup.py', 'python'],
    ['pyproject.toml', 'python'],
    ['Cargo.toml', 'rust'],
    ['go.mod', 'go'],
  ];
  for (const [file, eco] of checks) {
    try {
      await workspace.fs.stat(Uri.joinPath(root, file));
      return eco;
    } catch {
      /* not found */
    }
  }
  return null;
}

function buildCommand(eco: Ecosystem, script: string | undefined): string | null {
  switch (eco) {
    case 'python':
      if (!script) return null;
      return `python -m cProfile -s cumulative "${script}"`;
    case 'go':
      return 'go test -bench=. -run=^$ -benchmem ./...';
    case 'rust':
      return 'cargo bench 2>&1';
    case 'node':
      if (!script) return null;
      // Run with --prof, then process the generated isolate log, then clean up
      return `node --prof "${script}" 2>&1 && PROF_LOG=$(ls -t isolate-*.log 2>/dev/null | head -1) && [ -n "$PROF_LOG" ] && node --prof-process "$PROF_LOG" 2>&1; rm -f isolate-*.log 2>/dev/null; true`;
  }
}

function parseHotspots(eco: Ecosystem, output: string, topN: number): Hotspot[] {
  const hotspots: Hotspot[] = [];

  if (eco === 'python') {
    // ncalls  tottime  percall  cumtime  percall filename:lineno(function)
    const lines = output.split('\n');
    let inStats = false;
    let rank = 1;
    for (const line of lines) {
      if (line.trim().startsWith('ncalls')) {
        inStats = true;
        continue;
      }
      if (!inStats || rank > topN) continue;
      // Match: ncalls tottime percall cumtime percall path:line(func)
      const m = line.match(/^\s*(\S+)\s+(\S+)\s+\S+\s+(\S+)\s+\S+\s+(.+):(\d+)\((.+)\)\s*$/);
      if (m) {
        hotspots.push({
          rank: rank++,
          name: m[6].trim(),
          time: `${m[3]}s cumulative`,
          detail: `${m[4].trim()}:${m[5]}`,
        });
      }
    }
  } else if (eco === 'go') {
    // BenchmarkFoo-8    1000000    1234 ns/op    512 B/op    8 allocs/op
    const re = /^(Benchmark\S+)\s+\d+\s+([\d,]+)\s+ns\/op(?:\s+([\d,]+)\s+B\/op)?/gm;
    let m: RegExpExecArray | null;
    const results: { name: string; nsPerOp: number; detail: string }[] = [];
    while ((m = re.exec(output)) !== null) {
      results.push({
        name: m[1],
        nsPerOp: parseInt(m[2].replace(/,/g, ''), 10),
        detail: m[3] ? `${m[3]} B/op` : '',
      });
    }
    results.sort((a, b) => b.nsPerOp - a.nsPerOp);
    results.slice(0, topN).forEach((r, i) => {
      hotspots.push({
        rank: i + 1,
        name: r.name,
        time: `${r.nsPerOp.toLocaleString()} ns/op`,
        detail: r.detail || undefined,
      });
    });
  } else if (eco === 'rust') {
    // test bench_foo ... bench:       1,234 ns/iter (+/- 56)
    const re = /^test\s+(\S+)\s+\.\.\.\s+bench:\s+([\d,]+)\s+ns\/iter/gm;
    let m: RegExpExecArray | null;
    const results: { name: string; nsPerIter: number }[] = [];
    while ((m = re.exec(output)) !== null) {
      results.push({
        name: m[1],
        nsPerIter: parseInt(m[2].replace(/,/g, ''), 10),
      });
    }
    results.sort((a, b) => b.nsPerIter - a.nsPerIter);
    results.slice(0, topN).forEach((r, i) => {
      hotspots.push({ rank: i + 1, name: r.name, time: `${r.nsPerIter.toLocaleString()} ns/iter` });
    });
  } else if (eco === 'node') {
    // node --prof-process "Bottom up (heavy) profile" section
    //   ticks  total  nonlib   name
    //   1234   45.2%  50.1%  Function: funcName ...
    const lines = output.split('\n');
    let inHeavy = false;
    let rank = 1;
    for (const line of lines) {
      if (line.includes('Bottom up (heavy) profile')) {
        inHeavy = true;
        continue;
      }
      if (!inHeavy || rank > topN) continue;
      const m = line.match(/^\s+(\d+)\s+([\d.]+)%\s+[\d.]+%\s+(.+)$/);
      if (m) {
        hotspots.push({
          rank: rank++,
          name: m[3].trim(),
          time: `${m[2]}% of ticks (${m[1]} ticks)`,
        });
      }
    }
  }

  return hotspots;
}

export async function profileCode(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const cfg = context?.config ?? getConfig();
  if (!cfg.profilingEnabled) {
    return 'Code profiling is disabled. Enable it with `sidecar.profiling.enabled = true`.';
  }

  const topN = Math.max(1, (input.top_n as number | undefined) ?? cfg.profilingTopN);
  const scriptInput = input.script as string | undefined;

  let eco: Ecosystem;
  if (input.ecosystem && input.ecosystem !== 'auto') {
    eco = input.ecosystem as Ecosystem;
  } else {
    const detected = await detectEcosystem();
    if (!detected) {
      return 'Could not detect project ecosystem. Specify `ecosystem` (node/python/go/rust) explicitly.';
    }
    eco = detected;
  }

  const command = buildCommand(eco, scriptInput);
  if (!command) {
    const hint =
      eco === 'node' || eco === 'python' ? ` Specify \`script="path/to/entry.${eco === 'node' ? 'js' : 'py'}"\`.` : '';
    return `Ecosystem "${eco}" requires a \`script\` parameter.${hint}`;
  }

  const runtime = context?.toolRuntime ?? getDefaultToolRuntime();
  const session = runtime.getShellSession(context?.config);

  let rawOutput: string;
  try {
    const result = await session.execute(command, {
      timeout: 120_000,
      onOutput: context?.onOutput,
      signal: context?.signal,
    });
    rawOutput = result.stdout.trim();
    if (!rawOutput) {
      return `Profiler ran but produced no output (exit code: ${result.exitCode}).`;
    }
  } catch (err) {
    return `Profiling failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const hotspots = parseHotspots(eco, rawOutput, topN);

  if (hotspots.length === 0) {
    // Return raw output so the agent can still reason about it
    return `Profile run complete. No structured hotspots parsed.\n\n\`\`\`\n${rawOutput.slice(0, 4000)}\n\`\`\``;
  }

  const lines: string[] = [
    `**Top ${hotspots.length} hotspots (${eco})**`,
    '',
    ...hotspots.map((h) => {
      let line = `${h.rank}. **${h.name}** — ${h.time}`;
      if (h.detail) line += ` (${h.detail})`;
      return line;
    }),
    '',
    `<details><summary>Full profiler output</summary>\n\n\`\`\`\n${rawOutput.slice(0, 4000)}\n\`\`\`\n</details>`,
  ];

  return lines.join('\n');
}

export const profileCodeDef: ToolDefinition = {
  name: 'profile_code',
  nondeterministicOutput: true,
  description:
    'Profile the project code to identify CPU and memory hotspots. ' +
    'Auto-detects the ecosystem (Node.js/Python/Go/Rust) and runs the appropriate profiler. ' +
    'Returns the top-N slowest functions or benchmarks sorted by execution time. ' +
    'Use when the user asks about performance, slow code, or optimization opportunities. ' +
    'Example: `profile_code(ecosystem="python", script="src/main.py", top_n=10)`.',
  input_schema: {
    type: 'object',
    properties: {
      ecosystem: {
        type: 'string',
        enum: ['auto', 'node', 'python', 'go', 'rust'],
        description: 'Project ecosystem to profile. Defaults to "auto" (detected from workspace files).',
      },
      script: {
        type: 'string',
        description:
          'Entry file to profile. Required for node and python; omit for go and rust (uses test/bench commands).',
      },
      top_n: {
        type: 'number',
        description: 'Number of hotspots to return. Defaults to sidecar.profiling.topN (10).',
      },
    },
    required: [],
  },
};

export const profilingTools: RegisteredTool[] = [
  { definition: profileCodeDef, executor: profileCode, requiresApproval: true },
];
