import { describe, it, expect, vi, beforeEach } from 'vitest';
import { transcribeLocally, isLocalModel, _setPipelineForTests } from './localTranscriber.js';

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(),
  env: { allowRemoteModels: false },
}));

import { pipeline as mockCreatePipeline } from '@huggingface/transformers';
const mockCreate = vi.mocked(mockCreatePipeline as unknown as ReturnType<typeof vi.fn>);

function makePipeline(text = 'hello world') {
  return vi.fn().mockResolvedValue({ text });
}

function pcmBuffer(samples = 16000): Buffer {
  // 1 second of silence at 16 kHz as little-endian float32 bytes
  const f32 = new Float32Array(samples);
  return Buffer.from(f32.buffer);
}

beforeEach(() => {
  vi.clearAllMocks();
  _setPipelineForTests(null);
});

describe('transcribeLocally', () => {
  it('returns trimmed transcription text', async () => {
    const pipe = makePipeline('  Hello, world.  ');
    _setPipelineForTests(pipe as never, 'Xenova/whisper-tiny');

    const result = await transcribeLocally(pcmBuffer(), 'Xenova/whisper-tiny');
    expect(result).toBe('Hello, world.');
  });

  it('passes a Float32Array at 16 kHz to the pipeline', async () => {
    const pipe = makePipeline('ok');
    _setPipelineForTests(pipe as never, 'Xenova/whisper-tiny');

    await transcribeLocally(pcmBuffer(8000), 'Xenova/whisper-tiny');

    const [input] = pipe.mock.calls[0];
    expect(input.sampling_rate).toBe(16_000);
    expect(input.data).toBeInstanceOf(Float32Array);
    expect(input.data.length).toBe(8000);
  });

  it('lazy-loads the pipeline on first call', async () => {
    const pipe = makePipeline('lazy');
    mockCreate.mockResolvedValue(pipe as never);

    await transcribeLocally(pcmBuffer(), 'Xenova/whisper-tiny');

    expect(mockCreate).toHaveBeenCalledWith('automatic-speech-recognition', 'Xenova/whisper-tiny', {
      dtype: 'q8',
    });
  });

  it('reuses the cached pipeline on subsequent calls', async () => {
    const pipe = makePipeline('cached');
    _setPipelineForTests(pipe as never, 'Xenova/whisper-tiny');

    await transcribeLocally(pcmBuffer(), 'Xenova/whisper-tiny');
    await transcribeLocally(pcmBuffer(), 'Xenova/whisper-tiny');

    expect(mockCreate).not.toHaveBeenCalled();
    expect(pipe).toHaveBeenCalledTimes(2);
  });

  it('reloads the pipeline when the model changes', async () => {
    const pipe1 = makePipeline('tiny');
    const pipe2 = makePipeline('base');
    _setPipelineForTests(pipe1 as never, 'Xenova/whisper-tiny');
    mockCreate.mockResolvedValue(pipe2 as never);

    await transcribeLocally(pcmBuffer(), 'Xenova/whisper-tiny');
    await transcribeLocally(pcmBuffer(), 'Xenova/whisper-base');

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate.mock.calls[0][1]).toBe('Xenova/whisper-base');
  });

  it('throws when pipeline fails to load', async () => {
    mockCreate.mockRejectedValue(new Error('model not found'));

    await expect(transcribeLocally(pcmBuffer(), 'Xenova/whisper-tiny')).rejects.toThrow(
      'Failed to load local Whisper model',
    );
  });
});

describe('isLocalModel', () => {
  it('returns true for HuggingFace hub IDs', () => {
    expect(isLocalModel('Xenova/whisper-tiny')).toBe(true);
    expect(isLocalModel('onnx-community/whisper-large-v3')).toBe(true);
  });

  it('returns false for plain API model names', () => {
    expect(isLocalModel('whisper-1')).toBe(false);
    expect(isLocalModel('whisper-large-v3-turbo')).toBe(false);
  });
});
