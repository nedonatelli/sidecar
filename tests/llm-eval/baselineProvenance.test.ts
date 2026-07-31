import { describe, it, expect } from 'vitest';
import { compareProvenance, currentProvenance, type BaselineProvenance } from './baselineProvenance.js';

// The guard that decides whether a recorded baseline can be compared against
// the current run at all.
//
// It exists because the comparison used to run unconditionally: the recorded
// file carried the model, a timestamp and the extension version, and nothing
// about the conditions the numbers were measured under. So a run under
// scaffold 4.0.0 with thinking on was compared against numbers taken under
// scaffold 3.x with thinking off, and printed a verdict — while
// docs/scaffold-versions.md already said results either side of that boundary
// are not directly comparable.
//
// These tests are the only part of the measurement layer that CI can protect:
// every eval needs a live model, this decision needs nothing.
//
// Mutation-checked, not assumed: removing the scaffold-major comparison fails
// "across a scaffold MAJOR boundary", and removing the thinking comparison
// fails two more. A guard whose firing has not been observed is not known to
// work.

const base = (): BaselineProvenance => ({
  model: 'qwen2.5-coder:7b',
  extensionVersion: '0.122.1',
  thinkingEnabled: true,
  scaffold: {
    version: '4.0.0',
    features: { completionGate: true, critic: false, adaptiveScaffolding: true },
  },
});

const withScaffold = (version: string, features?: Record<string, boolean>): BaselineProvenance => ({
  ...base(),
  scaffold: { version, features: features ?? base().scaffold.features },
});

describe('currentProvenance', () => {
  it('reports thinking on for a model with no known thinking problems', () => {
    expect(currentProvenance('qwen2.5-coder:7b', {}).thinkingEnabled).toBe(true);
  });

  it('reports thinking off for a model the agent loop suppresses it for', () => {
    // The snapshot has to describe what the run ACTUALLY did. Recording
    // `thinking: on` for a model the loop silently suppresses it for would
    // reintroduce the exact mislabelling this guard exists to catch.
    expect(currentProvenance('qwen3:8b', {}).thinkingEnabled).toBe(false);
  });

  it('reports thinking off when the run config disables it', () => {
    // Reads the same field the Ollama backend reads. An earlier version checked
    // the environment variable directly, which is not what the backend consults.
    expect(currentProvenance('qwen2.5-coder:7b', { ollamaDisableThinking: true }).thinkingEnabled).toBe(false);
  });

  it('describes the whole run config, not just the top override layer', () => {
    // The harness layers resolved settings beneath the env overrides. Snapshotting
    // only the top layer reported every underlying flag at a default the run never
    // used — the drift the field comment had claimed was impossible.
    const runConfig = { criticEnabled: true, impactGateEnabled: true, completionGateEnabled: false };
    const p = currentProvenance('qwen2.5-coder:7b', runConfig);
    expect(p.scaffold.features).toMatchObject({ critic: true, impactGate: true, completionGate: false });
  });

  it('reports the scaffold the run was configured with, not the defaults', () => {
    const p = currentProvenance('qwen2.5-coder:7b', { criticEnabled: true, completionGateEnabled: false });
    expect(p.scaffold.features.critic).toBe(true);
    expect(p.scaffold.features.completionGate).toBe(false);
  });
});

describe('compareProvenance', () => {
  it('compares when nothing that matters differs', () => {
    expect(compareProvenance(base(), base())).toEqual({ comparable: true });
  });

  describe('refuses', () => {
    it('across a scaffold MAJOR boundary', () => {
      // The boundary docs/scaffold-versions.md documents but nothing enforced.
      expect(compareProvenance(withScaffold('3.2.0'), withScaffold('4.0.0'))).toEqual({
        comparable: false,
        divergences: [expect.stringMatching(/scaffold major version.*3\.2\.0.*4\.0\.0/)],
      });
    });

    it('when the active scaffold feature set differs', () => {
      // Comparing a gates-on run against a gates-off baseline measures the
      // gates, not the model.
      const recorded = withScaffold('4.0.0', { completionGate: false, critic: false, adaptiveScaffolding: true });
      expect(compareProvenance(recorded, base())).toEqual({
        comparable: false,
        divergences: [expect.stringMatching(/completionGate/)],
      });
    });

    it('when the thinking configuration differs', () => {
      // The dimension that silently invalidated every number on record.
      expect(compareProvenance({ ...base(), thinkingEnabled: false }, base())).toEqual({
        comparable: false,
        divergences: [expect.stringMatching(/thinking/i)],
      });
    });

    it('when the model identifier differs', () => {
      expect(compareProvenance({ ...base(), model: 'qwen2.5-coder:7b-q4' }, base())).toEqual({
        comparable: false,
        divergences: [expect.stringMatching(/model/i)],
      });
    });

    it('when the baseline carries no provenance at all', () => {
      // Every baseline recorded before this guard existed. Must be reported,
      // never thrown on — the upgrade path is a prompt to re-record.
      expect(compareProvenance(undefined, base())).toEqual({
        comparable: false,
        divergences: [expect.stringMatching(/no provenance|predates/i)],
      });
    });

    it('reporting every divergence, not just the first', () => {
      const recorded: BaselineProvenance = {
        model: 'other-model',
        extensionVersion: '0.116.0',
        thinkingEnabled: false,
        scaffold: { version: '3.0.0', features: { completionGate: false, critic: false, adaptiveScaffolding: true } },
      };
      expect(compareProvenance(recorded, base())).toEqual({
        comparable: false,
        divergences: expect.arrayContaining([
          expect.stringMatching(/model/i),
          expect.stringMatching(/thinking/i),
          expect.stringMatching(/scaffold major version/i),
          expect.stringMatching(/completionGate/),
        ]),
      });
    });
  });

  describe('tolerates', () => {
    it('a scaffold MINOR difference', () => {
      // Invalidating on every scaffold tweak would make the guard useless
      // through noise, which is its own silent failure.
      expect(compareProvenance(withScaffold('4.1.0'), withScaffold('4.0.0'))).toEqual({ comparable: true });
    });

    it('a scaffold PATCH difference', () => {
      expect(compareProvenance(withScaffold('4.0.3'), withScaffold('4.0.0'))).toEqual({ comparable: true });
    });

    it('an extension version difference', () => {
      // Releases are frequent and mostly orthogonal to agent behaviour.
      expect(compareProvenance({ ...base(), extensionVersion: '0.116.0' }, base())).toEqual({ comparable: true });
    });

    it('a baseline recorded by this run', () => {
      // The round trip that matters: whatever currentProvenance() reports must
      // compare cleanly against itself, or every freshly recorded baseline is
      // born incomparable.
      const now = currentProvenance('qwen2.5-coder:7b', {});
      expect(compareProvenance(now, now)).toEqual({ comparable: true });
    });

    it('feature keys listed in a different order', () => {
      const reordered: BaselineProvenance = {
        ...base(),
        scaffold: {
          version: '4.0.0',
          features: { adaptiveScaffolding: true, completionGate: true, critic: false },
        },
      };
      expect(compareProvenance(reordered, base())).toEqual({ comparable: true });
    });
  });
});
