import * as vscode from 'vscode';
import { getConfig } from '../../config/settings.js';
import { transcribeAudio } from '../../voice/transcriptionClient.js';
import { transcribeLocally, isLocalModel } from '../../voice/localTranscriber.js';
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

  const local = isLocalModel(config.voiceModel);
  let session: VoiceRecordingSession | undefined;
  try {
    session = await VoiceRecordingSession.create({ useLocalTranscription: local });
    // Open in the system browser. VS Code's Simple Browser extension can
    // intercept localhost URLs and route them to a webview, which blocks
    // getUserMedia. The notification gives the user a fallback copy action.
    await vscode.env.openExternal(vscode.Uri.parse(session.url));
    vscode.window
      .showInformationMessage(
        'SideCar Voice: recording page opened. If it opened inside VS Code instead of Chrome/Firefox, copy the URL and paste it into an external browser.',
        'Copy URL',
      )
      .then((choice) => {
        if (choice === 'Copy URL') vscode.env.clipboard.writeText(session!.url);
      });

    const { buffer, mimeType } = await session.waitForAudio();

    let text: string;
    if (local) {
      text = await transcribeLocally(buffer, config.voiceModel);
    } else {
      const baseUrl = config.baseUrl.replace(/\/+$/, '');
      const transcriptionUrl = config.voiceTranscriptionUrl || `${baseUrl}/audio/transcriptions`;
      text = await transcribeAudio(buffer, mimeType, {
        model: config.voiceModel,
        apiKey: config.apiKey || '',
        transcriptionUrl,
      });
    }

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
