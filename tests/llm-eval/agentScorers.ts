import type { AgentEvalCase, AgentCaseResult, AgentExpectations, TrajectoryEvent } from './agentTypes.js';
import type { WorkspaceFixture } from './workspaceSandbox.js';

// ---------------------------------------------------------------------------
// Deterministic scorers for the agent-loop eval layer.
//
// Each predicate in AgentExpectations maps to a helper that returns a
// failure string when the predicate doesn't hold, or null when it
// does. `scoreAgentCase` aggregates every failure into the result so
// the report says *exactly* which expectation regressed — not just
// "case failed".
//
// Design choices:
//
//   - Trajectory predicates match on tool *name* and a partial *input*
//     object, not on exact arg equality. Exact equality is too brittle
//     for LLM output: the model might call `read_file(path="src/a.ts")`
//     in one run and `read_file(path="./src/a.ts")` in another. Partial
//     match lets cases assert "read_file was called and its path
//     contained 'a.ts'" without pinning the exact form.
//
//   - File-state predicates match substrings, not exact file equality
//     by default. `files.equal` is available for cases that truly need
//     byte-level stability (e.g. a JSON config with a known output),
//     but most cases should use `files.contain` / `files.notContain`.
//
//   - Absence predicates (`toolsNotCalled`, `notContain`, `notExist`)
//     exist so cases can forbid regressions — e.g. "the agent must
//     NOT write to README.md" or "the agent must NOT call
//     delete_file". Positive assertions alone leave room for the
//     agent to do correct AND wrong things.
// ---------------------------------------------------------------------------

interface AgentRun {
  trajectory: TrajectoryEvent[];
  finalText: string;
  workspaceAfter: WorkspaceFixture;
  durationMs: number;
  iterationsUsed: number;
}

function collectFailures(expect: AgentExpectations, run: AgentRun, out: string[]): void {
  // --- trajectory: tools called ---
  if (expect.toolsCalled) {
    for (const name of expect.toolsCalled) {
      if (!hasToolCall(run.trajectory, name)) {
        out.push(`toolsCalled: expected "${name}" to be called at least once, but it was not`);
      }
    }
  }

  // --- trajectory: at least one of these tools called (OR semantics) ---
  if (expect.toolsCalledAny) {
    const anyMatched = expect.toolsCalledAny.some((name) => hasToolCall(run.trajectory, name));
    if (!anyMatched) {
      out.push(
        `toolsCalledAny: expected at least one of [${expect.toolsCalledAny.join(', ')}] to be called, but none were`,
      );
    }
  }

  // --- trajectory: tools NOT called ---
  if (expect.toolsNotCalled) {
    for (const name of expect.toolsNotCalled) {
      if (hasToolCall(run.trajectory, name)) {
        out.push(`toolsNotCalled: expected "${name}" to NOT be called, but it was`);
      }
    }
  }

  // --- trajectory: exact tool-call + partial-input matches ---
  if (expect.toolCallMatches) {
    for (const match of expect.toolCallMatches) {
      const found = findToolCallWithPartialInput(run.trajectory, match.name, match.inputPartial);
      if (!found) {
        out.push(
          `toolCallMatches: no call to "${match.name}" matched partial input ${JSON.stringify(match.inputPartial)}`,
        );
      }
    }
  }

  // --- files: existence ---
  if (expect.files?.exist) {
    for (const p of expect.files.exist) {
      if (!(p in run.workspaceAfter)) out.push(`files.exist: "${p}" does not exist in the post-run workspace`);
    }
  }
  if (expect.files?.notExist) {
    for (const p of expect.files.notExist) {
      if (p in run.workspaceAfter) out.push(`files.notExist: "${p}" still exists in the post-run workspace`);
    }
  }

  // --- files: content ---
  if (expect.files?.contain) {
    for (const spec of expect.files.contain) {
      const content = run.workspaceAfter[spec.path];
      if (content === undefined) {
        out.push(`files.contain: "${spec.path}" does not exist (can't check substrings)`);
        continue;
      }
      for (const needle of spec.substrings) {
        if (!content.includes(needle)) {
          out.push(`files.contain: "${spec.path}" is missing substring ${JSON.stringify(needle)}`);
        }
      }
    }
  }
  if (expect.files?.notContain) {
    for (const spec of expect.files.notContain) {
      const content = run.workspaceAfter[spec.path];
      if (content === undefined) continue; // absent = vacuously "doesn't contain"
      for (const needle of spec.substrings) {
        if (content.includes(needle)) {
          out.push(`files.notContain: "${spec.path}" still contains ${JSON.stringify(needle)}`);
        }
      }
    }
  }
  if (expect.files?.matchesRegex) {
    for (const spec of expect.files.matchesRegex) {
      const content = run.workspaceAfter[spec.path];
      if (content === undefined) {
        out.push(`files.matchesRegex: "${spec.path}" does not exist`);
        continue;
      }
      for (const pat of spec.patterns) {
        if (!pat.test(content)) {
          out.push(`files.matchesRegex: "${spec.path}" does not match ${pat}`);
        }
      }
    }
  }
  if (expect.files?.equal) {
    for (const spec of expect.files.equal) {
      const content = run.workspaceAfter[spec.path];
      if (content === undefined) {
        out.push(`files.equal: "${spec.path}" does not exist`);
      } else if (content !== spec.content) {
        out.push(`files.equal: "${spec.path}" content differs from expected`);
      }
    }
  }

  // --- final assistant text ---
  if (expect.finalTextContains) {
    for (const needle of expect.finalTextContains) {
      if (!run.finalText.toLowerCase().includes(needle.toLowerCase())) {
        out.push(`finalTextContains: missing "${needle}"`);
      }
    }
  }
  if (expect.finalTextNotContains) {
    for (const needle of expect.finalTextNotContains) {
      if (run.finalText.toLowerCase().includes(needle.toLowerCase())) {
        out.push(`finalTextNotContains: present "${needle}"`);
      }
    }
  }
  if (expect.finalTextMatchesRegex) {
    for (const pattern of expect.finalTextMatchesRegex) {
      if (!pattern.test(run.finalText)) {
        out.push(`finalTextMatchesRegex: final text did not match ${pattern}`);
      }
    }
  }
  if (expect.finalTextNotMatchesRegex) {
    for (const pattern of expect.finalTextNotMatchesRegex) {
      if (pattern.test(run.finalText)) {
        out.push(`finalTextNotMatchesRegex: final text matched ${pattern}`);
      }
    }
  }

  // --- trajectory ordering ---
  if (expect.trajectoryOrder) {
    for (const { before, after } of expect.trajectoryOrder) {
      const beforeIdx = firstToolCallIndex(run.trajectory, before);
      const afterIdx = firstToolCallIndex(run.trajectory, after);
      if (beforeIdx === -1) {
        out.push(`trajectoryOrder: "${before}" was never called (must appear before "${after}")`);
      } else if (afterIdx === -1) {
        out.push(`trajectoryOrder: "${after}" was never called (must appear after "${before}")`);
      } else if (beforeIdx >= afterIdx) {
        out.push(
          `trajectoryOrder: expected "${before}" (event ${beforeIdx}) before "${after}" (event ${afterIdx}), but order was reversed`,
        );
      }
    }
  }

  // --- trajectory error observation ---
  if (expect.trajectoryHasToolError === true) {
    const hasError = run.trajectory.some((e) => e.type === 'tool_result' && e.isError);
    if (!hasError) {
      out.push(`trajectoryHasToolError: expected at least one tool_result with isError=true, but none observed`);
    }
  }

  // --- thinking observation ---
  if (expect.trajectoryHasThinking === true) {
    const hasThinking = run.trajectory.some((e) => e.type === 'thinking');
    if (!hasThinking) {
      out.push(`trajectoryHasThinking: expected at least one thinking event, but none observed (model may not support extended thinking)`);
    }
  }
}

export function scoreAgentCase(evalCase: AgentEvalCase, run: AgentRun): AgentCaseResult {
  const failures: string[] = [];
  const softFailures: string[] = [];
  const { expect } = evalCase;

  collectFailures(expect, run, failures);

  if (evalCase.softExpect) {
    collectFailures(evalCase.softExpect, run, softFailures);
  }

  return {
    id: evalCase.id,
    description: evalCase.description,
    passed: failures.length === 0,
    failures,
    softFailures,
    trajectory: run.trajectory,
    finalText: run.finalText,
    workspaceAfter: run.workspaceAfter,
    durationMs: run.durationMs,
    iterationsUsed: run.iterationsUsed,
  };
}

// --- trajectory helpers ---

function hasToolCall(trajectory: TrajectoryEvent[], name: string): boolean {
  if (trajectory.some((e) => e.type === 'tool_call' && e.name === name)) return true;
  // run_command(command="grep ...") counts as calling grep, and similarly for rg/sed/git/etc.
  // Models that reach for the CLI equivalent satisfy the same intent as the dedicated tool.
  return trajectory.some(
    (e) =>
      e.type === 'tool_call' &&
      e.name === 'run_command' &&
      typeof (e.input as Record<string, unknown>)?.command === 'string' &&
      ((e.input as Record<string, unknown>).command as string).includes(name),
  );
}

function firstToolCallIndex(trajectory: TrajectoryEvent[], name: string): number {
  const idx = trajectory.findIndex((e) => e.type === 'tool_call' && e.name === name);
  if (idx !== -1) return idx;
  return trajectory.findIndex(
    (e) =>
      e.type === 'tool_call' &&
      e.name === 'run_command' &&
      typeof (e.input as Record<string, unknown>)?.command === 'string' &&
      ((e.input as Record<string, unknown>).command as string).includes(name),
  );
}

function findToolCallWithPartialInput(
  trajectory: TrajectoryEvent[],
  name: string,
  inputPartial: Record<string, unknown>,
): TrajectoryEvent | undefined {
  return trajectory.find((e) => {
    if (e.type !== 'tool_call') return false;
    if (e.name !== name) return false;
    for (const [k, v] of Object.entries(inputPartial)) {
      const actual = e.input[k];
      if (typeof v === 'string' && typeof actual === 'string') {
        // Substring match for strings — tolerates "./src/a.ts" vs "src/a.ts"
        if (!actual.includes(v)) return false;
      } else if (actual !== v) {
        return false;
      }
    }
    return true;
  });
}

// --- report rendering ---

/**
 * Render a markdown summary of a batch of agent-case results. Mirrors
 * the shape of the prompt layer's renderReport so the two can be
 * concatenated in a combined run.
 */
export function renderAgentReport(results: AgentCaseResult[]): string {
  const passed = results.filter((r) => r.passed).length;
  const unavailable = results.filter((r) => r.apiUnavailable && !r.passed).length;
  const scored = results.length - unavailable;
  const lines: string[] = [];
  lines.push(`# LLM Eval Report — Agent Loop`);
  lines.push('');
  if (unavailable > 0) {
    lines.push(
      `**Score: ${passed} / ${scored} scored** ` +
        `(${unavailable} ⚠️ api-unavailable — API hung/rate-limited, not counted as failures)`,
    );
  } else {
    lines.push(`**Score: ${passed} / ${results.length} passed**`);
  }
  lines.push('');
  for (const r of results) {
    const mark = r.passed ? '✅' : r.apiUnavailable ? '⚠️' : '❌';
    lines.push(`## ${mark} ${r.id} — ${r.description}`);
    lines.push(`*Duration: ${r.durationMs}ms · Iterations: ${r.iterationsUsed} · Trajectory events: ${r.trajectory.length}*`);
    if (r.failures.length > 0) {
      lines.push('');
      lines.push('Failures:');
      for (const f of r.failures) lines.push(`- ${f}`);
    }
    if (r.softFailures.length > 0) {
      lines.push('');
      lines.push('Soft failures (informational — do not affect pass/fail):');
      for (const f of r.softFailures) lines.push(`- ${f}`);
    }
    lines.push('');
    lines.push('<details><summary>Trajectory</summary>');
    lines.push('');
    lines.push('```');
    for (const ev of r.trajectory) {
      if (ev.type === 'tool_call') {
        lines.push(`→ ${ev.name}(${JSON.stringify(ev.input).slice(0, 200)})`);
      } else if (ev.type === 'tool_result') {
        const preview = ev.result.length > 120 ? ev.result.slice(0, 120) + '...' : ev.result;
        lines.push(`← ${ev.name}${ev.isError ? ' [ERROR]' : ''}: ${preview.replace(/\n/g, ' ')}`);
      } else if (ev.type === 'text') {
        const preview = ev.text.length > 120 ? ev.text.slice(0, 120) + '...' : ev.text;
        if (preview.trim()) lines.push(`TEXT: ${preview.replace(/\n/g, ' ')}`);
      } else if (ev.type === 'thinking') {
        lines.push(`(thinking)`);
      } else if (ev.type === 'done') {
        lines.push(`✓ done`);
      }
    }
    lines.push('```');
    lines.push('</details>');
    lines.push('');
  }
  return lines.join('\n');
}
