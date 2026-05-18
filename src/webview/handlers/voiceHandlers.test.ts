import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleVoiceAudio } from './voiceHandlers.js';
import type { ExtensionMessage, WebviewMessage } from '../chatWebview.js';

vi.mock('../../config/settings.js', () => ({
  getConfig: vi.fn(),
}));

vi.mock('../../voice/transcriptionClient.js', () => ({
  transcribeAudio: vi.fn(),
}));

import { getConfig } from '../../config/settings.js';
import { transcribeAudio } from '../../voice/transcriptionClient.js';

const mockGetConfig = vi.mocked(getConfig);
const mockTranscribe = vi.mocked(transcribeAudio);

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
  const postMessage = (msg: ExtensionMessage) => {
    sent.push(msg);
  };
  return { sent, postMessage };
}

function voiceMsg(overrides?: Partial<WebviewMessage>): WebviewMessage {
  return {
    command: 'voiceAudio',
    audioBase64: Buffer.from('fake-audio').toString('base64'),
    mimeType: 'audio/webm',
    ...overrides,
  } as WebviewMessage;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockReturnValue(baseConfig() as ReturnType<typeof getConfig>);
});

describe('handleVoiceAudio', () => {
  it('calls transcribeAudio and posts voiceResult with transcribed text', async () => {
    mockTranscribe.mockResolvedValue('Hello, world.');
    const { sent, postMessage } = captureMessages();

    await handleVoiceAudio(voiceMsg(), postMessage);

    expect(mockTranscribe).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceText: 'Hello, world.' });
  });

  it('posts voiceError when voice is disabled', async () => {
    mockGetConfig.mockReturnValue(baseConfig({ voiceEnabled: false }) as ReturnType<typeof getConfig>);
    const { sent, postMessage } = captureMessages();

    await handleVoiceAudio(voiceMsg(), postMessage);

    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: expect.stringContaining('disabled') });
  });

  it('posts voiceError when audioBase64 is missing', async () => {
    const { sent, postMessage } = captureMessages();
    await handleVoiceAudio(voiceMsg({ audioBase64: undefined }), postMessage);
    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: expect.stringContaining('No audio') });
  });

  it('posts voiceError when audioBase64 is empty string', async () => {
    const { sent, postMessage } = captureMessages();
    await handleVoiceAudio(voiceMsg({ audioBase64: '' }), postMessage);
    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: expect.stringContaining('No audio') });
  });

  it('posts voiceError when transcribeAudio throws', async () => {
    mockTranscribe.mockRejectedValue(new Error('backend offline'));
    const { sent, postMessage } = captureMessages();

    await handleVoiceAudio(voiceMsg(), postMessage);

    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: 'backend offline' });
  });

  it('coerces non-Error throws to string', async () => {
    mockTranscribe.mockRejectedValue('string rejection');
    const { sent, postMessage } = captureMessages();

    await handleVoiceAudio(voiceMsg(), postMessage);

    expect(sent[0]).toMatchObject({ command: 'voiceResult', voiceError: 'string rejection' });
  });

  it('derives transcriptionUrl from baseUrl when voiceTranscriptionUrl is empty', async () => {
    mockTranscribe.mockResolvedValue('ok');
    const { postMessage } = captureMessages();

    await handleVoiceAudio(voiceMsg(), postMessage);

    const opts = mockTranscribe.mock.calls[0][2];
    expect(opts.transcriptionUrl).toBe('https://api.openai.com/v1/audio/transcriptions');
  });

  it('trims trailing slash from baseUrl before constructing URL', async () => {
    mockGetConfig.mockReturnValue(
      baseConfig({ baseUrl: 'https://api.openai.com/v1/' }) as ReturnType<typeof getConfig>,
    );
    mockTranscribe.mockResolvedValue('ok');
    const { postMessage } = captureMessages();

    await handleVoiceAudio(voiceMsg(), postMessage);

    const opts = mockTranscribe.mock.calls[0][2];
    expect(opts.transcriptionUrl).toBe('https://api.openai.com/v1/audio/transcriptions');
  });

  it('uses voiceTranscriptionUrl override when set', async () => {
    mockGetConfig.mockReturnValue(
      baseConfig({ voiceTranscriptionUrl: 'http://localhost:9000/transcribe' }) as ReturnType<typeof getConfig>,
    );
    mockTranscribe.mockResolvedValue('ok');
    const { postMessage } = captureMessages();

    await handleVoiceAudio(voiceMsg(), postMessage);

    const opts = mockTranscribe.mock.calls[0][2];
    expect(opts.transcriptionUrl).toBe('http://localhost:9000/transcribe');
  });

  it('passes model and apiKey from config', async () => {
    mockGetConfig.mockReturnValue(
      baseConfig({ voiceModel: 'whisper-large-v3-turbo', apiKey: 'gsk_xyz' }) as ReturnType<typeof getConfig>,
    );
    mockTranscribe.mockResolvedValue('text');
    const { postMessage } = captureMessages();

    await handleVoiceAudio(voiceMsg(), postMessage);

    const opts = mockTranscribe.mock.calls[0][2];
    expect(opts.model).toBe('whisper-large-v3-turbo');
    expect(opts.apiKey).toBe('gsk_xyz');
  });

  it('passes mimeType from the message to transcribeAudio', async () => {
    mockTranscribe.mockResolvedValue('ok');
    const { postMessage } = captureMessages();

    await handleVoiceAudio(voiceMsg({ mimeType: 'audio/ogg' }), postMessage);

    expect(mockTranscribe.mock.calls[0][1]).toBe('audio/ogg');
  });

  it('falls back to audio/webm when mimeType is missing', async () => {
    mockTranscribe.mockResolvedValue('ok');
    const { postMessage } = captureMessages();

    await handleVoiceAudio(voiceMsg({ mimeType: undefined }), postMessage);

    expect(mockTranscribe.mock.calls[0][1]).toBe('audio/webm');
  });
});
