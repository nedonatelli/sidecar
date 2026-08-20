import * as fs from 'fs';
import * as path from 'path';
import type { EffectiveSurface } from './agentHarness.js';

// ---------------------------------------------------------------------------
// Live per-trial trajectory logs.
//
// The SWE harness has written these since it was built — appended per event
// with elapsed-ms stamps, "so a run is watchable mid-flight with tail -f". The
// agent harness dumped once at the END of a run, which meant that for every
// eval this evening the only available answers to "what actually happened?"
// were a pass/fail bit and my memory.
//
// That produced a specific class of error, repeatedly: describing an arm by the
// configuration it was MEANT to have. An arm was called "no RAG" while
// project_knowledge_search sat in its catalog; a 13-turn run could not be
// explained because no gate firing was recorded; an arm scored 11/20 against
// another's 16/20 with nothing to say why.
//
// So: what was on goes in the header, and every decision goes in the body.
// ---------------------------------------------------------------------------

/** Gate / guard / reprompt markers the loop emits through onText. */
const SCAFFOLD_MARKERS = ['⚠️', '🔬', '💡', '🛡️', 'Completion gate', 'Agent stopped'];

export interface TrajectoryLogger {
  /** Wrap a callbacks object so every event is recorded as it happens. */
  wrap<T extends object>(callbacks: T): T;
  close(termination: string): void;
  /** Path of the human-readable log, for error messages. */
  readonly logPath: string;
}

export interface LoggerOptions {
  dir: string;
  caseId: string;
  arm: string;
  seed: number | null;
  trial: number;
  surface: EffectiveSurface;
  configOverrides: Record<string, unknown>;
}

export function createTrajectoryLogger(o: LoggerOptions): TrajectoryLogger {
  const stem = `${o.caseId}.${o.arm}.seed${o.seed ?? 'none'}.trial${o.trial}`;
  const logPath = path.join(o.dir, `${stem}.log`);
  const jsonPath = path.join(o.dir, `${stem}.jsonl`);
  fs.mkdirSync(o.dir, { recursive: true });
  const started = Date.now();

  // appendFileSync, never a buffered stream: a run killed mid-flight (lid close,
  // timeout, Ctrl-C) must leave everything up to that moment on disk. A buffered
  // writer loses exactly the tail you need.
  const write = (line: string): void => {
    try {
      fs.appendFileSync(logPath, `[+${Date.now() - started}ms] ${line}\n`);
    } catch {
      /* telemetry must never fail a run */
    }
  };
  const event = (type: string, data: Record<string, unknown>): void => {
    try {
      fs.appendFileSync(jsonPath, JSON.stringify({ t: Date.now() - started, type, ...data }) + '\n');
    } catch {
      /* telemetry must never fail a run */
    }
  };

  // Header first: what was ON is the first thing in the file, so the question
  // "which arm was this?" is answered by reading, not remembering.
  const s = o.surface;
  const header = [
    `=== ${o.caseId} | arm=${o.arm} | seed=${o.seed ?? 'UNSEEDED'} | trial=${o.trial} ===`,
    `system_prompt: ${s.systemPromptChars} chars (${s.systemPromptHash})`,
    `tools (${s.toolNames.length}): ${s.toolNames.join(', ')}`,
    `tool_catalog: ${s.toolCatalogHash}`,
    `rag_orientation: ${s.ragOrientationChars} chars${s.ragOrientationChars === 0 ? ' (did not fire)' : ''}`,
    `temperature: ${s.temperature} | num_ctx: ${s.numCtx ?? 'default'}`,
    `config_overrides: ${JSON.stringify(o.configOverrides)}`,
    '='.repeat(72),
  ].join('\n');
  try {
    fs.writeFileSync(logPath, header + '\n');
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        t: 0,
        type: 'header',
        surface: s,
        arm: o.arm,
        seed: o.seed,
        trial: o.trial,
        configOverrides: o.configOverrides,
      }) + '\n',
    );
  } catch {
    /* telemetry must never fail a run */
  }

  const snippet = (x: string, n = 400): string => x.replace(/\s+/g, ' ').trim().slice(0, n);

  // onThinking and onText stream TOKEN BY TOKEN. Logging each callback produced
  // 2,383 thinking lines of 3-7 chars for a single run — the tool calls were
  // buried and the reasoning unreadable. Buffer, and flush a whole message as
  // one entry before the next tool call or at termination, the same way the SWE
  // harness has always handled its text stream.
  let thinkBuf = '';
  let textBuf = '';
  const flushThinking = (): void => {
    if (!thinkBuf.trim()) {
      thinkBuf = '';
      return;
    }
    write(`THINKING (${thinkBuf.length} chars):\n${thinkBuf.trim()}`);
    event('thinking', { chars: thinkBuf.length, thinking: thinkBuf.trim() });
    thinkBuf = '';
  };
  const flushText = (): void => {
    const t = textBuf;
    textBuf = '';
    if (!t.trim()) return;
    const marker = SCAFFOLD_MARKERS.find((m) => t.includes(m));
    if (marker) {
      write(`SCAFFOLD [${marker}] ${snippet(t, 600)}`);
      event('scaffold', { marker, text: snippet(t, 2000) });
    }
  };
  const flushAll = (): void => {
    flushThinking();
    flushText();
  };

  return {
    logPath,
    close(termination: string) {
      flushAll();
      write(`TERMINATION: ${termination}`);
      event('termination', { termination });
    },
    wrap<T extends object>(cb: T): T {
      const orig = cb as Record<string, unknown>;
      const chain =
        <A extends unknown[]>(name: string, fn: (...a: A) => void) =>
        (...a: A): void => {
          fn(...a);
          const prev = orig[name];
          if (typeof prev === 'function') (prev as (...x: A) => void)(...a);
        };
      return {
        ...cb,
        // Thinking is logged IN FULL, not snipped. It is the only artifact that
        // explains WHY a decision was made — reading one trace is what revealed
        // gemma4 talking itself out of a replace_all that destroyed another
        // model's file. A truncated trace would have hidden it.
        onThinking: chain('onThinking', (thinking: string) => {
          thinkBuf += thinking;
        }),
        onToolCall: chain('onToolCall', (name: string, input: Record<string, unknown>, id: string) => {
          flushAll();
          write(`TOOL ${name} ${snippet(JSON.stringify(input), 500)}`);
          event('tool_call', { name, input, id });
        }),
        onToolResult: chain('onToolResult', (name: string, result: string, isError: boolean, id: string) => {
          write(`  -> ${name} ${isError ? 'ERROR' : 'ok'} (${result.length}b): ${snippet(result)}`);
          event('tool_result', { name, isError, chars: result.length, result: snippet(result, 2000), id });
        }),
        onIterationStart: chain(
          'onIterationStart',
          (info: { iteration: number; estimatedTokens: number; messageCount: number; atCapacity: boolean }) => {
            flushAll();
            write(
              `ITER ${info.iteration} ctx=${info.estimatedTokens}tok msgs=${info.messageCount}` +
                (info.atCapacity ? ' AT-CAPACITY' : ''),
            );
            event('iteration', { ...info });
          },
        ),
        // Gates, guards and reprompts reach the user through onText. Tag them so
        // "why did this take 13 turns?" is greppable instead of invisible.
        onText: chain('onText', (text: string) => {
          textBuf += text;
        }),
      } as unknown as T;
    },
  };
}
