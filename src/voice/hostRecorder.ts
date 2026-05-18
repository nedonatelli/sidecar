import { execFile, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface RecordingHandle {
  /** Stop recording and return raw Float32 PCM at 16 kHz (mono). */
  stop(): Promise<Buffer>;
  /** Kill the process and clean up temp files without reading audio. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// macOS — Swift + AVFoundation
//
// Compiled once with swiftc, cached at ~/.config/sidecar/bin/recorder-<arch>.
// Records at native hardware rate, converts to Float32 PCM 16 kHz inline.
// Stops on SIGTERM.
// ---------------------------------------------------------------------------

const SWIFT_SOURCE = `
import AVFoundation
import Foundation

guard CommandLine.arguments.count > 1 else { exit(1) }
let outputPath = CommandLine.arguments[1]

FileManager.default.createFile(atPath: outputPath, contents: nil)
let fileHandle = FileHandle(forWritingAtPath: outputPath)!

let engine = AVAudioEngine()
let inputNode = engine.inputNode
let targetFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: 16000,
    channels: 1,
    interleaved: true
)!

inputNode.installTap(onBus: 0, bufferSize: 4096, format: nil) { buffer, _ in
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16000.0 / buffer.format.sampleRate)
    guard capacity > 0,
          let converted = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity),
          let converter = AVAudioConverter(from: buffer.format, to: targetFormat)
    else { return }
    var inputGiven = false
    var convErr: NSError?
    converter.convert(to: converted, error: &convErr) { _, status in
        defer { inputGiven = true }
        status.pointee = inputGiven ? .noDataNow : .haveData
        return inputGiven ? nil : buffer
    }
    guard convErr == nil, converted.frameLength > 0,
          let ch = converted.floatChannelData?[0] else { return }
    fileHandle.write(Data(bytes: ch, count: Int(converted.frameLength) * 4))
}

do { try engine.start() }
catch { fputs("error: \\(error)\\n", stderr); exit(1) }

fputs("RECORDING\\n", stderr)
fflush(stderr)

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT)  { _ in exit(0) }
RunLoop.main.run()
`;

const SOURCE_HASH = crypto.createHash('sha256').update(SWIFT_SOURCE).digest('hex').slice(0, 8);
const BIN_DIR = path.join(os.homedir(), '.config', 'sidecar', 'bin');
const RECORDER_BIN = path.join(BIN_DIR, `recorder-darwin-${os.arch()}`);
const RECORDER_STAMP = `${RECORDER_BIN}.${SOURCE_HASH}.ok`;

async function ensureMacRecorder(onCompiling?: () => void): Promise<string> {
  try {
    await fsp.access(RECORDER_STAMP);
    return RECORDER_BIN;
  } catch {
    /* need to compile */
  }

  await fsp.mkdir(BIN_DIR, { recursive: true });
  const srcPath = path.join(BIN_DIR, 'recorder.swift');
  await fsp.writeFile(srcPath, SWIFT_SOURCE, 'utf8');

  onCompiling?.();
  await execFileAsync('swiftc', [srcPath, '-o', RECORDER_BIN]);
  await fsp.chmod(RECORDER_BIN, 0o755);
  await fsp.writeFile(RECORDER_STAMP, '');
  await fsp.unlink(srcPath).catch(() => {});

  return RECORDER_BIN;
}

class MacOSRecorder implements RecordingHandle {
  private proc: ReturnType<typeof spawn> | null = null;
  private outputPath = path.join(os.tmpdir(), `sc-voice-${process.pid}-${Date.now()}.f32`);
  private _stopped = false;

  spawn(binaryPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proc = spawn(binaryPath, [this.outputPath]);
      let stderr = '';
      this.proc.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
        if (stderr.includes('RECORDING')) resolve();
        if (stderr.includes('error:')) reject(new Error(stderr.split('error:')[1].trim()));
      });
      this.proc.on('error', reject);
      setTimeout(() => reject(new Error('Microphone not available or permission denied.')), 5000);
    });
  }

  async stop(): Promise<Buffer> {
    if (this._stopped) return Buffer.alloc(0);
    this._stopped = true;
    this.proc?.kill('SIGTERM');
    await new Promise<void>((r) => {
      this.proc?.once('close', r);
      setTimeout(r, 1000);
    });
    try {
      return await fsp.readFile(this.outputPath);
    } finally {
      fsp.unlink(this.outputPath).catch(() => {});
    }
  }

  dispose(): void {
    this._stopped = true;
    this.proc?.kill('SIGKILL');
    fs.unlink(this.outputPath, () => {});
  }
}

// ---------------------------------------------------------------------------
// Linux — arecord (alsa-utils) or sox
//
// Records S16_LE at 16 kHz, then converts to Float32 in Node.
// Most Ubuntu/Debian desktops ship alsa-utils by default.
// ---------------------------------------------------------------------------

async function findLinuxTool(): Promise<'arecord' | 'sox' | null> {
  for (const tool of ['arecord', 'sox']) {
    try {
      await execFileAsync('which', [tool]);
      return tool as 'arecord' | 'sox';
    } catch {
      /* try next */
    }
  }
  return null;
}

class LinuxRecorder implements RecordingHandle {
  private proc: ReturnType<typeof spawn> | null = null;
  private outputPath = path.join(os.tmpdir(), `sc-voice-${process.pid}-${Date.now()}.s16`);
  private _stopped = false;

  constructor(private readonly tool: 'arecord' | 'sox') {}

  spawn(): Promise<void> {
    return new Promise((resolve, reject) => {
      const args =
        this.tool === 'arecord'
          ? ['-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw', this.outputPath]
          : ['-q', '-d', '-r', '16000', '-c', '1', '-e', 'signed', '-b', '16', '-t', 'raw', this.outputPath];
      this.proc = spawn(this.tool === 'sox' ? 'rec' : this.tool, args);
      this.proc.on('error', reject);
      this.proc.on('spawn', () => setTimeout(resolve, 150)); // brief init wait
    });
  }

  async stop(): Promise<Buffer> {
    if (this._stopped) return Buffer.alloc(0);
    this._stopped = true;
    this.proc?.kill('SIGTERM');
    await new Promise<void>((r) => {
      this.proc?.once('close', r);
      setTimeout(r, 1000);
    });
    const raw = await fsp.readFile(this.outputPath).catch(() => Buffer.alloc(0));
    fsp.unlink(this.outputPath).catch(() => {});
    return s16leToFloat32(raw);
  }

  dispose(): void {
    this._stopped = true;
    this.proc?.kill('SIGKILL');
    fs.unlink(this.outputPath, () => {});
  }
}

// ---------------------------------------------------------------------------
// Windows — PowerShell + WinMM MCI
//
// Uses winmm.dll (always present) to capture PCM via MCI API.
// Records 16-bit 16 kHz mono to a WAV file; strips header + converts to Float32.
// Stops when a sentinel "stop file" is created.
// ---------------------------------------------------------------------------

const PS_RECORDER = `
param([string]$OutPath, [string]$StopFile)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Mci {
    [DllImport("winmm.dll")]
    public static extern int mciSendString(string cmd, System.Text.StringBuilder ret, int retLen, IntPtr cb);
}
"@
[Mci]::mciSendString("open new type waveaudio alias rec", $null, 0, [IntPtr]::Zero) | Out-Null
[Mci]::mciSendString("set rec time format ms bitspersample 16 channels 1 samplespersec 16000", $null, 0, [IntPtr]::Zero) | Out-Null
[Mci]::mciSendString("record rec", $null, 0, [IntPtr]::Zero) | Out-Null
Write-Host "RECORDING"
[Console]::Out.Flush()
while (-not (Test-Path $StopFile)) { Start-Sleep -Milliseconds 50 }
[Mci]::mciSendString("stop rec", $null, 0, [IntPtr]::Zero) | Out-Null
[Mci]::mciSendString("save rec \`"$OutPath\`"", $null, 0, [IntPtr]::Zero) | Out-Null
[Mci]::mciSendString("close rec", $null, 0, [IntPtr]::Zero) | Out-Null
`;

class WindowsRecorder implements RecordingHandle {
  private proc: ReturnType<typeof spawn> | null = null;
  private outputPath = path.join(os.tmpdir(), `sc-voice-${process.pid}-${Date.now()}.wav`);
  private stopFile = path.join(os.tmpdir(), `sc-vstop-${process.pid}-${Date.now()}.flag`);
  private scriptPath = path.join(os.tmpdir(), `sc-vrecorder-${process.pid}.ps1`);
  private _stopped = false;

  spawn(): Promise<void> {
    return new Promise((resolve, reject) => {
      fsp
        .writeFile(this.scriptPath, PS_RECORDER, 'utf8')
        .then(() => {
          this.proc = spawn('powershell', [
            '-NonInteractive',
            '-NoProfile',
            '-File',
            this.scriptPath,
            '-OutPath',
            this.outputPath,
            '-StopFile',
            this.stopFile,
          ]);
          let stdout = '';
          this.proc.stdout?.on('data', (d: Buffer) => {
            stdout += d.toString();
            if (stdout.includes('RECORDING')) resolve();
          });
          this.proc.on('error', reject);
          setTimeout(() => reject(new Error('Microphone not available or permission denied.')), 8000);
        })
        .catch(reject);
    });
  }

  async stop(): Promise<Buffer> {
    if (this._stopped) return Buffer.alloc(0);
    this._stopped = true;
    await fsp.writeFile(this.stopFile, '').catch(() => {});
    await new Promise<void>((r) => {
      this.proc?.once('close', r);
      setTimeout(r, 2000);
    });
    const wav = await fsp.readFile(this.outputPath).catch(() => Buffer.alloc(0));
    await Promise.all([
      fsp.unlink(this.outputPath).catch(() => {}),
      fsp.unlink(this.stopFile).catch(() => {}),
      fsp.unlink(this.scriptPath).catch(() => {}),
    ]);
    const pcm16 = wavDataSlice(wav);
    return s16leToFloat32(pcm16);
  }

  dispose(): void {
    this._stopped = true;
    this.proc?.kill();
    fs.unlink(this.outputPath, () => {});
    fs.unlink(this.stopFile, () => {});
    fs.unlink(this.scriptPath, () => {});
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function s16leToFloat32(buf: Buffer): Buffer {
  const samples = Math.floor(buf.byteLength / 2);
  const out = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    out.writeFloatLE(buf.readInt16LE(i * 2) / 32768, i * 4);
  }
  return out;
}

function wavDataSlice(buf: Buffer): Buffer {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.slice(off + 8, off + 8 + size);
    off += 8 + size + (size % 2); // WAV chunks are word-aligned
  }
  return buf.slice(44); // safe fallback
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if host recording is supported on the current platform.
 * macOS requires swiftc; Linux requires arecord or sox; Windows always works.
 */
export async function isHostRecordingAvailable(): Promise<boolean> {
  const p = os.platform();
  if (p === 'darwin') {
    try {
      await fsp.access('/usr/bin/swiftc');
      return true;
    } catch {
      return false;
    }
  }
  if (p === 'linux') return (await findLinuxTool()) !== null;
  if (p === 'win32') return true;
  return false;
}

/**
 * Start recording from the default microphone. Returns a handle whose
 * `stop()` resolves with raw Float32 PCM at 16 kHz.
 *
 * @param onCompiling  Called on macOS when the Swift helper needs to be compiled (first run).
 */
export async function startHostRecording(onCompiling?: () => void): Promise<RecordingHandle> {
  const p = os.platform();

  if (p === 'darwin') {
    const bin = await ensureMacRecorder(onCompiling);
    const rec = new MacOSRecorder();
    await rec.spawn(bin);
    return rec;
  }

  if (p === 'linux') {
    const tool = await findLinuxTool();
    if (!tool) throw new Error('Voice recording requires arecord or sox. Install with: sudo apt install alsa-utils');
    const rec = new LinuxRecorder(tool);
    await rec.spawn();
    return rec;
  }

  if (p === 'win32') {
    const rec = new WindowsRecorder();
    await rec.spawn();
    return rec;
  }

  throw new Error(`Voice recording is not supported on ${p}.`);
}
