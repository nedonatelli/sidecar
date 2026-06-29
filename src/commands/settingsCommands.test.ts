import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, workspace } from 'vscode';
import { promptBedrockRegion, AWS_REGION_RE } from './settingsCommands.js';

describe('AWS_REGION_RE', () => {
  it('accepts standard and multi-segment regions (GovCloud, China)', () => {
    for (const r of ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-southeast-2', 'us-gov-west-1', 'us-gov-east-1', 'cn-north-1']) {
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

  it('persists a picked region to sidecar.bedrock.region', async () => {
    const update = stubConfig();
    vi.spyOn(window, 'showQuickPick').mockResolvedValue({ label: 'us-west-2 — Oregon', region: 'us-west-2' } as never);

    const r = await promptBedrockRegion();

    expect(r).toBe('us-west-2');
    expect(update).toHaveBeenCalledWith('bedrock.region', 'us-west-2', true);
  });

  it('supports a custom region via the input box', async () => {
    const update = stubConfig();
    vi.spyOn(window, 'showQuickPick').mockResolvedValue({ label: 'Custom…', region: '__custom__' } as never);
    vi.spyOn(window, 'showInputBox').mockResolvedValue('eu-north-1' as never);

    const r = await promptBedrockRegion();

    expect(r).toBe('eu-north-1');
    expect(update).toHaveBeenCalledWith('bedrock.region', 'eu-north-1', true);
  });

  it('persists nothing when cancelled', async () => {
    const update = stubConfig();
    vi.spyOn(window, 'showQuickPick').mockResolvedValue(undefined as never);

    const r = await promptBedrockRegion();

    expect(r).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });
});
