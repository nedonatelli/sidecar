import { window, workspace } from 'vscode';
import type { ChatState } from '../chatState.js';
import { getResearchStore } from '../../agent/tools/research.js';
import { getConfig } from '../../config/settings.js';

export function handleSaveSession(state: ChatState, name: string): void {
  state.sessionManager.save(name, state.messages);
  window.showInformationMessage(`Session "${name}" saved.`);
  handleListSessions(state);
}

export function handleLoadSession(state: ChatState, id: string): void {
  const session = state.sessionManager.load(id);
  if (!session) return;
  state.autoSave(); // Save current conversation before switching
  // Abort any in-flight run and cancel its pending flush-timer so stale
  // assistant-message chunks cannot inject into the newly loaded session.
  state.abort();
  state.cancelCallbacks?.();
  state.abortController = null;
  state.cancelCallbacks = null;
  // Bump the generation so the chatGeneration guard in handleUserMessage
  // fires if the aborted loop completes its final turn before the abort
  // signal propagates through the stream (the loop would return normally
  // and call postLoopProcessing, overwriting the just-loaded session).
  state.chatGeneration++;
  // Tear down the steer listener immediately so an onChange callback can't
  // fire steerEnabled:true into the newly-loaded session before the aborted
  // loop's finally block runs (that block would also clean up, but it runs
  // asynchronously after the next await in the loop).
  state.currentSteerDisposer?.();
  state.currentSteerDisposer = null;
  state.currentSteerQueue = null;
  state.postMessage({ command: 'steerQueueUpdate', steerQueue: [], steerEnabled: false });
  state.messages = session.messages;
  state.currentSessionId = session.id;
  state.saveHistory();
  state.postMessage({ command: 'chatCleared' });
  state.postMessage({ command: 'init', messages: state.messages });
}

export function handleDeleteSession(state: ChatState, id: string): void {
  state.sessionManager.delete(id);
  handleListSessions(state);
}

export function handleListSessions(state: ChatState): void {
  const sessions = state.sessionManager.list();
  const data = sessions.map((s) => ({
    id: s.id,
    name: s.name,
    createdAt: s.createdAt,
    parentId: s.parentId,
  }));
  state.postMessage({ command: 'sessionList', content: JSON.stringify(data) });
}

export async function handleBranchSession(state: ChatState, branchName?: string): Promise<void> {
  const name =
    branchName?.trim() ||
    (await window.showInputBox({
      prompt: 'Name for this branch',
      placeHolder: 'e.g. "try-different-approach"',
      value: state.currentSessionId
        ? `${state.sessionManager.load(state.currentSessionId)?.name ?? 'Branch'} (alt)`
        : 'Branch',
    }));
  if (!name?.trim()) return;

  // Auto-save current state before branching so neither thread loses progress.
  state.autoSave();

  const parentId = state.currentSessionId;
  if (!parentId) {
    // No saved session yet — save first, then branch from it.
    const parent = state.sessionManager.save(name.trim() + ' (original)', state.messages);
    const child = state.sessionManager.branch(parent.id, name.trim(), state.messages);
    state.currentSessionId = child.id;
  } else {
    const child = state.sessionManager.branch(parentId, name.trim(), state.messages);
    state.currentSessionId = child.id;
  }

  state.postMessage({
    command: 'threadSwitched',
    content: `Branched: **${name.trim()}**. Continuing in new branch — the original thread is preserved in Sessions.`,
  });
  handleListSessions(state);
}

/**
 * /research — slash command for quick research interactions.
 *
 * /research observe <note>  — log an observation to the active project without LLM.
 * /research                 — QuickPick to set the active project.
 */
export async function handleResearchCommand(state: ChatState, args?: string): Promise<void> {
  const store = getResearchStore();
  if (!store) {
    state.postMessage({
      command: 'assistantMessage',
      content: 'Research is disabled. Set `sidecar.research.enabled: true` to enable it.',
    });
    state.postMessage({ command: 'done' });
    return;
  }

  // /research report — generate and display the full project report
  if (args?.trim().toLowerCase() === 'report') {
    const activeSlug =
      getConfig().researchActiveProject ||
      workspace.getConfiguration('sidecar').get<string>('research.activeProject', '');

    if (!activeSlug) {
      state.postMessage({
        command: 'assistantMessage',
        content: 'No active research project set. Use `/research` to pick one.',
      });
      state.postMessage({ command: 'done' });
      return;
    }

    try {
      const result = await store.generateReport(activeSlug);
      if (!result) {
        state.postMessage({
          command: 'assistantMessage',
          content: `Project \`${activeSlug}\` not found.`,
        });
      } else {
        state.postMessage({
          command: 'assistantMessage',
          content: [`**Report saved to** \`${result.filePath}\``, '', result.markdown].join('\n'),
        });
      }
    } catch (err) {
      state.postMessage({
        command: 'assistantMessage',
        content: `Error generating report: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    state.postMessage({ command: 'done' });
    return;
  }

  // /research status — print a summary of the active project
  if (args?.trim().toLowerCase() === 'status') {
    const activeSlug =
      getConfig().researchActiveProject ||
      workspace.getConfiguration('sidecar').get<string>('research.activeProject', '');

    if (!activeSlug) {
      state.postMessage({
        command: 'assistantMessage',
        content: 'No active research project set. Use `/research` to pick one.',
      });
      state.postMessage({ command: 'done' });
      return;
    }

    const project = await store.loadProject(activeSlug);
    if (!project) {
      state.postMessage({
        command: 'assistantMessage',
        content: `Project \`${activeSlug}\` not found.`,
      });
      state.postMessage({ command: 'done' });
      return;
    }

    const hypoLines = project.hypotheses.length
      ? project.hypotheses.map((h) => `  - \`${h.id}\` ${h.text} — **${h.status}**`)
      : ['  *(none)*'];

    const [experiments, observations] = await Promise.all([
      store.listExperiments(activeSlug),
      store.listObservations(activeSlug),
    ]);

    state.postMessage({
      command: 'assistantMessage',
      content: [
        `## ${project.title} (\`${project.slug}\`)`,
        `**Status:** ${project.status} · **Question:** ${project.question}`,
        '',
        `### Hypotheses (${project.hypotheses.length})`,
        ...hypoLines,
        '',
        `### Experiments (${experiments.length})`,
        experiments.length
          ? experiments
              .slice(0, 5)
              .map((e) => `  - \`${e.id}\` — ${e.status}`)
              .join('\n')
          : '  *(none)*',
        '',
        `### Observations (${observations.length})`,
        observations.length
          ? observations
              .slice(0, 3)
              .map((o) => `  - ${new Date(o.timestamp).toLocaleString()} — ${o.note.slice(0, 80).replace(/\n/g, ' ')}`)
              .join('\n')
          : '  *(none)*',
      ].join('\n'),
    });
    state.postMessage({ command: 'done' });
    return;
  }

  // /research observe <note>
  const observeMatch = args?.match(/^observe\s+(.+)/is);
  if (observeMatch) {
    const note = observeMatch[1].trim();
    const activeSlug =
      getConfig().researchActiveProject ||
      workspace.getConfiguration('sidecar').get<string>('research.activeProject', '');

    if (!activeSlug) {
      state.postMessage({
        command: 'assistantMessage',
        content:
          'No active research project set. Use `/research` to pick one, or set `sidecar.research.activeProject` in settings.',
      });
      state.postMessage({ command: 'done' });
      return;
    }

    try {
      const obs = await store.addObservation(activeSlug, note);
      state.postMessage({
        command: 'assistantMessage',
        content: [
          `**Observation recorded** in \`${activeSlug}\`:`,
          `- **Time:** ${new Date(obs.timestamp).toLocaleString()}`,
          '',
          obs.note,
        ].join('\n'),
      });
    } catch (err) {
      state.postMessage({
        command: 'assistantMessage',
        content: `Error recording observation: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    state.postMessage({ command: 'done' });
    return;
  }

  // /research — QuickPick to set active project
  const projects = await store.listProjects();
  if (projects.length === 0) {
    state.postMessage({
      command: 'assistantMessage',
      content: 'No research projects found. Ask the agent to `research_create_project` to start one.',
    });
    state.postMessage({ command: 'done' });
    return;
  }

  const items = projects.map((p) => ({
    label: p.title,
    description: `${p.slug} · ${p.status} · ${p.hypotheses.length} hypotheses`,
    slug: p.slug,
  }));

  const picked = await window.showQuickPick(items, {
    title: 'Set Active Research Project',
    placeHolder: 'Select a project to make active',
  });

  if (!picked) {
    state.postMessage({ command: 'done' });
    return;
  }

  await workspace.getConfiguration('sidecar').update('research.activeProject', picked.slug, true);
  state.postMessage({
    command: 'assistantMessage',
    content: `Active research project set to **${picked.label}** (\`${picked.slug}\`).`,
  });
  state.postMessage({ command: 'done' });
}
