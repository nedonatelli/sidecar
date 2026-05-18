import { getConfig } from '../../config/settings.js';
import { transcribeAudio } from '../../voice/transcriptionClient.js';
import type { WebviewMessage, ExtensionMessage } from '../chatWebview.js';

export async function handleVoiceAudio(
  msg: WebviewMessage,
  postMessage: (msg: ExtensionMessage) => void,
): Promise<void> {
  const config = getConfig();

  if (!config.voiceEnabled) {
    postMessage({ command: 'voiceResult', voiceError: 'Voice input is disabled. Set sidecar.voice.enabled to true.' });
    return;
  }

  const { audioBase64, mimeType } = msg;
  if (typeof audioBase64 !== 'string' || audioBase64.length === 0) {
    postMessage({ command: 'voiceResult', voiceError: 'No audio data received.' });
    return;
  }

  const audioBuffer = Buffer.from(audioBase64, 'base64');
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const transcriptionUrl = config.voiceTranscriptionUrl || `${baseUrl}/audio/transcriptions`;

  try {
    const text = await transcribeAudio(audioBuffer, mimeType || 'audio/webm', {
      model: config.voiceModel,
      apiKey: config.apiKey || '',
      transcriptionUrl,
    });
    postMessage({ command: 'voiceResult', voiceText: text });
  } catch (err) {
    postMessage({ command: 'voiceResult', voiceError: err instanceof Error ? err.message : String(err) });
  }
}
