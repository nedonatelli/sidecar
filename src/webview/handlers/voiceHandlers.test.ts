import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleStartVoice } from './voiceHandlers.js';
import type { ExtensionMessage } from '../chatWebview.js';

vi.mock('../../config/settings.js', () => ({
  getConfig: vi.fn(),
}));

vi.mock('../../voice/transcriptionClient.js', () => ({
  transcribeAudio: vi.fn(),
}));

vi.mock('../../voice/localTranscriber.js', () => ({
  transcribeLocally: vi.fn(),
  isLocalModel: vi.fn((m: string) => m.includes('/')),
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
import { transcribeLocally } from '../../voice/localTranscriber.js';
import { VoiceRecordingSession } from '../../voice/recordingServer.js';
import * as vscode from 'vscode';

const mockGetConfig = vi.mocked(getConfig);
const mockTranscribe = vi.mocked(transcribeAudio);
const mockTranscribeLocally = vi.mocked(transcribeLocally);
const mockCreate = vi.mocked(VoiceRecordingSession.create);

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
  vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
});

describe('handleStartVoice', () => {
  it('uses local transcription when model is a HuggingFace hub ID', async () => {
    const session = makeSession();
    mockCreate.mockResolvedValue(session as never);
    mockTranscribeLocally.mockResolvedValue('Hello world.');
    const { sent, postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(mockTranscribeLocally).toHaveBeenCalledWith(expect.any(Buffer), 'Xenova/whisper-tiny');
    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceText: 'Hello world.' });
    expect(session.dispose).toHaveBeenCalled();
  });

  it('uses HTTP transcription when model is a plain API name', async () => {
    mockGetConfig.mockReturnValue(baseConfig({ voiceModel: 'whisper-1' }) as ReturnType<typeof getConfig>);
    const session = makeSession();
    mockCreate.mockResolvedValue(session as never);
    mockTranscribe.mockResolvedValue('Hello API.');
    const { sent, postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(mockTranscribe).toHaveBeenCalledOnce();
    expect(mockTranscribeLocally).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceText: 'Hello API.' });
  });

  it('passes useLocalTranscription:true to session when model is local', async () => {
    const session = makeSession();
    mockCreate.mockResolvedValue(session as never);
    mockTranscribeLocally.mockResolvedValue('ok');
    const { postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(mockCreate).toHaveBeenCalledWith({ useLocalTranscription: true });
  });

  it('passes useLocalTranscription:false to session when model is HTTP API', async () => {
    mockGetConfig.mockReturnValue(baseConfig({ voiceModel: 'whisper-1' }) as ReturnType<typeof getConfig>);
    const session = makeSession();
    mockCreate.mockResolvedValue(session as never);
    mockTranscribe.mockResolvedValue('ok');
    const { postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(mockCreate).toHaveBeenCalledWith({ useLocalTranscription: false });
  });

  it('posts voiceError and skips transcription when voice is disabled', async () => {
    mockGetConfig.mockReturnValue(baseConfig({ voiceEnabled: false }) as ReturnType<typeof getConfig>);
    const { sent, postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: expect.stringContaining('disabled') });
  });

  it('shows a notification with Copy URL after opening the browser', async () => {
    const session = makeSession();
    mockCreate.mockResolvedValue(session as never);
    mockTranscribeLocally.mockResolvedValue('ok');
    const { postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('recording page opened'),
      'Copy URL',
    );
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

  it('posts voiceError when local transcription throws', async () => {
    const session = makeSession();
    mockCreate.mockResolvedValue(session as never);
    mockTranscribeLocally.mockRejectedValue(new Error('model load failed'));
    const { sent, postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: 'model load failed' });
    expect(session.dispose).toHaveBeenCalled();
  });

  it('coerces non-Error throws to string', async () => {
    const session = makeSession();
    mockCreate.mockResolvedValue(session as never);
    mockTranscribeLocally.mockRejectedValue('raw string error');
    const { sent, postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: 'raw string error' });
  });

  it('derives transcriptionUrl from baseUrl for HTTP API model', async () => {
    mockGetConfig.mockReturnValue(baseConfig({ voiceModel: 'whisper-1' }) as ReturnType<typeof getConfig>);
    const session = makeSession();
    mockCreate.mockResolvedValue(session as never);
    mockTranscribe.mockResolvedValue('ok');
    const { postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    const opts = mockTranscribe.mock.calls[0][2];
    expect(opts.transcriptionUrl).toBe('https://api.openai.com/v1/audio/transcriptions');
  });

  it('trims trailing slash from baseUrl for HTTP API model', async () => {
    mockGetConfig.mockReturnValue(
      baseConfig({ voiceModel: 'whisper-1', baseUrl: 'https://api.openai.com/v1/' }) as ReturnType<typeof getConfig>,
    );
    const session = makeSession();
    mockCreate.mockResolvedValue(session as never);
    mockTranscribe.mockResolvedValue('ok');
    const { postMessage } = captureMessages();

    await handleStartVoice(postMessage);

    const opts = mockTranscribe.mock.calls[0][2];
    expect(opts.transcriptionUrl).toBe('https://api.openai.com/v1/audio/transcriptions');
  });

  it('uses voiceTranscriptionUrl override for HTTP API model', async () => {
    mockGetConfig.mockReturnValue(
      baseConfig({
        voiceModel: 'whisper-1',
        voiceTranscriptionUrl: 'http://localhost:9000/transcribe',
      }) as ReturnType<typeof getConfig>,
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
