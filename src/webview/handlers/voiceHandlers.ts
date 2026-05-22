import * as vscode from 'vscode';
import { getConfig } from '../../config/settings.js';
import { stripTrailingSlash } from '../../util/url.js';
import { transcribeAudio } from '../../voice/transcriptionClient.js';
import { transcribeLocally, isLocalModel, isModelLoaded } from '../../voice/localTranscriber.js';
import { isHostRecordingAvailable, startHostRecording } from '../../voice/hostRecorder.js';
import type { RecordingHandle } from '../../voice/hostRecorder.js';
import type { WebviewMessage, ExtensionMessage } from '../chatWebview.js';

function safePost(postMessage: (msg: ExtensionMessage) => void, msg: ExtensionMessage): void {
  try {
    postMessage(msg);
  } catch {
    // webview was disposed while voice handler was waiting
  }
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
      const baseUrl = stripTrailingSlash(config.baseUrl);
      const transcriptionUrl = config.voiceTranscriptionUrl || `${baseUrl}/audio/transcriptions`;
      text = await transcribeAudio(pcmBuffer, msg.mimeType || 'audio/pcm-f32le', {
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
  }
}

/**
 * Fallback path triggered when the webview's getUserMedia fails (always in VS Code).
 * Records directly in the extension host — no browser window.
 */
export async function handleStartVoice(postMessage: (msg: ExtensionMessage) => void): Promise<void> {
  const config = getConfig();

  if (!config.voiceEnabled) {
    safePost(postMessage, {
      command: 'voiceResult',
      voiceError: 'Voice input is disabled. Enable sidecar.voice.enabled in settings.',
    });
    return;
  }

  if (!(await isHostRecordingAvailable())) {
    const platform = process.platform;
    const hint =
      platform === 'linux'
        ? 'Install alsa-utils: sudo apt install alsa-utils'
        : platform === 'darwin'
          ? 'Install Xcode command line tools: xcode-select --install'
          : 'Ensure PowerShell is available.';
    safePost(postMessage, {
      command: 'voiceResult',
      voiceError: `Voice recording is not available on this system. ${hint}`,
    });
    return;
  }

  const local = isLocalModel(config.voiceModel);
  let handle: RecordingHandle | undefined;
  try {
    let needsCompile = false;

    handle = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'SideCar Voice: preparing microphone…',
        cancellable: false,
      },
      () =>
        startHostRecording(() => {
          needsCompile = true;
        }),
    );

    // If the Swift binary was compiled during this call, the progress title was wrong —
    // show a brief "compiled" notification so the user knows the wait was one-time.
    if (needsCompile) {
      vscode.window.showInformationMessage('SideCar Voice: microphone helper compiled (one-time setup).');
    }

    const buffer = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'SideCar Voice: recording… click Cancel to stop',
        cancellable: true,
      },
      (_progress, token) =>
        new Promise<Buffer>((resolve, reject) => {
          const finish = (fn: () => Promise<Buffer>) => {
            fn().then(resolve).catch(reject);
          };
          token.onCancellationRequested(() => finish(() => handle!.stop()));
          // Auto-stop after 2 minutes
          setTimeout(() => finish(() => handle!.stop()), 120_000);
        }),
    );

    if (buffer.length < 256) {
      safePost(postMessage, { command: 'voiceResult', voiceError: 'No audio captured.' });
      return;
    }

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
      const baseUrl = stripTrailingSlash(config.baseUrl);
      const transcriptionUrl = config.voiceTranscriptionUrl || `${baseUrl}/audio/transcriptions`;
      text = await transcribeAudio(buffer, 'audio/pcm-f32le', {
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
    handle?.dispose();
  }
}
