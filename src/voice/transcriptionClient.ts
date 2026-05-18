// ---------------------------------------------------------------------------
// Whisper-compatible transcription client.
//
// Calls the OpenAI-compatible `/v1/audio/transcriptions` endpoint (supported
// by OpenAI, Groq fast-whisper, and any Whisper-capable local server).
// Uses Node 18+ globals (FormData, Blob, fetch) so no extra dependencies.
// ---------------------------------------------------------------------------

export interface TranscriptionOptions {
  model: string;
  apiKey: string;
  transcriptionUrl: string;
  signal?: AbortSignal;
}

function audioFilename(mimeType: string): string {
  const t = mimeType.split(';')[0].toLowerCase();
  if (t.includes('webm')) return 'audio.webm';
  if (t.includes('ogg')) return 'audio.ogg';
  if (t.includes('mp4')) return 'audio.mp4';
  if (t.includes('wav')) return 'audio.wav';
  if (t.includes('mpeg') || t.includes('mp3')) return 'audio.mp3';
  return 'audio.bin';
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string,
  options: TranscriptionOptions,
): Promise<string> {
  const cleanMime = mimeType.split(';')[0].trim() || 'audio/webm';
  const arrayBuf = audioBuffer.buffer.slice(
    audioBuffer.byteOffset,
    audioBuffer.byteOffset + audioBuffer.byteLength,
  ) as ArrayBuffer;
  const blob = new Blob([arrayBuf], { type: cleanMime });
  const form = new FormData();
  form.append('file', blob, audioFilename(mimeType));
  form.append('model', options.model);

  const headers: Record<string, string> = {};
  if (options.apiKey) headers['Authorization'] = `Bearer ${options.apiKey}`;

  const response = await fetch(options.transcriptionUrl, {
    method: 'POST',
    headers,
    body: form,
    signal: options.signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable body)');
    throw new Error(`Transcription request failed (HTTP ${response.status}): ${body.slice(0, 300)}`);
  }

  const json = (await response.json()) as { text?: unknown };
  if (typeof json.text !== 'string') {
    throw new Error('Transcription response is missing the "text" field.');
  }
  return json.text.trim();
}
