// ---------------------------------------------------------------------------
// Skills Picker — searchable QuickPick replacing slash-command-from-memory.
//
// Shows all loaded skills tagged by registry origin with tool-allowlist
// chips and Skills 2.0 restriction badges. Supports two selection modes:
//
//   Replace (default) — the picked skill becomes the active skill for the
//     next agent run; any previously stacked skill is cleared.
//
//   Stack — the picked skill is appended to an existing stack, letting the
//     user compose multiple skills for a single run (e.g. /review-code +
//     /security-reviewer).
//
// The picker returns the slash commands to inject (e.g. ["/review-code"]),
// which the caller pastes into the chat input or dispatches directly.
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import type { Skill, SkillLoader } from '../agent/skillLoader.js';

export type PickerMode = 'replace' | 'stack';

export interface SkillPickerResult {
  skills: Skill[];
  mode: PickerMode;
}

// Source label shown as a tag in the detail line.
const SOURCE_LABELS: Record<Skill['source'], string> = {
  builtin: '$(home) built-in',
  user: '$(person) user',
  'project-claude': '$(folder) project',
  'project-sidecar': '$(folder) project',
  'user-registry': '$(cloud) user registry',
  'team-registry': '$(organization) team registry',
};

function buildDetail(skill: Skill): string {
  const parts: string[] = [];

  const src = SOURCE_LABELS[skill.source] ?? skill.source;
  const label = skill.registrySlug ? `${src}: ${skill.registrySlug}` : src;
  parts.push(label);

  if (skill.allowedTools && skill.allowedTools.length > 0) {
    const chips = skill.allowedTools.slice(0, 4).join(', ');
    const more = skill.allowedTools.length > 4 ? ` +${skill.allowedTools.length - 4}` : '';
    parts.push(`$(tools) ${chips}${more}`);
  }

  if (skill.preferredModel) {
    parts.push(`$(symbol-namespace) ${skill.preferredModel}`);
  }

  if (skill.maxIterations) {
    parts.push(`$(iterations) max ${skill.maxIterations} iter`);
  }

  if (skill.guards && skill.guards.length > 0) {
    parts.push(`$(shield) guards: ${skill.guards.join(', ')}`);
  }

  return parts.join('   ');
}

function isRestricted(skill: Skill): boolean {
  return !!(
    (skill.allowedTools && skill.allowedTools.length > 0) ||
    skill.preferredModel ||
    skill.maxIterations ||
    skill.disableModelInvocation ||
    (skill.guards && skill.guards.length > 0)
  );
}

interface SkillQuickPickItem extends vscode.QuickPickItem {
  skill: Skill;
}

/**
 * Open the Skills Picker and return the user's selection, or `null` if
 * cancelled. Each selected skill's id maps directly to a slash command
 * (e.g. skill.id === "review-code" → "/review-code").
 */
export async function openSkillPicker(
  skillLoader: SkillLoader,
  opts: { mode?: PickerMode; placeholder?: string } = {},
): Promise<SkillPickerResult | null> {
  const allSkills = skillLoader.getAll();

  if (allSkills.length === 0) {
    void vscode.window.showInformationMessage(
      'No skills loaded. Add skills to ~/.claude/commands/, .sidecar/skills/, or configure sidecar.skills.userRegistry.',
    );
    return null;
  }

  // Group: registry skills first (team → user → project → builtin)
  const order: Skill['source'][] = [
    'team-registry',
    'user-registry',
    'project-sidecar',
    'project-claude',
    'user',
    'builtin',
  ];
  const sorted = [...allSkills].sort((a, b) => {
    const ai = order.indexOf(a.source);
    const bi = order.indexOf(b.source);
    if (ai !== bi) return ai - bi;
    return a.id.localeCompare(b.id);
  });

  const items: SkillQuickPickItem[] = sorted.map((skill) => ({
    label: `${isRestricted(skill) ? '$(shield) ' : ''}/${skill.id}`,
    description: skill.description || '',
    detail: buildDetail(skill),
    skill,
  }));

  const qp = vscode.window.createQuickPick<SkillQuickPickItem>();
  qp.items = items;
  qp.placeholder = opts.placeholder ?? 'Pick a skill — type to search by name or description';
  qp.matchOnDescription = true;
  qp.matchOnDetail = false;
  qp.canSelectMany = opts.mode === 'stack';
  qp.title = opts.mode === 'stack' ? 'Stack Skills (select multiple)' : 'Pick Skill';

  const result = await new Promise<SkillPickerResult | null>((resolve) => {
    let settled = false;
    const settle = (value: SkillPickerResult | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    qp.onDidAccept(() => {
      const selected = qp.canSelectMany ? [...qp.selectedItems] : qp.activeItems.length > 0 ? [qp.activeItems[0]] : [];
      qp.hide();
      settle(selected.length === 0 ? null : { skills: selected.map((i) => i.skill), mode: opts.mode ?? 'replace' });
    });
    qp.onDidHide(() => settle(null));
    qp.show();
  });

  qp.dispose();
  return result;
}

/**
 * Command handler for `sidecar.skills.pick`. Opens the picker and, on
 * selection, sends the chosen skill(s) as a chat message through the
 * provided callback.
 */
export async function runSkillPickerCommand(
  skillLoader: SkillLoader,
  sendToChat: (text: string) => void,
  stackMode = false,
): Promise<void> {
  const result = await openSkillPicker(skillLoader, {
    mode: stackMode ? 'stack' : 'replace',
  });
  if (!result) return;

  const text = result.skills.map((s) => `/${s.id}`).join(' ');
  sendToChat(text);
}
