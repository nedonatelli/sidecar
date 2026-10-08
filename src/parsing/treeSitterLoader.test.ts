import { describe, it, expect, vi, afterEach } from 'vitest';

// web-tree-sitter is one runtime per process, and two grammar loads in flight
// at once corrupt it. The extension bundle and the integration tests each hold
// their own copy of this loader; with per-copy state both initialised the
// runtime and loaded every grammar alongside the other, and in the extension
// host every grammar failed with "memory access out of bounds". Plain Node
// does not reproduce the corruption, so this checks what prevents it: across
// copies, one init, one load per grammar, and never two loads at once.

const runtime = vi.hoisted(() => ({ inits: 0, loads: [] as string[], inFlight: 0, maxInFlight: 0 }));

vi.mock('web-tree-sitter', () => {
  class Parser {
    static async init(): Promise<void> {
      runtime.inits++;
    }
    static Language = {
      async load(wasmPath: string): Promise<object> {
        runtime.loads.push(wasmPath);
        runtime.inFlight++;
        runtime.maxInFlight = Math.max(runtime.maxInFlight, runtime.inFlight);
        await new Promise((r) => setTimeout(r, 5));
        runtime.inFlight--;
        return { wasmPath };
      },
    };
    setLanguage(): void {}
  }
  return { default: Parser };
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('sidecar.webTreeSitter.state')];
});

describe('treeSitterLoader — two copies in one process', () => {
  it('initialises once, loads each grammar once, and never two at a time', async () => {
    vi.resetModules();
    const a = await import('./treeSitterLoader.js');
    vi.resetModules();
    const b = await import('./treeSitterLoader.js');
    expect(a).not.toBe(b); // really two copies of the module

    const langs = ['python', 'typescript', 'rust', 'go'];
    await Promise.all(langs.flatMap((l) => [a.createParser('/g', l), b.createParser('/g', l)]));

    expect(runtime.inits).toBe(1);
    expect(runtime.loads).toHaveLength(langs.length);
    expect(runtime.maxInFlight).toBe(1);
  });
});
