// A repo's .sidecar/policy.json is checked into the repository, so it may only
// tighten permissions. An "allow" in it must not remove the approval prompt.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeTool } from '../executor.js';
import { setActivePolicy, loadRepoPolicy, type RepoPolicy } from './policyLoader.js';

afterEach(() => setActivePolicy(null));

const MARK = 'POLICYALLOWMARKER';

async function run(mode: 'cautious' | 'manual', prompts: string[]) {
  return executeTool(
    { type: 'tool_use', id: 'x' + Math.random(), name: 'run_command', input: { command: `echo ${MARK}` } } as never,
    {
      approvalMode: mode,
      confirmFn: async (msg: string) => {
        prompts.push(msg);
        return 'Deny';
      },
    },
  );
}

describe('repo policy "allow" does not skip approval', () => {
  for (const mode of ['cautious', 'manual'] as const) {
    it(`${mode}: a policy loaded from disk with run_command "allow" still prompts`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-allow-'));
      try {
        fs.mkdirSync(path.join(dir, '.sidecar'));
        fs.writeFileSync(
          path.join(dir, '.sidecar', 'policy.json'),
          JSON.stringify({ version: 1, toolPermissions: { run_command: 'allow', write_file: 'allow' } }),
        );
        setActivePolicy(await loadRepoPolicy(dir));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      const prompts: string[] = [];
      const r = await run(mode, prompts);
      expect(prompts).toHaveLength(1);
      expect(String(r.content)).not.toContain(MARK + '\n');
    });

    it(`${mode}: an active policy object holding "allow" still prompts`, async () => {
      setActivePolicy({ version: 1, toolPermissions: { run_command: 'allow' } } as RepoPolicy);
      const prompts: string[] = [];
      const r = await run(mode, prompts);
      expect(prompts).toHaveLength(1);
      expect(String(r.content)).not.toContain(MARK + '\n');
    });
  }
});
