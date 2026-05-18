import * as vscode from 'vscode';
import { getConfig } from '../../config/settings.js';
import { transcribeAudio } from '../../voice/transcriptionClient.js';
import { transcribeLocally, isLocalModel } from '../../voice/localTranscriber.js';
import { VoiceRecordingSession } from '../../voice/recordingServer.js';
import type { WebviewMessage, ExtensionMessage } from '../chatWebview.js';

/**
 * Primary path: the webview recorded audio and decoded it to Float32 PCM at
 * 16 kHz via AudioContext before sending. No server round-trip needed.
 */
export async function handleVoiceAudio(
  msg: WebviewMessage,
  postMessage: (msg: ExtensionMessage) => void,
): Promise<void> {
  const config = getConfig();

  if (!config.voiceEnabled) {
    postMessage({ command: 'voiceResult', voiceError: 'Voice input is disabled. Enable sidecar.voice.enabled.' });
    return;
  }

  const { pcmBase64 } = msg;
  if (typeof pcmBase64 !== 'string' || pcmBase64.length === 0) {
    postMessage({ command: 'voiceResult', voiceError: 'No audio data received.' });
    return;
  }

  try {
    const pcmBuffer = Buffer.from(pcmBase64, 'base64');
    let text: string;

    if (isLocalModel(config.voiceModel)) {
      text = await transcribeLocally(pcmBuffer, config.voiceModel);
    } else {
      const baseUrl = config.baseUrl.replace(/\/+$/, '');
      const transcriptionUrl = config.voiceTranscriptionUrl || `${baseUrl}/audio/transcriptions`;
      text = await transcribeAudio(pcmBuffer, msg.mimeType || 'audio/pcm-f32le', {
        model: config.voiceModel,
        apiKey: config.apiKey || '',
        transcriptionUrl,
      });
    }

    postMessage({ command: 'voiceResult', voiceText: text });
  } catch (err) {
    postMessage({ command: 'voiceResult', voiceError: err instanceof Error ? err.message : String(err) });
  }
}

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
