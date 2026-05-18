import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleStartVoice } from './voiceHandlers.js';
import type { ExtensionMessage } from '../chatWebview.js';

vi.mock('../../config/settings.js', () => ({
  getConfig: vi.fn(),
}));

vi.mock('../../voice/transcriptionClient.js', () => ({
  transcribeAudio: vi.fn(),
}));

vi.mock('../../voice/recordingServer.js', () => ({
  VoiceRecordingSession: {
    create: vi.fn(),
  },
}));

vi.mock('vscode', async () => {
  const mod = await import('../../__mocks__/vscode.js');
  return mod;
});

import { getConfig } from '../../config/settings.js';
import { transcribeAudio } from '../../voice/transcriptionClient.js';
import { VoiceRecordingSession } from '../../voice/recordingServer.js';
import * as vscode from 'vscode';

const mockGetConfig = vi.mocked(getConfig);
const mockTranscribe = vi.mocked(transcribeAudio);
const mockCreate = vi.mocked(VoiceRecordingSession.create);

function baseConfig(overrides?: Record<string, unknown>) {
  return {
    voiceEnabled: true,
    voiceModel: 'whisper-1',
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

function makeSession(overrides?: { waitForAudio?: () => Promise<{ buffer: Buffer; mimeType: string }> }) {
  return {
    url: 'http://127.0.0.1:12345/?token=abc',
    dispose: vi.fn(),
    waitForAudio:
      overrides?.waitForAudio ?? vi.fn().mockResolvedValue({ buffer: Buffer.from('audio'), mimeType: 'audio/webm' }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockReturnValue(baseConfig() as ReturnType<typeof getConfig>);
  vi.mocked(vscode.env.openExternal).mockResolvedValue(true);
});

describe('handleStartVoice', () => {
  it('opens the recording URL in the system browser and transcribes the result', async () => {
    const session = makeSession();
    mockCreate.mockResolvedValue(session as never);
    mockTranscribe.mockResolvedValue('Hello world.');
    const { sent, postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(vscode.env.openExternal).toHaveBeenCalledWith(vscode.Uri.parse('http://127.0.0.1:12345/?token=abc'));
    expect(mockTranscribe).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceText: 'Hello world.' });
    expect(session.dispose).toHaveBeenCalled();
  });

  it('posts voiceError and skips transcription when voice is disabled', async () => {
    mockGetConfig.mockReturnValue(baseConfig({ voiceEnabled: false }) as ReturnType<typeof getConfig>);
    const { sent, postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: expect.stringContaining('disabled') });
  });

  it('posts voiceError when openExternal returns false', async () => {
    vi.mocked(vscode.env.openExternal).mockResolvedValue(false);
    const session = makeSession();
    mockCreate.mockResolvedValue(session as never);
    const { sent, postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: expect.stringContaining('Could not open') });
    expect(session.dispose).toHaveBeenCalled();
  });

  it('posts voiceError when waitForAudio times out', async () => {
    const session = makeSession({
      waitForAudio: vi.fn().mockRejectedValue(new Error('Voice recording timed out.')),
    });
    mockCreate.mockResolvedValue(session as never);
    const { sent, postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: 'Voice recording timed out.' });
    expect(session.dispose).toHaveBeenCalled();
  });

  it('posts voiceError when transcribeAudio throws', async () => {
    const session = makeSession();
    mockCreate.mockResolvedValue(session as never);
    mockTranscribe.mockRejectedValue(new Error('Whisper offline'));
    const { sent, postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: 'Whisper offline' });
    expect(session.dispose).toHaveBeenCalled();
  });

  it('coerces non-Error throws to string', async () => {
    const session = makeSession();
    mockCreate.mockResolvedValue(session as never);
    mockTranscribe.mockRejectedValue('raw string error');
    const { sent, postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: 'raw string error' });
  });

  it('derives transcriptionUrl from baseUrl when voiceTranscriptionUrl is empty', async () => {
    const session = makeSession();
    mockCreate.mockResolvedValue(session as never);
    mockTranscribe.mockResolvedValue('ok');
    const { postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    const opts = mockTranscribe.mock.calls[0][2];
    expect(opts.transcriptionUrl).toBe('https://api.openai.com/v1/audio/transcriptions');
  });

  it('trims trailing slash from baseUrl', async () => {
    mockGetConfig.mockReturnValue(
      baseConfig({ baseUrl: 'https://api.openai.com/v1/' }) as ReturnType<typeof getConfig>,
    );
    const session = makeSession();
    mockCreate.mockResolvedValue(session as never);
    mockTranscribe.mockResolvedValue('ok');
    const { postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    const opts = mockTranscribe.mock.calls[0][2];
    expect(opts.transcriptionUrl).toBe('https://api.openai.com/v1/audio/transcriptions');
  });

  it('uses voiceTranscriptionUrl override when set', async () => {
    mockGetConfig.mockReturnValue(
      baseConfig({ voiceTranscriptionUrl: 'http://localhost:9000/transcribe' }) as ReturnType<typeof getConfig>,
    );
    const session = makeSession();
    mockCreate.mockResolvedValue(session as never);
    mockTranscribe.mockResolvedValue('ok');
    const { postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    const opts = mockTranscribe.mock.calls[0][2];
    expect(opts.transcriptionUrl).toBe('http://localhost:9000/transcribe');
  });
});
