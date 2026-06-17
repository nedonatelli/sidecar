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
        'Returns the project slug for use in subsequent research tool calls. ' +
        'Example: `research_create_project(title="FFT speedup", question="Can a radix-4 FFT beat radix-2 here?")`.',
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
        'Returns the hypothesis ID for linking to experiments. ' +
        'Example: `research_add_hypothesis(project="fft-speedup", hypothesis="Radix-4 cuts multiplies by 25%")`.',
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
      nondeterministicOutput: true,
      description:
        'Record and run an experiment for a research project. ' +
        'Writes experiments/<id>/manifest.yaml, executes the command, and captures the result. ' +
        'The experiment id should be descriptive. ' +
        'Example: `research_log_experiment(project="fft-speedup", id="exp-2026-05-fft-baseline", command="python bench.py")`.',
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

      const projectRecord = await getStore().loadProject(project);
      if (!projectRecord) return `Project \`${project}\` not found.`;

      const manifest: ExperimentManifest = {
        id,
        command,
        parameters: parameters ?? {},
        seed,
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      try {
        await getStore().logExperiment(project, manifest);
      } catch (err) {
        return `Error initializing experiment: ${err instanceof Error ? err.message : String(err)}`;
      }

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

      try {
        await getStore().logExperiment(project, manifest);
      } catch {
        // best-effort update — command already ran, return result regardless
      }

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
        'Use for recording insights, anomalies, decisions, or anything worth preserving across sessions. ' +
        'Example: `research_add_observation(project="fft-speedup", note="radix-4 unstable for N<64")`.',
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
        const projectRecord = await getStore().loadProject(project);
        if (!projectRecord) return `Project \`${project}\` not found.`;
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
        'Update the status of a hypothesis as evidence accumulates in a research project. ' +
        'Use after logging experiments or observations that bear on the hypothesis; not for adding a new hypothesis (use research_add_hypothesis). ' +
        'Valid statuses: open, supported, refuted, needs-more-evidence, abandoned. ' +
        'Example: `research_update_hypothesis_status(project: "fft-speedup", id: "h1", status: "supported")`.',
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
        'Returns project slugs, titles, status, hypothesis count, and last updated time. ' +
        'Use to discover the slug of an existing project before adding hypotheses or experiments. ' +
        'Takes no arguments. Example: `research_list_projects()`.',
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

  // ─── research_set_project_status ─────────────────────────────────────────
  {
    requiresApproval: false,
    definition: {
      name: 'research_set_project_status',
      description:
        'Update the lifecycle status of a research project as the work progresses or winds down. ' +
        'Valid statuses: active, paused, complete, abandoned. ' +
        'Example: `research_set_project_status(project="fft-speedup", status="complete")`.',
      input_schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project slug.' },
          status: {
            type: 'string',
            enum: ['active', 'paused', 'complete', 'abandoned'],
            description: 'New project status.',
          },
        },
        required: ['project', 'status'],
      },
    },
    executor: (async (input: Record<string, unknown>) => {
      const { project, status } = input as {
        project: string;
        status: import('../research/researchStore.js').ProjectStatus;
      };
      const gate = gateEnabled();
      if (gate) return gate;

      try {
        const updated = await getStore().setProjectStatus(project, status);
        if (!updated) return `Project \`${project}\` not found.`;

        return [
          `**Project status updated:**`,
          `- **Slug:** \`${updated.slug}\``,
          `- **Title:** ${updated.title}`,
          `- **Status:** ${updated.status}`,
        ].join('\n');
      } catch (err) {
        return `Error updating project status: ${err instanceof Error ? err.message : String(err)}`;
      }
    }) as ToolExecutor,
  },

  // ─── research_export_report ───────────────────────────────────────────────
  {
    requiresApproval: false,
    definition: {
      name: 'research_export_report',
      description:
        'Generate a structured markdown report for a research project. ' +
        'Includes hypothesis outcomes table, experiment results with output tails, and observations timeline. ' +
        'Writes the report to `.sidecar/research/<slug>/report.md` and returns the full markdown. ' +
        'Example: `research_export_report(project="fft-speedup")`.',
      input_schema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project slug.' },
        },
        required: ['project'],
      },
    },
    executor: (async (input: Record<string, unknown>) => {
      const { project } = input as { project: string };
      const gate = gateEnabled();
      if (gate) return gate;

      try {
        const result = await getStore().generateReport(project);
        if (!result) return `Project \`${project}\` not found.`;

        return [
          `**Report generated** for \`${project}\`:`,
          `- **Saved to:** \`${result.filePath}\``,
          '',
          result.markdown,
        ].join('\n');
      } catch (err) {
        return `Error generating report: ${err instanceof Error ? err.message : String(err)}`;
      }
    }) as ToolExecutor,
  },
];
