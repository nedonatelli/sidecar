import { window, commands, workspace, env, Uri, ExtensionContext } from 'vscode';
import {
  getConfig,
  isLocalOllama,
  setApiKeySecret,
  setHuggingFaceToken,
  clearHuggingFaceToken,
  applyCustomEndpoint,
} from '../config/settings.js';

/** Public skill marketplace — browseable GitHub topic index of `sidecar-skill` repos. */
export const SKILL_MARKETPLACE_URL = 'https://github.com/topics/sidecar-skill';
/** Public MCP marketplace — browseable GitHub topic index of `mcp-server` repos. */
export const MCP_MARKETPLACE_URL = 'https://github.com/topics/mcp-server';
import { registerNoSqlMcpCommands } from './noSqlMcpCommands.js';
import { bedrockRuntimeOrigin } from '../ollama/bedrockBackend.js';
import type { ChatViewProvider } from '../webview/chatView.js';
import type { SkillLoader } from '../agent/skillLoader.js';

/** Common AWS regions where Bedrock + Claude models are available. */
const BEDROCK_REGIONS: { region: string; label: string }[] = [
  { region: 'us-east-1', label: 'us-east-1 — N. Virginia' },
  { region: 'us-east-2', label: 'us-east-2 — Ohio' },
  { region: 'us-west-2', label: 'us-west-2 — Oregon' },
  { region: 'eu-central-1', label: 'eu-central-1 — Frankfurt' },
  { region: 'eu-west-1', label: 'eu-west-1 — Ireland' },
  { region: 'eu-west-3', label: 'eu-west-3 — Paris' },
  { region: 'ap-northeast-1', label: 'ap-northeast-1 — Tokyo' },
  { region: 'ap-southeast-1', label: 'ap-southeast-1 — Singapore' },
  { region: 'ap-southeast-2', label: 'ap-southeast-2 — Sydney' },
  { region: 'ap-south-1', label: 'ap-south-1 — Mumbai' },
  { region: 'us-gov-west-1', label: 'us-gov-west-1 — AWS GovCloud (US-West)' },
  { region: 'us-gov-east-1', label: 'us-gov-east-1 — AWS GovCloud (US-East)' },
];

// AWS region ids: 2-letter group, one or more hyphenated word segments
// (covers GovCloud `us-gov-west-1` and China `cn-north-1`), then a number.
export const AWS_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/**
 * Prompt for the AWS Bedrock region (QuickPick of common regions + a custom
 * entry) and persist it to `sidecar.bedrock.region`. Returns the chosen region,
 * or undefined if cancelled. Shared by the standalone command and the
 * Bedrock profile-switch flow.
 */
export async function promptBedrockRegion(): Promise<string | undefined> {
  const current = getConfig().bedrockRegion;
  const CUSTOM = '__custom__';
  const items = BEDROCK_REGIONS.map((r) => ({
    label: r.label,
    description: r.region === current ? '(current)' : undefined,
    region: r.region,
  }));
  items.push({ label: 'Custom…', description: 'Enter another AWS region', region: CUSTOM });

  const pick = await window.showQuickPick(items, { title: 'Bedrock region', placeHolder: `Current: ${current}` });
  if (!pick) return undefined;

  let region = pick.region;
  if (region === CUSTOM) {
    const typed = await window.showInputBox({
      title: 'Bedrock region',
      prompt: 'AWS region id (e.g. us-east-1)',
      value: current,
      validateInput: (v) =>
        AWS_REGION_RE.test(v.trim()) ? undefined : 'Expected an AWS region like us-east-1 or us-gov-west-1',
    });
    if (!typed) return undefined;
    region = typed.trim();
  }

  // FIPS endpoint — required for some connections (notably AWS GovCloud). Offer
  // it, ordering FIPS first for gov regions where it's typically mandatory.
  const isGov = region.startsWith('us-gov-');
  const standardItem = { label: 'Standard endpoint', fips: false, description: bedrockRuntimeOrigin(region, false) };
  const fipsItem = { label: 'FIPS endpoint', fips: true, description: bedrockRuntimeOrigin(region, true) };
  const endpointPick = await window.showQuickPick(isGov ? [fipsItem, standardItem] : [standardItem, fipsItem], {
    title: 'Bedrock endpoint',
    placeHolder: isGov ? 'GovCloud typically requires FIPS' : 'Use FIPS only if your account/region requires it',
  });
  if (!endpointPick) return undefined;
  const fips = endpointPick.fips;
  const baseUrl = bedrockRuntimeOrigin(region, fips);

  const cfg = workspace.getConfiguration('sidecar');
  await cfg.update('bedrock.region', region, true);
  await cfg.update('bedrock.fips', fips, true);
  // Keep the displayed/used base URL in sync with the chosen region + FIPS, so
  // switching away from us-east-1 (or into GovCloud) updates it correctly.
  await cfg.update('baseUrl', baseUrl, true);
  window.showInformationMessage(`SideCar: Bedrock set to ${region}${fips ? ' (FIPS)' : ''} — ${baseUrl}`);
  return region;
}

/** Returns an error message for an unusable endpoint URL, or undefined when it is fine. */
export function validateEndpointUrl(value: string): string | undefined {
  try {
    const { protocol } = new URL(value.trim());
    if (protocol === 'http:' || protocol === 'https:') return undefined;
  } catch {
    // fall through
  }
  return 'Enter a full http:// or https:// URL, e.g. http://localhost:8000/v1';
}

/**
 * Set up a custom OpenAI-compatible endpoint: prompt for its URL, then its API
 * key, and apply both. An empty key means the server needs none. Cancelling
 * either prompt changes nothing. Returns the applied URL, or undefined.
 */
export async function promptCustomEndpoint(): Promise<string | undefined> {
  const cfg = getConfig();
  const typedUrl = await window.showInputBox({
    title: 'Custom endpoint (1/2): URL',
    prompt: 'Base URL of an OpenAI-compatible server. A trailing /v1 is optional.',
    placeHolder: 'http://localhost:8000/v1',
    value: cfg.provider === 'openai-compat' ? cfg.baseUrl : '',
    ignoreFocusOut: true,
    validateInput: validateEndpointUrl,
  });
  if (typedUrl === undefined) return undefined;
  const baseUrl = typedUrl.trim().replace(/\/+$/, '');

  const typedKey = await window.showInputBox({
    title: 'Custom endpoint (2/2): API key',
    prompt: `API key for ${baseUrl}. Leave empty if the server does not require one.`,
    password: true,
    ignoreFocusOut: true,
  });
  if (typedKey === undefined) return undefined;
  const apiKey = typedKey.trim();

  await applyCustomEndpoint(baseUrl, apiKey);
  window.showInformationMessage(`SideCar: using ${baseUrl} (${apiKey ? 'API key saved' : 'no API key'}).`);
  return baseUrl;
}

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
    commands.registerCommand('sidecar.mcp.openMarketplace', () => {
      void env.openExternal(Uri.parse(MCP_MARKETPLACE_URL));
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
    commands.registerCommand('sidecar.bedrock.setRegion', () => promptBedrockRegion()),
    commands.registerCommand('sidecar.switchBackend', async (profileId?: unknown) => {
      const { BUILT_IN_BACKEND_PROFILES, CUSTOM_ENDPOINT_ENTRY, applyBackendProfile } =
        await import('../config/settings.js');
      let selectedId = typeof profileId === 'string' ? profileId : undefined;
      const isKnownId = (id: string | undefined) =>
        id === CUSTOM_ENDPOINT_ENTRY.id || BUILT_IN_BACKEND_PROFILES.some((p) => p.id === id);
      if (!isKnownId(selectedId)) {
        const pick = await window.showQuickPick(
          [
            ...BUILT_IN_BACKEND_PROFILES.map((p) => ({
              label: p.name,
              description: p.description,
              detail: p.baseUrl,
              id: p.id,
            })),
            {
              label: CUSTOM_ENDPOINT_ENTRY.name,
              description: CUSTOM_ENDPOINT_ENTRY.description,
              detail: 'Enter a URL',
              id: CUSTOM_ENDPOINT_ENTRY.id,
            },
          ],
          { title: 'Switch SideCar backend', placeHolder: 'Choose a backend profile' },
        );
        if (!pick) return;
        selectedId = pick.id;
      }

      // Name of what we switched to, for the no-models hint below.
      let targetName: string;
      if (selectedId === CUSTOM_ENDPOINT_ENTRY.id) {
        const baseUrl = await promptCustomEndpoint();
        if (!baseUrl) return;
        targetName = baseUrl;
      } else {
        const profile = BUILT_IN_BACKEND_PROFILES.find((p) => p.id === selectedId);
        if (!profile) return;
        targetName = profile.name;
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
            ensureOllamaRunning(profile.baseUrl),
          );
        }

        // Bedrock's region isn't part of the profile — offer to pick it right
        // after switching so the whole flow stays in the chat.
        if (profile.provider === 'bedrock') {
          await promptBedrockRegion();
        }
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
            window.showInformationMessage(`SideCar: No models available on ${targetName}. ${hint}`);
          }
        } catch {
          // Backend unreachable — loadModels will surface a connection error
        }
      }
    }),
  );

  registerNoSqlMcpCommands(context);
}
