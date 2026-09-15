import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

// The description is read once when the module is evaluated, so each variant
// needs a fresh import with the env already set.
async function loadDescription(variant?: string): Promise<string> {
  vi.resetModules();
  if (variant === undefined) delete process.env.SIDECAR_EDIT_FILE_DESC;
  else process.env.SIDECAR_EDIT_FILE_DESC = variant;
  const mod = await import('./fs.js');
  return mod.editFileDef.description;
}

describe('edit_file description', () => {
  const original = process.env.SIDECAR_EDIT_FILE_DESC;
  beforeEach(() => {
    delete process.env.SIDECAR_EDIT_FILE_DESC;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SIDECAR_EDIT_FILE_DESC;
    else process.env.SIDECAR_EDIT_FILE_DESC = original;
    vi.resetModules();
  });

  it('ships the legacy wording by default', async () => {
    // The v2 text is a hypothesis about why 43% of runs open with a no-op edit.
    // It stays off until an A/B says it helps.
    const d = await loadDescription();
    expect(d).toContain('repeated verbatim in `replace`');
    expect(d).not.toContain('THE TWO MUST DIFFER');
  });

  it('v2 states the difference requirement before any instruction to repeat', async () => {
    // This ordering IS the intervention. A small model that meets "repeat the
    // anchor verbatim in `replace`" before it meets "they must differ" has a
    // degenerate but obedient move available: replace = search.
    const d = await loadDescription('v2');
    const differsAt = d.indexOf('MUST DIFFER');
    const anchorAt = d.indexOf('anchor PLUS your new code');
    expect(differsAt).toBeGreaterThan(-1);
    expect(anchorAt).toBeGreaterThan(-1);
    expect(differsAt).toBeLessThan(anchorAt);
  });

  it('v2 drops the bare instruction to repeat text verbatim', async () => {
    const d = await loadDescription('v2');
    expect(d).not.toContain('repeated verbatim in `replace`');
    expect(d).not.toContain('REPEAT that anchor');
  });

  it('v2 keeps the anti-deletion guidance, which is a real hazard', async () => {
    // Dropping the anchor from `replace` really does delete it. Removing the
    // warning would trade one failure mode for a worse, silent one.
    const d = await loadDescription('v2');
    expect(d).toMatch(/anything missing from `replace` is deleted/i);
  });

  it('both variants describe the same tool', async () => {
    const legacy = await loadDescription();
    const v2 = await loadDescription('v2');
    expect(v2).not.toBe(legacy);
    for (const must of ['`search`', '`replace`', 'write_file', 'replace_all', '`within`']) {
      expect(v2, `v2 should still mention ${must}`).toContain(must);
    }
  });
});
