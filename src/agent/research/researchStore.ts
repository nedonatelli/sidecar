import { workspace, Uri } from 'vscode';
import type { SidecarDir } from '../../config/sidecarDir.js';

export type HypothesisStatus = 'open' | 'supported' | 'refuted' | 'needs-more-evidence' | 'abandoned';
export type ProjectStatus = 'active' | 'paused' | 'complete' | 'abandoned';
export type ExperimentStatus = 'planning' | 'running' | 'complete' | 'abandoned';

export interface Hypothesis {
  id: string;
  text: string;
  status: HypothesisStatus;
  addedAt: number;
}

export interface ResearchProject {
  slug: string;
  title: string;
  question: string;
  status: ProjectStatus;
  hypotheses: Hypothesis[];
  createdAt: number;
  updatedAt: number;
}

export interface ExperimentManifest {
  id: string;
  command: string;
  parameters: Record<string, unknown>;
  seed?: number;
  status: ExperimentStatus;
  interpretation?: string;
  exitCode?: number;
  outputTail?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ObservationEntry {
  timestamp: number;
  note: string;
  filePath: string;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function hypoId(): string {
  return `h-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export class ResearchStore {
  constructor(private readonly sidecarDir: SidecarDir) {}

  async createProject(title: string, question: string): Promise<ResearchProject> {
    const slug = slugify(title) || `project-${Date.now()}`;
    const project: ResearchProject = {
      slug,
      title,
      question,
      status: 'active',
      hypotheses: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.writeProject(project);
    return project;
  }

  async loadProject(slug: string): Promise<ResearchProject | null> {
    return this.sidecarDir.readJson<ResearchProject>(`research/${slug}/project.yaml`);
  }

  async listProjects(): Promise<ResearchProject[]> {
    const researchPath = this.sidecarDir.getPath('research');
    const dirUri = Uri.file(researchPath);
    const projects: ResearchProject[] = [];

    try {
      const entries = await workspace.fs.readDirectory(dirUri);
      for (const [name, type] of entries) {
        if (type !== 2) continue; // directories only
        const project = await this.loadProject(name);
        if (project) projects.push(project);
      }
    } catch {
      // research dir doesn't exist yet
    }

    return projects.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async addHypothesis(slug: string, text: string): Promise<Hypothesis | null> {
    const project = await this.loadProject(slug);
    if (!project) return null;

    const hypothesis: Hypothesis = {
      id: hypoId(),
      text,
      status: 'open',
      addedAt: Date.now(),
    };

    project.hypotheses.push(hypothesis);
    project.updatedAt = Date.now();
    await this.writeProject(project);
    return hypothesis;
  }

  async setProjectStatus(slug: string, status: ProjectStatus): Promise<ResearchProject | null> {
    const project = await this.loadProject(slug);
    if (!project) return null;

    project.status = status;
    project.updatedAt = Date.now();
    await this.writeProject(project);
    return project;
  }

  async updateHypothesisStatus(slug: string, id: string, status: HypothesisStatus): Promise<Hypothesis | null> {
    const project = await this.loadProject(slug);
    if (!project) return null;

    const hypo = project.hypotheses.find((h) => h.id === id);
    if (!hypo) return null;

    hypo.status = status;
    project.updatedAt = Date.now();
    await this.writeProject(project);
    return hypo;
  }

  async logExperiment(slug: string, manifest: ExperimentManifest): Promise<void> {
    await this.sidecarDir.writeJson(`research/${slug}/experiments/${manifest.id}/manifest.yaml`, manifest);
    const project = await this.loadProject(slug);
    if (project) {
      project.updatedAt = Date.now();
      await this.writeProject(project);
    }
  }

  async loadExperiment(slug: string, id: string): Promise<ExperimentManifest | null> {
    return this.sidecarDir.readJson<ExperimentManifest>(`research/${slug}/experiments/${id}/manifest.yaml`);
  }

  async listExperiments(slug: string): Promise<ExperimentManifest[]> {
    const expPath = this.sidecarDir.getPath('research', slug, 'experiments');
    const dirUri = Uri.file(expPath);
    const experiments: ExperimentManifest[] = [];

    try {
      const entries = await workspace.fs.readDirectory(dirUri);
      for (const [name, type] of entries) {
        if (type !== 2) continue;
        const manifest = await this.loadExperiment(slug, name);
        if (manifest) experiments.push(manifest);
      }
    } catch {
      // no experiments yet
    }

    return experiments.sort((a, b) => b.createdAt - a.createdAt);
  }

  async addObservation(slug: string, note: string): Promise<ObservationEntry> {
    const timestamp = Date.now();
    const filename = `${timestamp}.md`;
    const content = `# Observation — ${new Date(timestamp).toISOString()}\n\n${note}\n`;
    await this.sidecarDir.writeText(`research/${slug}/observations/${filename}`, content);

    const project = await this.loadProject(slug);
    if (project) {
      project.updatedAt = Date.now();
      await this.writeProject(project);
    }

    return {
      timestamp,
      note,
      filePath: this.sidecarDir.getPath('research', slug, 'observations', filename),
    };
  }

  async listObservations(slug: string): Promise<ObservationEntry[]> {
    const obsPath = this.sidecarDir.getPath('research', slug, 'observations');
    const dirUri = Uri.file(obsPath);
    const entries: ObservationEntry[] = [];

    try {
      const files = await workspace.fs.readDirectory(dirUri);
      for (const [name, type] of files) {
        if (type !== 1 || !name.endsWith('.md')) continue;
        const timestamp = parseInt(name.replace('.md', ''), 10);
        if (isNaN(timestamp)) continue;
        const filePath = this.sidecarDir.getPath('research', slug, 'observations', name);
        try {
          const bytes = await workspace.fs.readFile(Uri.file(filePath));
          const text = Buffer.from(bytes).toString('utf-8');
          // Extract note body (skip the heading line)
          const note = text.split('\n').slice(2).join('\n').trim();
          entries.push({ timestamp, note, filePath });
        } catch {
          // skip unreadable
        }
      }
    } catch {
      // no observations yet
    }

    return entries.sort((a, b) => b.timestamp - a.timestamp);
  }

  getExperimentPath(slug: string, id: string): string {
    return this.sidecarDir.getPath('research', slug, 'experiments', id, 'manifest.yaml');
  }

  getObservationPath(slug: string, filename: string): string {
    return this.sidecarDir.getPath('research', slug, 'observations', filename);
  }

  async generateReport(slug: string): Promise<{ markdown: string; filePath: string } | null> {
    const project = await this.loadProject(slug);
    if (!project) return null;

    const [experiments, observations] = await Promise.all([this.listExperiments(slug), this.listObservations(slug)]);

    const generated = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const lines: string[] = [];

    lines.push(`# Research Report: ${project.title}`);
    lines.push('');
    lines.push(`**Question:** ${project.question}`);
    lines.push(`**Status:** ${project.status}  `);
    lines.push(`**Generated:** ${generated}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // Hypotheses
    lines.push('## Hypotheses');
    lines.push('');
    if (project.hypotheses.length === 0) {
      lines.push('*No hypotheses recorded.*');
    } else {
      lines.push('| ID | Hypothesis | Status |');
      lines.push('|----|-----------|--------|');
      for (const h of project.hypotheses) {
        lines.push(`| \`${h.id}\` | ${h.text} | ${h.status} |`);
      }
    }
    lines.push('');
    lines.push('---');
    lines.push('');

    // Experiments
    lines.push('## Experiments');
    lines.push('');
    if (experiments.length === 0) {
      lines.push('*No experiments recorded.*');
    } else {
      lines.push('| ID | Command | Status | Exit |');
      lines.push('|----|---------|--------|------|');
      for (const e of experiments) {
        lines.push(`| \`${e.id}\` | \`${e.command}\` | ${e.status} | ${e.exitCode ?? '—'} |`);
      }
      lines.push('');
      for (const e of experiments) {
        lines.push(`### ${e.id}`);
        lines.push('');
        lines.push(`**Command:** \`${e.command}\``);
        if (Object.keys(e.parameters).length > 0) {
          lines.push(`**Parameters:** \`${JSON.stringify(e.parameters)}\``);
        }
        if (e.seed !== undefined) {
          lines.push(`**Seed:** ${e.seed}`);
        }
        if (e.interpretation) {
          lines.push('');
          lines.push(`**Interpretation:** ${e.interpretation}`);
        }
        if (e.outputTail) {
          lines.push('');
          lines.push('<details>');
          lines.push('<summary>Output (last 30 lines)</summary>');
          lines.push('');
          lines.push('```');
          lines.push(e.outputTail);
          lines.push('```');
          lines.push('');
          lines.push('</details>');
        }
        lines.push('');
      }
    }
    lines.push('---');
    lines.push('');

    // Observations
    lines.push('## Observations');
    lines.push('');
    if (observations.length === 0) {
      lines.push('*No observations recorded.*');
    } else {
      for (const o of [...observations].reverse()) {
        lines.push(`### ${new Date(o.timestamp).toISOString().replace('T', ' ').slice(0, 16)} UTC`);
        lines.push('');
        lines.push(o.note);
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');
    lines.push('*Generated by SideCar Research Assistant*');

    const markdown = lines.join('\n');
    const filePath = this.sidecarDir.getPath('research', slug, 'report.md');
    await this.sidecarDir.writeText(`research/${slug}/report.md`, markdown + '\n');

    return { markdown, filePath };
  }

  private async writeProject(project: ResearchProject): Promise<void> {
    await this.sidecarDir.writeJson(`research/${project.slug}/project.yaml`, project);
  }
}
