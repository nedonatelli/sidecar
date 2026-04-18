import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// spawn is the only child_process entry point hfSafetensorsImport uses; we
// fully replace it so each test can hand back a fake process with scripted
// stdout/stderr + exit. The original module keeps the other exports intact
// via spread so any unrelated import still resolves.
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from 'child_process';
import { importSafetensorsModel, type SafetensorsImportOptions } from './hfSafetensorsImport.js';
import type { HFModelRef, SafetensorsRepo } from './huggingface.js';

// Fake child-process object with the subset of ChildProcess surface
// hfSafetensorsImport touches: stdout / stderr as EventEmitters, a `kill`
// stub, and `error` / `close` events.
function fakeProc(opts: { stdoutLines?: string[]; stderrLines?: string[]; exitCode?: number; errorMessage?: string }): {
  proc: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: (sig: string) => void };
  finish: () => void;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill: vi.fn(),
  });

  const finish = () => {
    if (opts.errorMessage) {
      proc.emit('error', new Error(opts.errorMessage));
      return;
    }
    for (const line of opts.stdoutLines ?? []) {
      stdout.emit('data', Buffer.from(line + '\n'));
    }
    for (const line of opts.stderrLines ?? []) {
      stderr.emit('data', Buffer.from(line + '\n'));
    }
    stdout.emit('end');
    stderr.emit('end');
    proc.emit('close', opts.exitCode ?? 0);
  };

  return { proc, finish };
}

// Build a ReadableStream<Uint8Array> that emits a fixed byte payload so
// downloadFile's `for await (const chunk of response.body)` loop reads it.
function fakeBody(payload: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        controller.enqueue(payload);
        sent = true;
      } else {
        controller.close();
      }
    },
  });
}

function makeOpts(overrides: Partial<SafetensorsImportOptions> = {}): SafetensorsImportOptions {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-safetensors-'));
  const ref: HFModelRef = {
    org: 'test-org',
    repo: 'test-repo',
    ollamaName: 'hf.co/test-org/test-repo',
    isExplicit: true,
  };
  const repo: SafetensorsRepo = {
    weightFiles: [{ filename: 'model.safetensors', size: 8 }],
    metadataFiles: [{ filename: 'tokenizer.json', size: 4 }],
    totalBytes: 12,
    architecture: 'LlamaForCausalLM',
    gated: false,
  };
  return {
    ref,
    repo,
    quantization: 'q4_K_M',
    stagingDir,
    ollamaName: 'hf.co/test-org/test-repo',
    ollamaBinary: 'ollama',
    signal: new AbortController().signal,
    ...overrides,
  };
}

const mockFetch = vi.fn();

describe('importSafetensorsModel', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const d of tempDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tempDirs.length = 0;
  });

  it('yields download → convert → cleanup → done for a successful import', async () => {
    const opts = makeOpts();
    tempDirs.push(opts.stagingDir);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-length': '8' }),
      body: fakeBody(new Uint8Array(8)),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-length': '4' }),
      body: fakeBody(new Uint8Array(4)),
    });

    const { proc, finish } = fakeProc({ stdoutLines: ['transferring weights', 'creating manifest'], exitCode: 0 });
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(finish);
      return proc as unknown as ReturnType<typeof spawn>;
    });

    const phases: string[] = [];
    for await (const ev of importSafetensorsModel(opts)) {
      phases.push(ev.phase);
    }

    expect(phases).toContain('download');
    expect(phases).toContain('convert');
    expect(phases.at(-2)).toBe('cleanup');
    expect(phases.at(-1)).toBe('done');
    // Staging dir removed on successful cleanup.
    expect(fs.existsSync(opts.stagingDir)).toBe(false);

    const spawnArgs = vi.mocked(spawn).mock.calls[0];
    expect(spawnArgs[0]).toBe('ollama');
    expect(spawnArgs[1]).toEqual(['create', 'hf.co/test-org/test-repo', '-q', 'q4_K_M', '-f', 'Modelfile']);
  });

  it('skips already-downloaded files when the on-disk size matches', async () => {
    const opts = makeOpts();
    tempDirs.push(opts.stagingDir);

    // Pre-populate a correctly-sized file so the loop takes the skip branch.
    fs.writeFileSync(path.join(opts.stagingDir, 'model.safetensors'), Buffer.alloc(8));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-length': '4' }),
      body: fakeBody(new Uint8Array(4)),
    });
    const { proc, finish } = fakeProc({ exitCode: 0 });
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(finish);
      return proc as unknown as ReturnType<typeof spawn>;
    });

    const events = [];
    for await (const ev of importSafetensorsModel(opts)) {
      events.push(ev);
    }

    // Only one fetch should have fired — the second file.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // The first download event is the "skip" path — reports fully-complete bytes.
    const firstDownload = events.find((e) => e.phase === 'download' && e.file === 'model.safetensors');
    expect(firstDownload).toMatchObject({ completedBytes: 8, totalBytes: 8 });
  });

  it('throws a gated-repo error on HTTP 401', async () => {
    const opts = makeOpts();
    tempDirs.push(opts.stagingDir);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers(),
    });

    const run = async () => {
      for await (const _ of importSafetensorsModel(opts)) {
        void _;
      }
    };
    await expect(run()).rejects.toThrow(/gated|token/i);
  });

  it('throws a gated-repo error on HTTP 403', async () => {
    const opts = makeOpts();
    tempDirs.push(opts.stagingDir);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: new Headers(),
    });

    const run = async () => {
      for await (const _ of importSafetensorsModel(opts)) {
        void _;
      }
    };
    await expect(run()).rejects.toThrow(/HTTP 403/);
  });

  it('throws a generic HTTP error on 500', async () => {
    const opts = makeOpts();
    tempDirs.push(opts.stagingDir);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers(),
    });

    const run = async () => {
      for await (const _ of importSafetensorsModel(opts)) {
        void _;
      }
    };
    await expect(run()).rejects.toThrow(/HTTP 500/);
  });

  it('throws when the response body is missing', async () => {
    const opts = makeOpts();
    tempDirs.push(opts.stagingDir);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-length': '8' }),
      body: null,
    });

    const run = async () => {
      for await (const _ of importSafetensorsModel(opts)) {
        void _;
      }
    };
    await expect(run()).rejects.toThrow(/Empty response body/);
  });

  it('detects a truncated download and cleans up the partial file', async () => {
    const opts = makeOpts();
    tempDirs.push(opts.stagingDir);

    // Server advertises 8 bytes but delivers only 4 — simulating an LFS CDN
    // that closes the TCP connection early.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-length': '8' }),
      body: fakeBody(new Uint8Array(4)),
    });

    const run = async () => {
      for await (const _ of importSafetensorsModel(opts)) {
        void _;
      }
    };
    await expect(run()).rejects.toThrow(/Truncated download/);
    // Partial file must be removed so a retry starts fresh.
    expect(fs.existsSync(path.join(opts.stagingDir, 'model.safetensors'))).toBe(false);
  });

  it('includes the Bearer token header when hfToken is set', async () => {
    const opts = makeOpts({ hfToken: 'hf_test_token' });
    tempDirs.push(opts.stagingDir);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-length': '8' }),
      body: fakeBody(new Uint8Array(8)),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-length': '4' }),
      body: fakeBody(new Uint8Array(4)),
    });
    const { proc, finish } = fakeProc({ exitCode: 0 });
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(finish);
      return proc as unknown as ReturnType<typeof spawn>;
    });

    for await (const _ of importSafetensorsModel(opts)) {
      void _;
    }

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer hf_test_token');
  });

  it('throws and preserves the staging dir when `ollama create` exits non-zero', async () => {
    const opts = makeOpts();
    tempDirs.push(opts.stagingDir);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-length': '8' }),
      body: fakeBody(new Uint8Array(8)),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-length': '4' }),
      body: fakeBody(new Uint8Array(4)),
    });

    const { proc, finish } = fakeProc({ stderrLines: ['cannot parse invalid wire-format data'], exitCode: 1 });
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(finish);
      return proc as unknown as ReturnType<typeof spawn>;
    });

    const run = async () => {
      for await (const _ of importSafetensorsModel(opts)) {
        void _;
      }
    };
    await expect(run()).rejects.toThrow(/ollama create.*exited with code 1/);
    // Non-zero exit must NOT trigger cleanup — user needs the staging dir
    // to debug.
    expect(fs.existsSync(opts.stagingDir)).toBe(true);
  });

  it('wraps a spawn() throw in an "ensure Ollama is installed" error', async () => {
    const opts = makeOpts();
    tempDirs.push(opts.stagingDir);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-length': '8' }),
      body: fakeBody(new Uint8Array(8)),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-length': '4' }),
      body: fakeBody(new Uint8Array(4)),
    });

    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const run = async () => {
      for await (const _ of importSafetensorsModel(opts)) {
        void _;
      }
    };
    await expect(run()).rejects.toThrow(/Could not launch.*ENOENT.*Ollama is installed/s);
  });

  it('wraps a post-spawn `error` event in an "ensure Ollama is installed" error', async () => {
    const opts = makeOpts();
    tempDirs.push(opts.stagingDir);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-length': '8' }),
      body: fakeBody(new Uint8Array(8)),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-length': '4' }),
      body: fakeBody(new Uint8Array(4)),
    });

    const { proc, finish } = fakeProc({ errorMessage: 'spawn ollama ENOENT' });
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(finish);
      return proc as unknown as ReturnType<typeof spawn>;
    });

    const run = async () => {
      for await (const _ of importSafetensorsModel(opts)) {
        void _;
      }
    };
    await expect(run()).rejects.toThrow(/Failed to spawn.*ollama.*ENOENT/);
  });

  it('throws AbortError immediately when the caller aborts before the first download', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const opts = makeOpts({ signal: ctrl.signal });
    tempDirs.push(opts.stagingDir);

    const run = async () => {
      for await (const _ of importSafetensorsModel(opts)) {
        void _;
      }
    };
    await expect(run()).rejects.toThrow(/Aborted/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
