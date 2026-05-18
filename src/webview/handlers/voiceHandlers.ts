import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as os from 'os';
import { getConfig } from '../../config/settings.js';
import { transcribeAudio } from '../../voice/transcriptionClient.js';
import { transcribeLocally, isLocalModel, isModelLoaded } from '../../voice/localTranscriber.js';
import { VoiceRecordingSession } from '../../voice/recordingServer.js';
import type { WebviewMessage, ExtensionMessage } from '../chatWebview.js';

function safePost(postMessage: (msg: ExtensionMessage) => void, msg: ExtensionMessage): void {
  try {
    postMessage(msg);
  } catch {
    // webview was disposed while voice handler was waiting
  }
}

function openSystemBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = os.platform();
    const cmd =
      platform === 'darwin' ? `open "${url}"` : platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
    exec(cmd, (err) => (err ? reject(err) : resolve()));
  });
}

function transcribeProgressTitle(model: string): string {
  return isLocalModel(model) && !isModelLoaded(model)
    ? `SideCar Voice: downloading ${model} (~75 MB, first run)…`
    : 'SideCar Voice: transcribing…';
}

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
    safePost(postMessage, {
      command: 'voiceResult',
      voiceError: 'Voice input is disabled. Enable sidecar.voice.enabled.',
    });
    return;
  }

  const { pcmBase64 } = msg;
  if (typeof pcmBase64 !== 'string' || pcmBase64.length === 0) {
    safePost(postMessage, { command: 'voiceResult', voiceError: 'No audio data received.' });
    return;
  }

  try {
    const pcmBuffer = Buffer.from(pcmBase64, 'base64');
    let text: string;

    if (isLocalModel(config.voiceModel)) {
      text = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: transcribeProgressTitle(config.voiceModel),
          cancellable: false,
        },
        () => transcribeLocally(pcmBuffer, config.voiceModel),
      );
    } else {
      const baseUrl = config.baseUrl.replace(/\/+$/, '');
      const transcriptionUrl = config.voiceTranscriptionUrl || `${baseUrl}/audio/transcriptions`;
      text = await transcribeAudio(pcmBuffer, msg.mimeType || 'audio/pcm-f32le', {
        model: config.voiceModel,
        apiKey: config.apiKey || '',
        transcriptionUrl,
      });
    }

    safePost(postMessage, { command: 'voiceResult', voiceText: text });
  } catch (err) {
    safePost(postMessage, { command: 'voiceResult', voiceError: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleStartVoice(postMessage: (msg: ExtensionMessage) => void): Promise<void> {
  const config = getConfig();

  if (!config.voiceEnabled) {
    safePost(postMessage, {
      command: 'voiceResult',
      voiceError: 'Voice input is disabled. Enable sidecar.voice.enabled in settings.',
    });
    return;
  }

  const local = isLocalModel(config.voiceModel);
  let session: VoiceRecordingSession | undefined;
  try {
    session = await VoiceRecordingSession.create({ useLocalTranscription: local });
    // Use child_process.exec to open the system browser directly.
    // vscode.env.openExternal is intercepted by VS Code's Simple Browser
    // extension for localhost URLs, which opens a webview that blocks getUserMedia.
    await openSystemBrowser(session.url);
    vscode.window
      .showInformationMessage('SideCar Voice: recording page opened in your browser.', 'Copy URL')
      .then((choice) => {
        if (choice === 'Copy URL') vscode.env.clipboard.writeText(session!.url);
      });

    const { buffer, mimeType } = await session.waitForAudio();

    let text: string;
    if (local) {
      text = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: transcribeProgressTitle(config.voiceModel),
          cancellable: false,
        },
        () => transcribeLocally(buffer, config.voiceModel),
      );
    } else {
      const baseUrl = config.baseUrl.replace(/\/+$/, '');
      const transcriptionUrl = config.voiceTranscriptionUrl || `${baseUrl}/audio/transcriptions`;
      text = await transcribeAudio(buffer, mimeType, {
        model: config.voiceModel,
        apiKey: config.apiKey || '',
        transcriptionUrl,
      });
    }

    safePost(postMessage, { command: 'voiceResult', voiceText: text });
  } catch (err) {
    safePost(postMessage, {
      command: 'voiceResult',
      voiceError: err instanceof Error ? err.message : String(err),
    });
  } finally {
    session?.dispose();
  }
}
