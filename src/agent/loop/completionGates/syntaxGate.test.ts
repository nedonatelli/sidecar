import { describe, it, expect } from 'vitest';
import { syntaxGate } from './syntaxGate.js';
import type { getConfig } from '../../../config/settings.js';

// maybeInjectSyntaxGate's runtime behavior (parse-check + inject) is covered in
// gate.test.ts; here we pin only the registry wrapper's enable logic — the flag
// combination that decides whether it runs at all.
const cfg = (o: Partial<ReturnType<typeof getConfig>>) => o as ReturnType<typeof getConfig>;

describe('syntaxGate.enabled', () => {
  it('runs when the completion gate is on and its own flag is not disabled', () => {
    expect(syntaxGate.enabled(cfg({}))).toBe(true); // both undefined → !== false → on
    expect(syntaxGate.enabled(cfg({ completionGateEnabled: true, syntaxGateEnabled: true }))).toBe(true);
  });

  it('is off when the completion-gate master is off (preserves scaffold-off)', () => {
    expect(syntaxGate.enabled(cfg({ completionGateEnabled: false }))).toBe(false);
  });

  it('is off when its own flag is explicitly disabled — independent toggle', () => {
    expect(syntaxGate.enabled(cfg({ completionGateEnabled: true, syntaxGateEnabled: false }))).toBe(false);
  });
});
