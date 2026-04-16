/**
 * Download a Safetensors HuggingFace model and convert it to a GGUF via
 * `ollama create`. This is the fallback path for repos that don't publish
 * GGUF files directly — most base/instruct releases on HF ship in
 * Safetensors format, and the conversion is what llama.cpp has always done
 * under the hood when you run `ollama pull` against an HF GGUF mirror.
 *
 * The flow has three phases, each surfaced as a distinct progress event:
 *
 *   1. `download` — pulls every weight shard and metadata file from
 *      `https://huggingface.co/{org}/{repo}/resolve/main/{file}` into a
 *      staging directory under globalStorage. Byte-level progress.
 *   2. `convert`  — runs `ollama create <name> -q <quant> -f Modelfile`
 *      against the staging dir. No byte-level progress (the CLI doesn't
 *      expose it), so we stream stdout/stderr lines as progress text.
 *   3. `cleanup`  — deletes the staging dir once the blob is in Ollama's
 *      store. The raw Safetensors files are redundant at that point and
 *      can be tens of GB, so we always clean them up on success.
 *
 * Cancellation: the caller passes an AbortSignal. On abort we close the
 * current download stream and send SIGTERM to any running `ollama create`.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { HFModelRef, SafetensorsRepo } from './huggingface.js';

/** Quantization levels exposed to the user in the install UI. */
export type Quantization = 'f16' | 'q8_0' | 'q6_K' | 'q5_K_M' | 'q4_K_M';

export interface SafetensorsImportOptions {
  ref: HFModelRef;
  repo: SafetensorsRepo;
  /** Quantization passed to `ollama create -q`. */
  quantization: Quantization;
  /** HuggingFace access token for gated repos. */
  hfToken?: string;
  /** Absolute path to the staging directory. Must already exist. */
  stagingDir: string;
  /** Name the model will be installed as in Ollama (e.g. `hf.co/org/repo`). */
  ollamaName: string;
  /** Optional override of the `ollama` CLI path — used by tests. */
  ollamaBinary?: string;
  signal: AbortSignal;
}

export type ImportProgress =
  | {
      phase: 'download';
      file: string;
      completedBytes: number;
      totalBytes: number;
      overallCompleted: number;
      overallTotal: number;
    }
  | { phase: 'convert'; line: string }
  | { phase: 'cleanup' }
  | { phase: 'done' };

/**
 * Run the full import flow. Yields progress events; throws on unrecoverable
 * errors (download failure, non-zero convert exit, missing `ollama` binary).
 *
 * On AbortError the caller should surface a cancellation message — we
 * deliberately do not clean up the staging dir on abort, so a re-run can
 * pick up where the user left off (v2 once we add HTTP Range resumes).
 */
export async function* importSafetensorsModel(opts: SafetensorsImportOptions): AsyncGenerator<ImportProgress> {
  const { ref, repo, stagingDir, signal } = opts;
  const allFiles = [...repo.weightFiles, ...repo.metadataFiles];
  const overallTotal = repo.totalBytes;
  let overallCompleted = 0;

  // Phase 1: download every file. We sequence downloads rather than
  // parallelizing them because HF rate-limits aggressive clients and the
  // bottleneck is almost always disk + network, not the number of
  // concurrent requests. Sequential also keeps the progress UI coherent.
  for (const file of allFiles) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const destPath = path.join(stagingDir, file.filename);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    // Skip already-downloaded files with the correct size. Allows retrying
    // an interrupted run without re-downloading weights that completed.
    try {
      const stat = fs.statSync(destPath);
      if (file.size > 0 && stat.size === file.size) {
        overallCompleted += file.size;
        yield {
          phase: 'download',
          file: file.filename,
          completedBytes: file.size,
          totalBytes: file.size,
          overallCompleted,
          overallTotal,
        };
        continue;
      }
    } catch {
      // File doesn't exist yet — fall through to download.
    }

    yield* downloadFile({
      ref,
      file: file.filename,
      expectedSize: file.size,
      destPath,
      hfToken: opts.hfToken,
      signal,
      onBytes: (chunkBytes) => {
        overallCompleted += chunkBytes;
      },
      getOverall: () => ({ overallCompleted, overallTotal }),
    });
  }

  // Phase 2: write a Modelfile and invoke `ollama create`.
  const modelfilePath = path.join(stagingDir, 'Modelfile');
  fs.writeFileSync(modelfilePath, `FROM ./\n`, 'utf-8');

  yield* runOllamaCreate({
    ollamaBinary: opts.ollamaBinary ?? 'ollama',
    ollamaName: opts.ollamaName,
    quantization: opts.quantization,
    cwd: stagingDir,
    signal,
  });

  // Phase 3: remove the staging dir. Ollama has the GGUF in its blob store
  // now, so the raw Safetensors are dead weight — often 2–3x the final size.
  yield { phase: 'cleanup' };
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    // Best-effort; user can clean up manually if we fail.
  }

  yield { phase: 'done' };
}

interface DownloadArgs {
  ref: HFModelRef;
  file: string;
  expectedSize: number;
  destPath: string;
  hfToken: string | undefined;
  signal: AbortSignal;
  onBytes: (chunkBytes: number) => void;
  getOverall: () => { overallCompleted: number; overallTotal: number };
}

/** Stream a single file from HuggingFace to disk, yielding progress. */
async function* downloadFile(args: DownloadArgs): AsyncGenerator<ImportProgress> {
  const { ref, file, expectedSize, destPath, hfToken, signal, onBytes, getOverall } = args;
  const url = `https://huggingface.co/${ref.org}/${ref.repo}/resolve/main/${file}`;
  const headers: Record<string, string> = {};
  if (hfToken) headers.Authorization = `Bearer ${hfToken}`;

  const response = await fetch(url, { headers, signal });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `HuggingFace denied download of ${file} (HTTP ${response.status}). ` +
          `This repo is gated — set a token via "SideCar: Set / Clear HuggingFace Token".`,
      );
    }
    throw new Error(`Failed to download ${file}: HTTP ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error(`Empty response body for ${file}`);
  }

  const contentLength = Number(response.headers.get('content-length') ?? expectedSize ?? 0);
  let fileCompleted = 0;

  // Throttle progress events — the chunk size is small enough that naively
  // yielding per chunk floods the webview with ~1000 msg/sec on a fast link.
  let lastYieldBytes = 0;
  const YIELD_EVERY_BYTES = 4 * 1024 * 1024;

  // Node's fetch returns a web ReadableStream; adapt it for pipeline() and
  // observe chunks inline via an async iterator. A plain for-await over the
  // web stream works without needing to shim into a Node Readable.
  const writer = fs.createWriteStream(destPath);
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (signal.aborted) {
        writer.destroy();
        throw new DOMException('Aborted', 'AbortError');
      }
      writer.write(chunk);
      fileCompleted += chunk.byteLength;
      onBytes(chunk.byteLength);
      if (fileCompleted - lastYieldBytes >= YIELD_EVERY_BYTES || fileCompleted === contentLength) {
        lastYieldBytes = fileCompleted;
        const { overallCompleted, overallTotal } = getOverall();
        yield {
          phase: 'download',
          file,
          completedBytes: fileCompleted,
          totalBytes: contentLength,
          overallCompleted,
          overallTotal,
        };
      }
    }
    writer.end();
    await new Promise<void>((resolve, reject) => {
      writer.on('finish', () => resolve());
      writer.on('error', reject);
    });
  } catch (err) {
    writer.destroy();
    // Clean up the partial file so a retry starts fresh (until we add
    // HTTP Range resumes in v2).
    try {
      fs.unlinkSync(destPath);
    } catch {
      // ignore
    }
    throw err;
  }

  // Size verification: compare on-disk bytes against the `content-length`
  // header we got at the start of the response. HF's LFS CDN occasionally
  // closes the TCP connection early on flaky connections and the fetch
  // body iterator exits cleanly — no error thrown, but the file is silent
  // junk. If we hand a truncated tokenizer to `ollama create`, the Go
  // protobuf parser fails with "cannot parse invalid wire-format data",
  // which is almost impossible to debug without a size check.
  //
  // We verify against the actual on-disk stat (not just `fileCompleted`)
  // in case a filesystem error swallowed a write mid-stream without
  // surfacing it on the writer.
  if (contentLength > 0) {
    const actualSize = fs.statSync(destPath).size;
    if (actualSize !== contentLength) {
      try {
        fs.unlinkSync(destPath);
      } catch {
        // ignore
      }
      throw new Error(
        `Truncated download for ${file}: expected ${contentLength} bytes, got ${actualSize}. ` +
          `HuggingFace's LFS CDN sometimes closes the connection early on flaky networks — retrying the install usually fixes this.`,
      );
    }
  }

  // Final event for this file so the UI can show 100%.
  const { overallCompleted, overallTotal } = getOverall();
  yield {
    phase: 'download',
    file,
    completedBytes: fileCompleted,
    totalBytes: contentLength || fileCompleted,
    overallCompleted,
    overallTotal,
  };
}

interface OllamaCreateArgs {
  ollamaBinary: string;
  ollamaName: string;
  quantization: Quantization;
  cwd: string;
  signal: AbortSignal;
}

/**
 * Spawn `ollama create -q <quant> -f Modelfile` and stream its output as
 * `convert` progress events. Rejects on non-zero exit, missing binary,
 * or abort.
 *
 * We use `ollama create -q` (lowercase) because Ollama's CLI accepts the
 * quant name in lowercase without the leading underscore. Valid values
 * are `f16`, `q8_0`, `q6_K`, `q5_K_M`, `q4_K_M`, etc.
 */
async function* runOllamaCreate(args: OllamaCreateArgs): AsyncGenerator<ImportProgress> {
  const { ollamaBinary, ollamaName, quantization, cwd, signal } = args;

  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  // Buffer stdout/stderr lines so we can yield them from the async
  // generator. The child process pushes data asynchronously, so we
  // use a queue + promise-based wakeup pattern.
  let proc: ChildProcess;
  try {
    proc = spawn(ollamaBinary, ['create', ollamaName, '-q', quantization, '-f', 'Modelfile'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(
      `Could not launch \`${ollamaBinary} create\` (${err instanceof Error ? err.message : String(err)}). ` +
        `Ensure Ollama is installed and on your PATH.`,
    );
  }

  const abortHandler = () => {
    proc.kill('SIGTERM');
  };
  signal.addEventListener('abort', abortHandler);

  const lineQueue: string[] = [];
  let resolveNext: (() => void) | null = null;
  let finished = false;
  let errorMessage: string | null = null;
  let exitCode: number | null = null;

  const wake = () => {
    const r = resolveNext;
    resolveNext = null;
    r?.();
  };

  const attachLineReader = (stream: NodeJS.ReadableStream) => {
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx).trimEnd();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) lineQueue.push(line);
      }
      wake();
    });
    stream.on('end', () => {
      if (buffer.trim()) lineQueue.push(buffer.trim());
      wake();
    });
  };

  attachLineReader(proc.stdout!);
  attachLineReader(proc.stderr!);

  proc.on('error', (err) => {
    errorMessage = err.message;
    finished = true;
    wake();
  });
  proc.on('close', (code) => {
    exitCode = code;
    finished = true;
    wake();
  });

  try {
    while (true) {
      if (lineQueue.length > 0) {
        const line = lineQueue.shift()!;
        yield { phase: 'convert', line };
        continue;
      }
      if (finished) break;
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }
  } finally {
    signal.removeEventListener('abort', abortHandler);
  }

  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (errorMessage) {
    throw new Error(`Failed to spawn \`ollama create\`: ${errorMessage}. Ensure Ollama is installed and on your PATH.`);
  }
  if (exitCode !== 0) {
    throw new Error(
      `\`ollama create\` exited with code ${exitCode}. ` +
        `Staging dir preserved at \`${cwd}\` — cd in and run \`ollama create ${ollamaName} -q ${quantization} -f Modelfile\` to see the full converter log. ` +
        `Common causes: (1) your Ollama version is older than the model's arch support — upgrade via \`brew upgrade ollama\` or download from ollama.com; ` +
        `(2) a tokenizer file was corrupted mid-download — retry the install; ` +
        `(3) the model's tokenizer format isn't supported by Ollama's Go converter yet — fall back to a community GGUF mirror like \`bartowski/${ollamaName.replace('hf.co/', '').replace(/\//g, '-')}-GGUF\`.`,
    );
  }
}
