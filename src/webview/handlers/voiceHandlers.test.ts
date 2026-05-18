import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleStartVoice, handleVoiceAudio } from './voiceHandlers.js';
import type { ExtensionMessage } from '../chatWebview.js';

vi.mock('../../config/settings.js', () => ({ getConfig: vi.fn() }));
vi.mock('../../voice/transcriptionClient.js', () => ({ transcribeAudio: vi.fn() }));
vi.mock('../../voice/localTranscriber.js', () => ({
  transcribeLocally: vi.fn(),
  isLocalModel: vi.fn((m: string) => m.includes('/')),
  isModelLoaded: vi.fn().mockReturnValue(true),
}));
vi.mock('../../voice/hostRecorder.js', () => ({
  isHostRecordingAvailable: vi.fn().mockResolvedValue(true),
  startHostRecording: vi.fn(),
}));
vi.mock('vscode', async () => {
  const mod = await import('../../__mocks__/vscode.js');
  return mod;
});

import { getConfig } from '../../config/settings.js';
import { transcribeAudio } from '../../voice/transcriptionClient.js';
import { transcribeLocally } from '../../voice/localTranscriber.js';
import { isHostRecordingAvailable, startHostRecording } from '../../voice/hostRecorder.js';
import * as vscode from 'vscode';

const mockGetConfig = vi.mocked(getConfig);
const mockTranscribe = vi.mocked(transcribeAudio);
const mockTranscribeLocally = vi.mocked(transcribeLocally);
const mockIsAvailable = vi.mocked(isHostRecordingAvailable);
const mockStartRecording = vi.mocked(startHostRecording);

function baseConfig(overrides?: Record<string, unknown>) {
  return {
    voiceEnabled: true,
    voiceModel: 'Xenova/whisper-tiny',
    voiceTranscriptionUrl: '',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    ...overrides,
  };
}

function captureMessages() {
  const sent: ExtensionMessage[] = [];
  return { sent, postMessage: (msg: ExtensionMessage) => sent.push(msg) };
}

function makeHandle(pcm = Buffer.from('audio')) {
  return { stop: vi.fn().mockResolvedValue(pcm), dispose: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockReturnValue(baseConfig() as ReturnType<typeof getConfig>);
  mockIsAvailable.mockResolvedValue(true);
  vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
  // For voice recording the cancellable withProgress needs to actually fire cancel
  // so the recording promise resolves. Auto-cancel on next tick.
  vi.spyOn(vscode.window, 'withProgress').mockImplementation((async (
    opts: unknown,
    task: (progress: unknown, token: unknown) => Promise<unknown>,
  ) => {
    const cbs: Array<() => void> = [];
    const token = { onCancellationRequested: (cb: () => void) => cbs.push(cb) };
    const result = task({}, token);
    if ((opts as { cancellable?: boolean }).cancellable) {
      await Promise.resolve();
      cbs.forEach((cb) => cb());
    }
    return result;
  }) as never);
});

// ---------------------------------------------------------------------------
// handleStartVoice
// ---------------------------------------------------------------------------

describe('handleStartVoice', () => {
  it('starts host recording and transcribes with local model', async () => {
    const handle = makeHandle(Buffer.alloc(512));
    mockStartRecording.mockResolvedValue(handle as never);
    mockTranscribeLocally.mockResolvedValue('hello world');
    const { sent, postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(mockStartRecording).toHaveBeenCalledOnce();
    expect(mockTranscribeLocally).toHaveBeenCalledWith(expect.any(Buffer), 'Xenova/whisper-tiny');
    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceText: 'hello world' });
    expect(handle.dispose).toHaveBeenCalled();
  });

  it('uses HTTP transcription when model is a plain API name', async () => {
    mockGetConfig.mockReturnValue(baseConfig({ voiceModel: 'whisper-1' }) as ReturnType<typeof getConfig>);
    const handle = makeHandle(Buffer.alloc(512));
    mockStartRecording.mockResolvedValue(handle as never);
    mockTranscribe.mockResolvedValue('from api');
    const { sent, postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(mockTranscribe).toHaveBeenCalledOnce();
    expect(mockTranscribeLocally).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceText: 'from api' });
  });

  it('posts voiceError when voice is disabled', async () => {
    mockGetConfig.mockReturnValue(baseConfig({ voiceEnabled: false }) as ReturnType<typeof getConfig>);
    const { sent, postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(mockStartRecording).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: expect.stringContaining('disabled') });
  });

  it('posts voiceError with install hint when host recording unavailable', async () => {
    mockIsAvailable.mockResolvedValue(false);
    const { sent, postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(mockStartRecording).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: expect.stringContaining('not available') });
  });

  it('posts voiceError when buffer is too short (empty recording)', async () => {
    const handle = makeHandle(Buffer.alloc(4)); // < 256 bytes
    mockStartRecording.mockResolvedValue(handle as never);
    const { sent, postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: expect.stringContaining('No audio') });
  });

  it('posts voiceError and disposes when transcription throws', async () => {
    const handle = makeHandle(Buffer.alloc(512));
    mockStartRecording.mockResolvedValue(handle as never);
    mockTranscribeLocally.mockRejectedValue(new Error('model failed'));
    const { sent, postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: 'model failed' });
    expect(handle.dispose).toHaveBeenCalled();
  });

  it('posts voiceError when startHostRecording throws', async () => {
    mockStartRecording.mockRejectedValue(new Error('microphone denied'));
    const { sent, postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: 'microphone denied' });
  });

  it('shows one-time compile notification when onCompiling fires', async () => {
    mockStartRecording.mockImplementation(async (onCompiling?: () => void) => {
      onCompiling?.();
      return makeHandle(Buffer.alloc(512)) as never;
    });
    mockTranscribeLocally.mockResolvedValue('ok');
    const { postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('compiled'));
  });

  it('does not crash when postMessage throws (webview disposed)', async () => {
    const handle = makeHandle(Buffer.alloc(512));
    mockStartRecording.mockResolvedValue(handle as never);
    mockTranscribeLocally.mockResolvedValue('ok');
    const brokenPost = () => {
      throw new Error('disposed');
    };

    await expect(handleStartVoice(brokenPost)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleVoiceAudio
// ---------------------------------------------------------------------------

describe('handleVoiceAudio', () => {
  it('transcribes pcmBase64 payload via local pipeline', async () => {
    const pcm = Buffer.alloc(8);
    const msg = { command: 'voiceAudio' as const, pcmBase64: pcm.toString('base64'), mimeType: 'audio/pcm-f32le' };
    mockTranscribeLocally.mockResolvedValue('hi there');
    const { sent, postMessage } = captureMessages();

    await handleVoiceAudio(msg as never, postMessage);

    expect(mockTranscribeLocally).toHaveBeenCalledWith(expect.any(Buffer), 'Xenova/whisper-tiny');
    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceText: 'hi there' });
  });

  it('posts voiceError when pcmBase64 is missing', async () => {
    const msg = { command: 'voiceAudio' as const };
    const { sent, postMessage } = captureMessages();

    await handleVoiceAudio(msg as never, postMessage);

    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: expect.stringContaining('No audio') });
  });

  it('posts voiceError when voice is disabled', async () => {
    mockGetConfig.mockReturnValue(baseConfig({ voiceEnabled: false }) as ReturnType<typeof getConfig>);
    const { sent, postMessage } = captureMessages();

    await handleVoiceAudio({ command: 'voiceAudio' as const } as never, postMessage);

    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: expect.stringContaining('disabled') });
  });

  it('does not crash when postMessage throws (webview disposed)', async () => {
    const pcm = Buffer.alloc(8);
    const msg = { command: 'voiceAudio' as const, pcmBase64: pcm.toString('base64') };
    mockTranscribeLocally.mockResolvedValue('ok');
    const brokenPost = () => {
      throw new Error('disposed');
    };

    await expect(handleVoiceAudio(msg as never, brokenPost)).resolves.toBeUndefined();
  });
});
