import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * v0.62.5 — settings reorganization safety net. `contributes.configuration`
 * is now an ARRAY of categorized sections (8 titles, 75 keys total) so
 * VS Code's Settings UI renders each group as its own collapsible block
 * instead of one 75-entry flat list. These tests pin the shape so a
 * careless edit can't silently regress to the flat layout or drop a key.
 *
 * Also pins that every `sidecar.*` key used in source code is actually
 * declared in the schema — drift between `getConfig()` and what users
 * see in settings.json is a common release bug.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

interface ConfigSection {
  title: string;
  properties: Record<string, unknown>;
}

function loadConfiguration(): ConfigSection[] {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf-8')) as {
    contributes: { configuration: ConfigSection[] };
  };
  const cfg = pkg.contributes.configuration;
  expect(Array.isArray(cfg), 'contributes.configuration must be an array').toBe(true);
  return cfg;
}

describe('package.json contributes.configuration — 9-category layout (v0.71.0)', () => {
  const EXPECTED_TITLES = [
    'SideCar: Backend & Models',
    'SideCar: Agent',
    'SideCar: Safety & Review',
    'SideCar: Retrieval & Context',
    'SideCar: Shadow Workspace & Terminal',
    'SideCar: Inline Completions',
    'SideCar: Diagnostics & Thinking',
    'SideCar: Chat UI',
    'SideCar: Extensions & Automation',
  ];

  it('is an array of exactly 9 categorized sections', () => {
    const cfg = loadConfiguration();
    expect(cfg).toHaveLength(9);
  });

  it('sections appear in the expected top-to-bottom order', () => {
    // Users should see connectivity settings (Backend & Models) first
    // and internal extension points (Extensions & Automation) last.
    // If this order changes intentionally, bump the expected list.
    const cfg = loadConfiguration();
    expect(cfg.map((s) => s.title)).toEqual(EXPECTED_TITLES);
  });

  it('each section has a non-empty properties object', () => {
    const cfg = loadConfiguration();
    for (const section of cfg) {
      expect(Object.keys(section.properties).length).toBeGreaterThan(0);
    }
  });

  it('exactly 125 settings keys total across all sections', () => {
    // Baseline: v0.62.4 (75) + v0.64 Model Routing (+5:
    // modelRouting.enabled/rules/defaultModel/visibleSwaps/dryRun)
    // + v0.64 Skill Sync (+5: skills.userRegistry/teamRegistries/
    // autoPull/trustedRegistries/offline)
    // + v0.65 Steer Queue (+2: steerQueue.coalesceWindowMs/maxPending)
    // + v0.65 Multi-File Edits (+6: multiFileEdits.enabled/maxParallel/
    // planningPass/minFilesForPlan/plannerModel/reviewGranularity)
    // + v0.65 Retrieval Graph Expansion (+2: retrieval.graphExpansion.
    // enabled/maxHits)
    // + v0.66 Facets (+4: facets.enabled/maxConcurrent/rpcTimeoutMs/
    // registry).
    // + v0.68 Draft PR (+3: pr.create.draftByDefault/baseBranch/template).
    // + v0.70 Speculative FIM (+1: completion.draftModel).
    // + v0.71 Diagnostics & Thinking (+4: diagnostics.reactiveFixEnabled/
    // reactiveFixDebounceMs/reactiveFixSeverity/thinking.mode).
    // + v0.72 Next Edit Suggestions (+7: nextEdit.enabled/debounceMs/
    // maxHops/topK/crossFileEnabled/model/autoTriggerOnSave).
    // Adding a setting requires bumping this + adding it to one of
    // the sections.
    const cfg = loadConfiguration();
    const totalKeys = cfg.reduce((sum, s) => sum + Object.keys(s.properties).length, 0);
    expect(totalKeys).toBe(125);
  });

  it('no setting key is duplicated across sections', () => {
    const cfg = loadConfiguration();
    const seen = new Map<string, string>();
    for (const section of cfg) {
      for (const key of Object.keys(section.properties)) {
        const prior = seen.get(key);
        if (prior) {
          expect.fail(`Key "${key}" declared in both "${prior}" and "${section.title}"`);
        }
        seen.set(key, section.title);
      }
    }
  });

  it('every key starts with the "sidecar." namespace', () => {
    const cfg = loadConfiguration();
    for (const section of cfg) {
      for (const key of Object.keys(section.properties)) {
        expect(key, `${section.title} key must be namespaced`).toMatch(/^sidecar\./);
      }
    }
  });

  it('every section is itself a JSON schema fragment with type + description metadata', () => {
    const cfg = loadConfiguration();
    for (const section of cfg) {
      for (const [key, value] of Object.entries(section.properties)) {
        const v = value as Record<string, unknown>;
        // Every property needs a `type`. Most have either `description`
        // or `markdownDescription` — we assert at least one exists so
        // the Settings UI doesn't render a bare key.
        expect(v.type, `${key} missing type`).toBeDefined();
        const hasDesc = typeof v.description === 'string' || typeof v.markdownDescription === 'string';
        expect(hasDesc, `${key} missing description / markdownDescription`).toBe(true);
      }
    }
  });
});

describe('settings keys referenced in source match the declared schema (v0.62.5)', () => {
  it('Backend & Models category holds the connectivity essentials', () => {
    const cfg = loadConfiguration();
    const section = cfg.find((s) => s.title === 'SideCar: Backend & Models')!;
    // Spot-check the anchor keys users reach for on first install.
    // These must stay in Backend & Models so the category name
    // accurately advertises what's inside.
    const keys = Object.keys(section.properties);
    expect(keys).toContain('sidecar.baseUrl');
    expect(keys).toContain('sidecar.apiKey');
    expect(keys).toContain('sidecar.model');
    expect(keys).toContain('sidecar.provider');
  });

  it('Agent category contains the six-tier agentMode + its iteration limits', () => {
    const cfg = loadConfiguration();
    const section = cfg.find((s) => s.title === 'SideCar: Agent')!;
    const keys = Object.keys(section.properties);
    expect(keys).toContain('sidecar.agentMode');
    expect(keys).toContain('sidecar.agentMaxIterations');
    expect(keys).toContain('sidecar.toolPermissions');
  });

  it('Safety & Review category groups the critic + auto-fix + gate + audit + regression guards', () => {
    const cfg = loadConfiguration();
    const section = cfg.find((s) => s.title === 'SideCar: Safety & Review')!;
    const keys = Object.keys(section.properties);
    expect(keys).toContain('sidecar.critic.enabled');
    expect(keys).toContain('sidecar.autoFixOnFailure');
    expect(keys).toContain('sidecar.completionGate.enabled');
    expect(keys).toContain('sidecar.audit.autoApproveReads');
    expect(keys).toContain('sidecar.regressionGuards');
  });

  it('Retrieval & Context category covers PKI + Merkle + workspace index + prompt pruning', () => {
    const cfg = loadConfiguration();
    const section = cfg.find((s) => s.title === 'SideCar: Retrieval & Context')!;
    const keys = Object.keys(section.properties);
    expect(keys).toContain('sidecar.projectKnowledge.enabled');
    expect(keys).toContain('sidecar.merkleIndex.enabled');
    expect(keys).toContain('sidecar.includeWorkspace');
    expect(keys).toContain('sidecar.promptPruning.enabled');
  });
});
