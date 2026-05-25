import type { RegisteredTool, ToolExecutor, ToolExecutorContext } from './shared.js';
import { getDefaultToolRuntime } from './runtime.js';
import type { ResearchStore, ExperimentManifest } from '../research/researchStore.js';

let _store: ResearchStore | null = null;

/** Called once during activation to wire the store into tool executors. */
export function setResearchStore(store: ResearchStore): void {
  _store = store;
}

function getStore(): ResearchStore {
  if (!_store) throw new Error('Research store not initialized. Enable sidecar.research.enabled.');
  return _store;
}

export function getResearchStore(): ResearchStore | null {
  return _store;
}

function gateEnabled(): string | null {
  if (!_store) return 'Research tools are disabled. Set `sidecar.research.enabled: true` in settings.';
  return null;
}

export const researchTools: RegisteredTool[] = [
  // ─── research_create_project ─────────────────────────────────────────────
  {
    requiresApproval: false,
    definition: {
      name: 'research_create_project',
      description:
        'Create a new research project under `.sidecar/research/<slug>/`. ' +
        'Initialises project.yaml with the title, research question, empty hypotheses list, and status "active". ' +
        'Returns the project slug for use in subsequent research tool calls.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short project title (used to derive the directory slug).' },
          question: { type: 'string', description: 'The central research question this project addresses.' },
        },
        required: ['title', 'question'],
      },
    },
    executor: (async (input: Record<string, unknown>) => {
      const { title, question } = input as { title: string; question: string };
      const gate = gateEnabled();
      if (gate) return gate;

      try {
        const project = await getStore().createProject(title, question);
        return [
          `**Research project created:** \`${project.slug}\``,
          `- **Title:** ${project.title}`,
          `- **Question:** ${project.question}`,
          `- **Location:** \`.sidecar/research/${project.slug}/\``,
          '',
          `Use \`research_add_hypothesis(project: "${project.slug}", ...)\` to add hypotheses.`,
        ].join('\n');
      } catch (err) {
        return `Error creating project: ${err instanceof Error ? err.message : String(err)}`;
      }
    }) as ToolExecutor,
  },

  // ─── research_add_hypothesis ─────────────────────────────────────────────
  {
    requiresApproval: false,
    definition: {
      name: 'research_add_hypothesis',
      description:
        'Add a hypothesis to an existing research project. ' +
        'Appends to the hypotheses array in project.yaml with status "open". ' +
        'Returns the hypothesis ID for linking to experiments.',
      input_schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project slug (returned by research_create_project).' },
          hypothesis: { type: 'string', description: 'The hypothesis statement to add.' },
        },
        required: ['project', 'hypothesis'],
      },
    },
    executor: (async (input: Record<string, unknown>) => {
      const { project, hypothesis } = input as { project: string; hypothesis: string };
      const gate = gateEnabled();
      if (gate) return gate;

      try {
        const hypo = await getStore().addHypothesis(project, hypothesis);
        if (!hypo) return `Project \`${project}\` not found.`;

        return [
          `**Hypothesis added** to \`${input.project}\`:`,
          `- **ID:** \`${hypo.id}\``,
          `- **Text:** ${hypo.text}`,
          `- **Status:** ${hypo.status}`,
        ].join('\n');
      } catch (err) {
        return `Error adding hypothesis: ${err instanceof Error ? err.message : String(err)}`;
      }
    }) as ToolExecutor,
  },

  // ─── research_log_experiment ─────────────────────────────────────────────
  {
    requiresApproval: true,
    definition: {
      name: 'research_log_experiment',
      description:
        'Record and run an experiment for a research project. ' +
        'Writes experiments/<id>/manifest.yaml, executes the command, and captures the result. ' +
        'The experiment id should be descriptive, e.g. "exp-2026-05-fft-baseline".',
      input_schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project slug.' },
          id: { type: 'string', description: 'Unique experiment identifier.' },
          command: { type: 'string', description: 'Shell command to run the experiment.' },
          parameters: {
            type: 'object',
            description: 'Key/value parameters for reproducibility (logged to manifest, not passed to command).',
            additionalProperties: true,
          },
          seed: { type: 'number', description: 'Random seed for reproducibility.' },
        },
        required: ['project', 'id', 'command'],
      },
    },
    executor: (async (input: Record<string, unknown>, context?: ToolExecutorContext) => {
      const { project, id, command, parameters, seed } = input as {
        project: string;
        id: string;
        command: string;
        parameters?: Record<string, unknown>;
        seed?: number;
      };
      const gate = gateEnabled();
      if (gate) return gate;

      const manifest: ExperimentManifest = {
        id,
        command,
        parameters: parameters ?? {},
        seed,
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await getStore().logExperiment(project, manifest);

      let exitCode: number | undefined;
      let outputTail = '';

      try {
        const runtime = getDefaultToolRuntime();
        const shell = runtime.getShellSession();
        const result = await shell.execute(command, { signal: context?.signal });
        exitCode = result.exitCode ?? 0;
        const lines = result.stdout.split('\n');
        outputTail = lines.slice(-30).join('\n');
      } catch (err) {
        exitCode = 1;
        outputTail = err instanceof Error ? err.message : String(err);
      }

      manifest.status = exitCode === 0 ? 'complete' : 'abandoned';
      manifest.exitCode = exitCode;
      manifest.outputTail = outputTail.slice(0, 2000);
      manifest.updatedAt = Date.now();

      await getStore().logExperiment(project, manifest);

      return [
        `**Experiment \`${id}\`** — ${manifest.status}`,
        `- **Command:** \`${command}\``,
        `- **Exit code:** ${exitCode}`,
        '',
        '**Output (last 30 lines):**',
        '```',
        outputTail || '(no output)',
        '```',
        '',
        `Manifest saved to \`.sidecar/research/${project}/experiments/${id}/manifest.yaml\``,
      ].join('\n');
    }) as ToolExecutor,
  },

  // ─── research_add_observation ─────────────────────────────────────────────
  {
    requiresApproval: false,
    definition: {
      name: 'research_add_observation',
      description:
        'Append a timestamped observation note to a research project. ' +
        'Saved to observations/<timestamp>.md. ' +
        'Use for recording insights, anomalies, decisions, or anything worth preserving across sessions.',
      input_schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project slug.' },
          note: { type: 'string', description: 'The observation text to record.' },
        },
        required: ['project', 'note'],
      },
    },
    executor: (async (input: Record<string, unknown>) => {
      const { project, note } = input as { project: string; note: string };
      const gate = gateEnabled();
      if (gate) return gate;

      try {
        const obs = await getStore().addObservation(project, note);
        return [
          `**Observation recorded** in \`${input.project}\`:`,
          `- **Timestamp:** ${new Date(obs.timestamp).toISOString()}`,
          `- **File:** \`${obs.filePath}\``,
          '',
          obs.note,
        ].join('\n');
      } catch (err) {
        return `Error recording observation: ${err instanceof Error ? err.message : String(err)}`;
      }
    }) as ToolExecutor,
  },

  // ─── research_update_hypothesis_status ───────────────────────────────────
  {
    requiresApproval: false,
    definition: {
      name: 'research_update_hypothesis_status',
      description:
        'Update the status of a hypothesis in a research project. ' +
        'Valid statuses: open, supported, refuted, needs-more-evidence, abandoned.',
      input_schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project slug.' },
          id: { type: 'string', description: 'Hypothesis ID (returned by research_add_hypothesis).' },
          status: {
            type: 'string',
            enum: ['open', 'supported', 'refuted', 'needs-more-evidence', 'abandoned'],
            description: 'New status for the hypothesis.',
          },
        },
        required: ['project', 'id', 'status'],
      },
    },
    executor: (async (input: Record<string, unknown>) => {
      const { project, id, status } = input as {
        project: string;
        id: string;
        status: import('../research/researchStore.js').HypothesisStatus;
      };
      const gate = gateEnabled();
      if (gate) return gate;

      try {
        const hypo = await getStore().updateHypothesisStatus(project, id, status);
        if (!hypo) return `Hypothesis \`${id}\` not found in project \`${project}\`.`;

        return [
          `**Hypothesis updated** in \`${project}\`:`,
          `- **ID:** \`${hypo.id}\``,
          `- **Text:** ${hypo.text}`,
          `- **Status:** ${hypo.status}`,
        ].join('\n');
      } catch (err) {
        return `Error updating hypothesis: ${err instanceof Error ? err.message : String(err)}`;
      }
    }) as ToolExecutor,
  },

  // ─── research_list_projects ───────────────────────────────────────────────
  {
    requiresApproval: false,
    definition: {
      name: 'research_list_projects',
      description:
        'List all research projects and their summary stats. ' +
        'Returns project slugs, titles, status, hypothesis count, and last updated time.',
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    executor: (async (_input: Record<string, unknown>) => {
      const gate = gateEnabled();
      if (gate) return gate;

      try {
        const projects = await getStore().listProjects();
        if (projects.length === 0) {
          return 'No research projects found. Use `research_create_project` to create one.';
        }

        const lines = projects.map((p) => {
          const age = Math.round((Date.now() - p.updatedAt) / 60_000);
          const ageStr =
            age < 60 ? `${age}m ago` : age < 1440 ? `${Math.round(age / 60)}h ago` : `${Math.round(age / 1440)}d ago`;
          return `- **${p.title}** (\`${p.slug}\`) — ${p.status} · ${p.hypotheses.length} hypotheses · updated ${ageStr}`;
        });

        return [`**Research projects (${projects.length}):**`, '', ...lines].join('\n');
      } catch (err) {
        return `Error listing projects: ${err instanceof Error ? err.message : String(err)}`;
      }
    }) as ToolExecutor,
  },
];
