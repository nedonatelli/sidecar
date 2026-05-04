import { window, commands, workspace, env, Uri, ExtensionContext } from 'vscode';
import {
  getConfig,
  isLocalOllama,
  setApiKeySecret,
  setHuggingFaceToken,
  clearHuggingFaceToken,
} from '../config/settings.js';

/** Public skill marketplace — browseable GitHub topic index of `sidecar-skill` repos. */
export const SKILL_MARKETPLACE_URL = 'https://github.com/topics/sidecar-skill';
import { registerNoSqlMcpCommands } from './noSqlMcpCommands.js';
import type { ChatViewProvider } from '../webview/chatView.js';
import type { SkillLoader } from '../agent/skillLoader.js';

export interface SettingsCommandDeps {
  getChatProvider: () => ChatViewProvider | undefined;
  getSkillLoader: () => SkillLoader | undefined;
}

/**
 * Register chat-shortcut, API key, backend-switch, and skill-sync commands.
 * Extracted from extension.ts to keep the entry point under 150 lines.
 */
export function registerSettingsCommands(context: ExtensionContext, deps: SettingsCommandDeps): void {
  const { getChatProvider, getSkillLoader } = deps;

  context.subscriptions.push(
    commands.registerCommand('sidecar.toggleChat', () => {
      commands.executeCommand('sidecar.chatView.focus');
    }),
    commands.registerCommand('sidecar.clearChat', () => {
      getChatProvider()?.clearChat();
    }),
    commands.registerCommand('sidecar.undoChanges', () => {
      getChatProvider()?.undoChanges();
    }),
    commands.registerCommand('sidecar.exportChat', () => {
      getChatProvider()?.exportChat();
    }),
    commands.registerCommand('sidecar.skills.openMarketplace', () => {
      void env.openExternal(Uri.parse(SKILL_MARKETPLACE_URL));
    }),
    commands.registerCommand('sidecar.syncSkillRegistries', async () => {
      const skillCfg = getConfig();
      const { syncSkillRegistries } = await import('../agent/skillRegistrySync.js');
      const refs = await syncSkillRegistries({
        config: {
          skillsUserRegistry: skillCfg.skillsUserRegistry,
          skillsAutoPull: 'on-start',
          skillsTeamRegistries: skillCfg.skillsTeamRegistries,
          skillsTrustedRegistries: skillCfg.skillsTrustedRegistries,
          skillsOffline: skillCfg.skillsOffline,
        },
        trustPrompt: async (ref) => {
          const choice = await window.showInformationMessage(
            `SideCar: trust skill registry \`${ref.url}\`?`,
            { modal: true },
            'Trust this registry',
            'Skip',
          );
          return choice === 'Trust this registry';
        },
      });
      await getSkillLoader()?.loadRegistrySkills(refs);
      window.showInformationMessage(`SideCar: synced ${refs.length} skill registr${refs.length === 1 ? 'y' : 'ies'}.`);
    }),
    commands.registerCommand('sidecar.setApiKey', async () => {
      const value = await window.showInputBox({
        prompt: 'Enter your API key (stored securely in VS Code SecretStorage)',
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) return;
      const trimmed = value.trim();
      if (!trimmed) {
        window.showWarningMessage('SideCar API key was empty — not saved.');
        return;
      }

      const { detectActiveProfile, setProfileApiKey, getConfig: readConfig } = await import('../config/settings.js');
      const activeProfile = detectActiveProfile(readConfig().baseUrl);
      if (activeProfile && activeProfile.secretKey) {
        await setProfileApiKey(activeProfile, trimmed);
        window.showInformationMessage(`SideCar API key saved for ${activeProfile.name}.`);
      } else {
        await setApiKeySecret(trimmed);
        window.showInformationMessage('SideCar API key saved to SecretStorage.');
      }
      getChatProvider()?.reloadModels();
    }),
    commands.registerCommand('sidecar.setHuggingFaceToken', async () => {
      const pick = await window.showQuickPick(
        [
          { label: 'Set / Update token', id: 'set' },
          { label: 'Clear stored token', id: 'clear' },
        ],
        {
          title: 'SideCar: HuggingFace access token',
          placeHolder: 'Used to download gated Safetensors models (Llama, Gemma, etc.)',
        },
      );
      if (!pick) return;
      if (pick.id === 'clear') {
        await clearHuggingFaceToken();
        window.showInformationMessage('HuggingFace token removed.');
        return;
      }
      const value = await window.showInputBox({
        prompt: 'Paste your HuggingFace access token (https://huggingface.co/settings/tokens)',
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) return;
      const trimmed = value.trim();
      if (!trimmed) {
        window.showWarningMessage('HuggingFace token was empty — not saved.');
        return;
      }
      await setHuggingFaceToken(trimmed);
      window.showInformationMessage('HuggingFace token saved to SecretStorage.');
    }),
    commands.registerCommand('sidecar.switchBackend', async (profileId?: unknown) => {
      const { BUILT_IN_BACKEND_PROFILES, applyBackendProfile } = await import('../config/settings.js');
      const requestedId = typeof profileId === 'string' ? profileId : undefined;
      let profile = requestedId ? BUILT_IN_BACKEND_PROFILES.find((p) => p.id === requestedId) : undefined;
      if (!profile) {
        const pick = await window.showQuickPick(
          BUILT_IN_BACKEND_PROFILES.map((p) => ({
            label: p.name,
            description: p.description,
            detail: p.baseUrl,
            id: p.id,
          })),
          { title: 'Switch SideCar backend', placeHolder: 'Choose a backend profile' },
        );
        if (!pick) return;
        profile = BUILT_IN_BACKEND_PROFILES.find((p) => p.id === pick.id);
      }
      if (!profile) return;
      const result = await applyBackendProfile(profile);
      if (result.status === 'missing-key') {
        const action = await window.showWarningMessage(result.message, 'Set API Key');
        if (action === 'Set API Key') {
          commands.executeCommand('sidecar.setApiKey');
        }
      } else {
        window.showInformationMessage(result.message);
      }

      if (profile.provider === 'ollama' && isLocalOllama(profile.baseUrl)) {
        const { ensureOllamaRunning } = await import('../config/providerReachability.js');
        void window.withProgress({ location: { viewId: 'sidecar.chatView' }, title: 'Starting Ollama...' }, () =>
          ensureOllamaRunning(profile!.baseUrl),
        );
      }

      const chatProvider = getChatProvider();
      chatProvider?.reloadModels();

      if (chatProvider) {
        try {
          const models = await chatProvider.client.listInstalledModels();
          const cfg = getConfig();
          const hit = models.some(
            (m: { name: string }) => m.name === cfg.model || m.name.split(':')[0] === cfg.model.split(':')[0],
          );
          if (!hit && models.length > 0) {
            const best = models[0].name;
            await workspace.getConfiguration('sidecar').update('model', best, true);
            await chatProvider.setModel(best);
          } else if (!hit && models.length === 0) {
            await workspace.getConfiguration('sidecar').update('model', '', true);
            const providerType = chatProvider.client.getProviderType();
            const hint =
              providerType === 'kickstand'
                ? 'Paste a HuggingFace repo name (e.g. `Qwen/Qwen2.5-0.5B-Instruct-GGUF`) into the model input to pull and load it.'
                : providerType === 'ollama'
                  ? 'Run `ollama pull <model>` from the terminal or paste a model name into the model input.'
                  : 'Enter a model name in the model input to get started.';
            window.showInformationMessage(`SideCar: No models available on ${profile!.name}. ${hint}`);
          }
        } catch {
          // Backend unreachable — loadModels will surface a connection error
        }
      }
    }),
  );

  registerNoSqlMcpCommands(context);
}
