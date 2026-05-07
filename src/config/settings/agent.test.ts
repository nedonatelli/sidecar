import { describe, it, expect } from 'vitest';
import { resolveMode, type CustomModeConfig } from './agent.js';

const NO_CUSTOMS: CustomModeConfig[] = [];

describe('resolveMode — built-in modes', () => {
  it.each(['autonomous', 'cautious', 'manual', 'plan', 'review'])(
    'passes %s through as approvalBehavior with empty systemPrompt and toolPermissions',
    (mode) => {
      const result = resolveMode(mode, NO_CUSTOMS);
      expect(result.approvalBehavior).toBe(mode);
      expect(result.systemPrompt).toBe('');
      expect(result.toolPermissions).toEqual({});
      expect(result.isCustom).toBe(false);
    },
  );

  it('maps audit to approvalBehavior:autonomous (not a sixth enum value)', () => {
    const result = resolveMode('audit', NO_CUSTOMS);
    expect(result.approvalBehavior).toBe('autonomous');
    expect(result.isCustom).toBe(false);
  });
});

describe('resolveMode — unknown mode', () => {
  it('falls back to cautious for an unrecognised mode string', () => {
    const result = resolveMode('some-future-mode', NO_CUSTOMS);
    expect(result.approvalBehavior).toBe('cautious');
    expect(result.isCustom).toBe(false);
  });
});

describe('resolveMode — custom modes', () => {
  const customs: CustomModeConfig[] = [
    {
      name: 'safe-reviewer',
      description: 'Read-only review mode',
      systemPrompt: 'Only read files.',
      approvalBehavior: 'cautious',
      toolPermissions: { write_file: 'deny' },
    },
    {
      name: 'no-perms-mode',
      description: 'Custom with no toolPermissions field',
      systemPrompt: 'Custom prompt.',
      approvalBehavior: 'manual',
    },
  ];

  it('resolves a known custom mode by name', () => {
    const result = resolveMode('safe-reviewer', customs);
    expect(result.approvalBehavior).toBe('cautious');
    expect(result.systemPrompt).toBe('Only read files.');
    expect(result.toolPermissions).toEqual({ write_file: 'deny' });
    expect(result.isCustom).toBe(true);
  });

  it('defaults toolPermissions to {} when the custom mode omits the field', () => {
    const result = resolveMode('no-perms-mode', customs);
    expect(result.toolPermissions).toEqual({});
    expect(result.isCustom).toBe(true);
  });

  it('falls back to cautious when the mode name matches no custom entry', () => {
    const result = resolveMode('unknown', customs);
    expect(result.approvalBehavior).toBe('cautious');
    expect(result.isCustom).toBe(false);
  });
});
