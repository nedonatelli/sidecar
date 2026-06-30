import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, workspace } from 'vscode';
import { promptBedrockRegion, AWS_REGION_RE } from './settingsCommands.js';

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
