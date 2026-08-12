import * as path from 'path';
import { SkillLoader, renderActiveSkillSection } from '../../src/agent/skillLoader.js';
import { LOCAL_MAX_SYSTEM_CHARS } from '../../src/config/constants.js';

// Skills are a system-prompt input the product injects (a matched playbook) but
// the eval harnesses previously never loaded — a divergence. This loads SideCar's
// skills once (built-in defaults + user + project, exactly as production's
// SkillLoader.initialize does) and renders the matched skill identically, so a
// task that triggers a skill gets the same guidance a real user would.
let loaderPromise: Promise<SkillLoader> | null = null;

export function evalSkillLoader(): Promise<SkillLoader> {
  if (!loaderPromise) {
    loaderPromise = (async () => {
      const loader = new SkillLoader();
      loader.setBuiltinPath(path.resolve('skills'));
      await loader.initialize();
      return loader;
    })();
  }
  return loaderPromise;
}

/** The `## Active Skill` section for the task text, or '' when none matches — to
 *  append to the base system prompt, matching what injectSystemContext does,
 *  including its size gate (skip a skill that would overflow the system-prompt
 *  budget, which would drown a small local model). */
export function skillSectionFor(loader: SkillLoader, text: string, currentPromptChars = 0): string {
  if (!loader.isReady() || !text) return '';
  const skill = loader.match(text);
  if (!skill || currentPromptChars + skill.content.length >= LOCAL_MAX_SYSTEM_CHARS) return '';
  return renderActiveSkillSection(skill);
}
