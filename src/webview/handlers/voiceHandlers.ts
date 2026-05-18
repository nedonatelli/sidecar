import * as vscode from 'vscode';
import { getConfig } from '../../config/settings.js';
import { transcribeAudio } from '../../voice/transcriptionClient.js';
import { VoiceRecordingSession } from '../../voice/recordingServer.js';
import type { ExtensionMessage } from '../chatWebview.js';

export async function handleStartVoice(postMessage: (msg: ExtensionMessage) => void): Promise<void> {
  const config = getConfig();

  if (!config.voiceEnabled) {
    postMessage({
      command: 'voiceResult',
      voiceError: 'Voice input is disabled. Enable sidecar.voice.enabled in settings.',
    });
    return;
  }

  let session: VoiceRecordingSession | undefined;
  try {
    session = await VoiceRecordingSession.create();
    const opened = await vscode.env.openExternal(vscode.Uri.parse(session.url));
    if (!opened) {
      postMessage({ command: 'voiceResult', voiceError: 'Could not open recording page in browser.' });
      return;
    }

    const { buffer, mimeType } = await session.waitForAudio();

    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    const transcriptionUrl = config.voiceTranscriptionUrl || `${baseUrl}/audio/transcriptions`;

    const text = await transcribeAudio(buffer, mimeType, {
      model: config.voiceModel,
      apiKey: config.apiKey || '',
      transcriptionUrl,
    });

    postMessage({ command: 'voiceResult', voiceText: text });
  } catch (err) {
    postMessage({
      command: 'voiceResult',
      voiceError: err instanceof Error ? err.message : String(err),
    });
  } finally {
    session?.dispose();
  }
}
