import { describe, it, expect, vi, beforeEach } from 'vitest';
import { researchTools, setResearchStore } from './research.js';
import type { ResearchStore } from '../research/researchStore.js';

function makeStore(): ResearchStore {
  return {
    createProject: vi.fn(),
    loadProject: vi.fn(),
    listProjects: vi.fn(),
    addHypothesis: vi.fn(),
    logExperiment: vi.fn(),
    loadExperiment: vi.fn(),
    listExperiments: vi.fn(),
    addObservation: vi.fn(),
    listObservations: vi.fn(),
    getExperimentPath: vi.fn(),
    getObservationPath: vi.fn(),
    updateHypothesisStatus: vi.fn(),
    setProjectStatus: vi.fn(),
    generateReport: vi.fn(),
  } as unknown as ResearchStore;
}

function findTool(name: string) {
  const t = researchTools.find((r) => r.definition.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t;
}

describe('researchTools', () => {
  describe('when store not initialized', () => {
    beforeEach(() => {
      setResearchStore(null as unknown as ResearchStore);
    });

    it('research_create_project returns disabled message', async () => {
      const result = await findTool('research_create_project').executor({ title: 'T', question: 'Q?' });
      expect(result).toContain('sidecar.research.enabled');
    });

    it('research_add_hypothesis returns disabled message', async () => {
      const result = await findTool('research_add_hypothesis').executor({ project: 'p', hypothesis: 'h' });
      expect(result).toContain('disabled');
    });
  });

  describe('research_create_project', () => {
    let store: ReturnType<typeof makeStore>;

    beforeEach(() => {
      store = makeStore();
      setResearchStore(store);
    });

    it('returns project slug and location on success', async () => {
      vi.mocked(store.createProject).mockResolvedValueOnce({
        slug: 'fir-wavelet',
        title: 'FIR vs Wavelet',
        question: 'Which is better?',
        status: 'active',
        hypotheses: [],
        createdAt: 1,
        updatedAt: 1,
      });
      const result = await findTool('research_create_project').executor({
        title: 'FIR vs Wavelet',
        question: 'Which is better?',
      });
      expect(result).toContain('fir-wavelet');
      expect(result).toContain('.sidecar/research/fir-wavelet/');
      expect(result).toContain('research_add_hypothesis');
    });

    it('returns error message on store failure', async () => {
      vi.mocked(store.createProject).mockRejectedValueOnce(new Error('disk full'));
      const result = await findTool('research_create_project').executor({ title: 'T', question: 'Q?' });
      expect(result).toContain('Error creating project');
      expect(result).toContain('disk full');
    });
  });

  describe('research_add_hypothesis', () => {
    let store: ReturnType<typeof makeStore>;

    beforeEach(() => {
      store = makeStore();
      setResearchStore(store);
    });

    it('returns hypothesis id and text on success', async () => {
      vi.mocked(store.addHypothesis).mockResolvedValueOnce({
        id: 'h-123',
        text: 'Wavelet beats FFT',
        status: 'open',
        addedAt: 1,
      });
      const result = await findTool('research_add_hypothesis').executor({
        project: 'proj',
        hypothesis: 'Wavelet beats FFT',
      });
      expect(result).toContain('h-123');
      expect(result).toContain('Wavelet beats FFT');
      expect(result).toContain('open');
    });

    it('returns not-found message when project missing', async () => {
      vi.mocked(store.addHypothesis).mockResolvedValueOnce(null);
      const result = await findTool('research_add_hypothesis').executor({ project: 'missing', hypothesis: 'h' });
      expect(result).toContain('missing');
      expect(result).toContain('not found');
    });
  });

  describe('research_add_observation', () => {
    let store: ReturnType<typeof makeStore>;

    beforeEach(() => {
      store = makeStore();
      setResearchStore(store);
    });

    it('returns timestamp and file path on success', async () => {
      vi.mocked(store.loadProject).mockResolvedValueOnce({
        slug: 'proj',
        title: 'Proj',
        question: 'Q?',
        status: 'active',
        hypotheses: [],
        createdAt: 1,
        updatedAt: 1,
      });
      vi.mocked(store.addObservation).mockResolvedValueOnce({
        timestamp: 1716566400000,
        note: 'Loss plateaued at epoch 12',
        filePath: '/sidecar/research/proj/observations/1716566400000.md',
      });
      const result = await findTool('research_add_observation').executor({
        project: 'proj',
        note: 'Loss plateaued at epoch 12',
      });
      expect(result).toContain('Observation recorded');
      expect(result).toContain('Loss plateaued at epoch 12');
      expect(result).toContain('/sidecar/research/proj/observations/');
    });

    it('returns not-found message when project missing', async () => {
      vi.mocked(store.loadProject).mockResolvedValueOnce(null);
      const result = await findTool('research_add_observation').executor({
        project: 'missing',
        note: 'some note',
      });
      expect(result).toContain('missing');
      expect(result).toContain('not found');
    });
  });

  describe('research_update_hypothesis_status', () => {
    let store: ReturnType<typeof makeStore>;

    beforeEach(() => {
      store = makeStore();
      setResearchStore(store);
    });

    it('returns updated hypothesis on success', async () => {
      vi.mocked(store.updateHypothesisStatus).mockResolvedValueOnce({
        id: 'h-1',
        text: 'Wavelet beats FFT',
        status: 'supported',
        addedAt: 1,
      });
      const result = await findTool('research_update_hypothesis_status').executor({
        project: 'proj',
        id: 'h-1',
        status: 'supported',
      });
      expect(result).toContain('h-1');
      expect(result).toContain('supported');
    });

    it('returns not-found message when hypothesis missing', async () => {
      vi.mocked(store.updateHypothesisStatus).mockResolvedValueOnce(null);
      const result = await findTool('research_update_hypothesis_status').executor({
        project: 'proj',
        id: 'h-999',
        status: 'refuted',
      });
      expect(result).toContain('h-999');
      expect(result).toContain('not found');
    });
  });

  describe('research_list_projects', () => {
    let store: ReturnType<typeof makeStore>;

    beforeEach(() => {
      store = makeStore();
      setResearchStore(store);
    });

    it('returns no-projects message when empty', async () => {
      vi.mocked(store.listProjects).mockResolvedValueOnce([]);
      const result = await findTool('research_list_projects').executor({});
      expect(result).toContain('No research projects');
    });

    it('lists projects with slug and status', async () => {
      vi.mocked(store.listProjects).mockResolvedValueOnce([
        {
          slug: 'fir-wavelet',
          title: 'FIR vs Wavelet',
          status: 'active',
          hypotheses: [{} as never, {} as never],
          question: 'Q?',
          createdAt: 1,
          updatedAt: Date.now() - 60_000,
        },
      ]);
      const result = await findTool('research_list_projects').executor({});
      expect(result).toContain('fir-wavelet');
      expect(result).toContain('FIR vs Wavelet');
      expect(result).toContain('active');
      expect(result).toContain('2 hypotheses');
    });
  });

  describe('research_export_report', () => {
    let store: ReturnType<typeof makeStore>;

    beforeEach(() => {
      store = makeStore();
      setResearchStore(store);
    });

    it('returns report markdown and file path on success', async () => {
      vi.mocked(store.generateReport).mockResolvedValueOnce({
        markdown: '# Research Report: My Project\n\nSome content.',
        filePath: '/sidecar/research/my-proj/report.md',
      });
      const result = await findTool('research_export_report').executor({ project: 'my-proj' });
      expect(result).toContain('my-proj');
      expect(result).toContain('/sidecar/research/my-proj/report.md');
      expect(result).toContain('# Research Report: My Project');
    });

    it('returns not-found message when project missing', async () => {
      vi.mocked(store.generateReport).mockResolvedValueOnce(null);
      const result = await findTool('research_export_report').executor({ project: 'missing' });
      expect(result).toContain('missing');
      expect(result).toContain('not found');
    });

    it('returns error message on store failure', async () => {
      vi.mocked(store.generateReport).mockRejectedValueOnce(new Error('disk full'));
      const result = await findTool('research_export_report').executor({ project: 'proj' });
      expect(result).toContain('Error generating report');
      expect(result).toContain('disk full');
    });
  });

  describe('research_set_project_status', () => {
    let store: ReturnType<typeof makeStore>;

    beforeEach(() => {
      store = makeStore();
      setResearchStore(store);
    });

    it('returns updated project on success', async () => {
      vi.mocked(store.setProjectStatus).mockResolvedValueOnce({
        slug: 'my-proj',
        title: 'My Project',
        question: 'Q?',
        status: 'complete',
        hypotheses: [],
        createdAt: 1,
        updatedAt: 2,
      });
      const result = await findTool('research_set_project_status').executor({
        project: 'my-proj',
        status: 'complete',
      });
      expect(result).toContain('my-proj');
      expect(result).toContain('complete');
    });

    it('returns not-found message when project missing', async () => {
      vi.mocked(store.setProjectStatus).mockResolvedValueOnce(null);
      const result = await findTool('research_set_project_status').executor({
        project: 'missing',
        status: 'abandoned',
      });
      expect(result).toContain('missing');
      expect(result).toContain('not found');
    });
  });

  describe('requiresApproval', () => {
    it('research_log_experiment requires approval', () => {
      expect(findTool('research_log_experiment').requiresApproval).toBe(true);
    });

    it('read-only tools do not require approval', () => {
      for (const name of [
        'research_create_project',
        'research_add_hypothesis',
        'research_add_observation',
        'research_update_hypothesis_status',
        'research_list_projects',
        'research_set_project_status',
        'research_export_report',
      ]) {
        expect(findTool(name).requiresApproval).toBe(false);
      }
    });
  });
});
