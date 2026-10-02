import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, workspace, commands } from 'vscode';
import * as settingsMod from '../config/settings.js';
import {
  promptBedrockRegion,
  promptCustomEndpoint,
  registerSettingsCommands,
  validateEndpointUrl,
  AWS_REGION_RE,
} from './settingsCommands.js';

describe('AWS_REGION_RE', () => {
  it('accepts standard and multi-segment regions (GovCloud, China)', () => {
    for (const r of [
      'us-east-1',
      'us-west-2',
      'eu-central-1',
      'ap-southeast-2',
      'us-gov-west-1',
      'us-gov-east-1',
      'cn-north-1',
    ]) {
      expect(AWS_REGION_RE.test(r), r).toBe(true);
    }
  });

  it('rejects malformed regions', () => {
    for (const r of ['', 'us', 'us-east', 'useast1', 'US-EAST-1', 'us-east-']) {
      expect(AWS_REGION_RE.test(r), r).toBe(false);
    }
  });
});

// getConfig() reads many settings; returning the default for every get keeps it
// happy while we capture the `update` call the picker makes.
function stubConfig() {
  const update = vi.fn();
  vi.spyOn(workspace, 'getConfiguration').mockReturnValue({
    get: (_key: string, def?: unknown) => def,
    update,
    has: () => false,
    inspect: () => undefined,
  } as never);
  return update;
}

describe('promptBedrockRegion', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('persists region + FIPS=false and syncs the standard base URL', async () => {
    const update = stubConfig();
    vi.spyOn(window, 'showQuickPick')
      .mockResolvedValueOnce({ label: 'us-west-2 — Oregon', region: 'us-west-2' } as never) // region
      .mockResolvedValueOnce({ label: 'Standard endpoint', fips: false } as never); // endpoint

    const r = await promptBedrockRegion();

    expect(r).toBe('us-west-2');
    expect(update).toHaveBeenCalledWith('bedrock.region', 'us-west-2', true);
    expect(update).toHaveBeenCalledWith('bedrock.fips', false, true);
    // The base URL must follow the chosen region (the reported bug).
    expect(update).toHaveBeenCalledWith('baseUrl', 'https://bedrock-runtime.us-west-2.amazonaws.com', true);
  });

  it('GovCloud + FIPS syncs the -fips gov base URL', async () => {
    const update = stubConfig();
    vi.spyOn(window, 'showQuickPick')
      .mockResolvedValueOnce({ label: 'us-gov-east-1 — GovCloud', region: 'us-gov-east-1' } as never)
      .mockResolvedValueOnce({ label: 'FIPS endpoint', fips: true } as never);

    const r = await promptBedrockRegion();

    expect(r).toBe('us-gov-east-1');
    expect(update).toHaveBeenCalledWith('bedrock.fips', true, true);
    expect(update).toHaveBeenCalledWith('baseUrl', 'https://bedrock-runtime-fips.us-gov-east-1.amazonaws.com', true);
  });

  it('supports a custom region via the input box', async () => {
    const update = stubConfig();
    vi.spyOn(window, 'showQuickPick')
      .mockResolvedValueOnce({ label: 'Custom…', region: '__custom__' } as never)
      .mockResolvedValueOnce({ label: 'Standard endpoint', fips: false } as never);
    vi.spyOn(window, 'showInputBox').mockResolvedValue('eu-north-1' as never);

    const r = await promptBedrockRegion();

    expect(r).toBe('eu-north-1');
    expect(update).toHaveBeenCalledWith('bedrock.region', 'eu-north-1', true);
    expect(update).toHaveBeenCalledWith('baseUrl', 'https://bedrock-runtime.eu-north-1.amazonaws.com', true);
  });

  it('persists nothing when the region pick is cancelled', async () => {
    const update = stubConfig();
    vi.spyOn(window, 'showQuickPick').mockResolvedValue(undefined as never);

    expect(await promptBedrockRegion()).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it('persists nothing when the endpoint pick is cancelled', async () => {
    const update = stubConfig();
    vi.spyOn(window, 'showQuickPick')
      .mockResolvedValueOnce({ label: 'us-west-2', region: 'us-west-2' } as never)
      .mockResolvedValueOnce(undefined as never);

    expect(await promptBedrockRegion()).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('validateEndpointUrl', () => {
  it('accepts http and https URLs, with or without /v1', () => {
    expect(validateEndpointUrl('http://localhost:8000')).toBeUndefined();
    expect(validateEndpointUrl(' https://llm.example.com/v1 ')).toBeUndefined();
  });

  it('rejects non-URLs and non-http schemes', () => {
    expect(validateEndpointUrl('localhost:8000')).toBeDefined();
    expect(validateEndpointUrl('')).toBeDefined();
    expect(validateEndpointUrl('ftp://host')).toBeDefined();
  });
});

describe('promptCustomEndpoint', () => {
  beforeEach(() => vi.restoreAllMocks());

  function stubApply() {
    stubConfig();
    return vi.spyOn(settingsMod, 'applyCustomEndpoint').mockResolvedValue(undefined);
  }

  it('asks for the URL first, then the key, and applies both', async () => {
    const apply = stubApply();
    const input = vi
      .spyOn(window, 'showInputBox')
      .mockResolvedValueOnce('http://gpu-box:8000/v1/' as never)
      .mockResolvedValueOnce('  sk-local  ' as never);

    expect(await promptCustomEndpoint()).toBe('http://gpu-box:8000/v1');

    expect(input.mock.calls[0][0]?.title).toMatch(/URL/);
    expect(input.mock.calls[1][0]?.title).toMatch(/API key/);
    expect(input.mock.calls[1][0]?.password).toBe(true);
    // Trailing slash dropped, key trimmed.
    expect(apply).toHaveBeenCalledWith('http://gpu-box:8000/v1', 'sk-local');
  });

  it('treats an empty key as not required', async () => {
    const apply = stubApply();
    vi.spyOn(window, 'showInputBox')
      .mockResolvedValueOnce('http://localhost:8000' as never)
      .mockResolvedValueOnce('' as never);
    const info = vi.spyOn(window, 'showInformationMessage');

    await promptCustomEndpoint();

    expect(apply).toHaveBeenCalledWith('http://localhost:8000', '');
    expect(String(info.mock.calls[0][0])).toContain('no API key');
  });

  it('changes nothing when the URL prompt is cancelled', async () => {
    const apply = stubApply();
    const input = vi.spyOn(window, 'showInputBox').mockResolvedValueOnce(undefined as never);

    expect(await promptCustomEndpoint()).toBeUndefined();
    expect(input).toHaveBeenCalledTimes(1); // never asked for a key
    expect(apply).not.toHaveBeenCalled();
  });

  it('changes nothing when the key prompt is cancelled (Escape is not "no key")', async () => {
    const apply = stubApply();
    vi.spyOn(window, 'showInputBox')
      .mockResolvedValueOnce('http://localhost:8000' as never)
      .mockResolvedValueOnce(undefined as never);

    expect(await promptCustomEndpoint()).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('sidecar.switchBackend — custom endpoint', () => {
  beforeEach(() => vi.restoreAllMocks());

  function registerAndGetSwitch() {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    vi.spyOn(commands, 'registerCommand').mockImplementation(((id: string, cb: (...args: unknown[]) => unknown) => {
      handlers.set(id, cb);
      return { dispose: () => {} };
    }) as never);
    registerSettingsCommands({ subscriptions: [] } as never, {
      getChatProvider: () => undefined,
      getSkillLoader: () => undefined,
    });
    return handlers.get('sidecar.switchBackend')!;
  }

  it('offers the custom endpoint in the picker and runs the URL → key prompts when chosen', async () => {
    stubConfig();
    const apply = vi.spyOn(settingsMod, 'applyCustomEndpoint').mockResolvedValue(undefined);
    const applyProfile = vi.spyOn(settingsMod, 'applyBackendProfile');
    const pick = vi
      .spyOn(window, 'showQuickPick')
      .mockImplementation((async (items: Array<{ id: string }>) =>
        items.find((i) => i.id === 'custom-endpoint')) as never);
    vi.spyOn(window, 'showInputBox')
      .mockResolvedValueOnce('http://localhost:8000/v1' as never)
      .mockResolvedValueOnce('' as never);

    await registerAndGetSwitch()();

    expect(pick).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith('http://localhost:8000/v1', '');
    expect(applyProfile).not.toHaveBeenCalled();
  });

  it('goes straight to the prompts when the chat menu passes the custom-endpoint id', async () => {
    stubConfig();
    const apply = vi.spyOn(settingsMod, 'applyCustomEndpoint').mockResolvedValue(undefined);
    const pick = vi.spyOn(window, 'showQuickPick');
    vi.spyOn(window, 'showInputBox')
      .mockResolvedValueOnce('https://llm.example.com' as never)
      .mockResolvedValueOnce('sk-1' as never);

    await registerAndGetSwitch()('custom-endpoint');

    expect(pick).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledWith('https://llm.example.com', 'sk-1');
  });
});
