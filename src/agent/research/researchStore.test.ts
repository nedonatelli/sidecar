import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workspace } from 'vscode';
import { ResearchStore } from './researchStore.js';
import type { SidecarDir } from '../../config/sidecarDir.js';

function makeSidecarDir(): SidecarDir {
  return {
    getPath: (...segments: string[]) => `/sidecar/${segments.join('/')}`,
    readJson: vi.fn().mockResolvedValue(null),
    writeJson: vi.fn().mockResolvedValue(undefined),
    writeText: vi.fn().mockResolvedValue(undefined),
  } as unknown as SidecarDir;
}

describe('ResearchStore', () => {
  let sd: ReturnType<typeof makeSidecarDir>;
  let store: ResearchStore;

  beforeEach(() => {
    sd = makeSidecarDir();
    store = new ResearchStore(sd);
    vi.spyOn(workspace.fs, 'readDirectory').mockResolvedValue([]);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(new Uint8Array());
  });

  describe('createProject', () => {
    it('slugifies the title', async () => {
      const p = await store.createProject('FIR vs Wavelet', 'Does wavelet beat FFT?');
      expect(p.slug).toBe('fir-vs-wavelet');
    });

    it('sets status to active and empty hypotheses', async () => {
      const p = await store.createProject('Test Project', 'Question?');
      expect(p.status).toBe('active');
      expect(p.hypotheses).toEqual([]);
    });

    it('writes to sidecarDir', async () => {
      await store.createProject('Test Project', 'Question?');
      expect(sd.writeJson).toHaveBeenCalledWith(
        'research/test-project/project.yaml',
        expect.objectContaining({ title: 'Test Project' }),
      );
    });

    it('falls back slug when title is all symbols', async () => {
      const p = await store.createProject('!!!', 'Question?');
      expect(p.slug).toMatch(/^project-\d+$/);
    });
  });

  describe('loadProject', () => {
    it('returns null when project does not exist', async () => {
      vi.mocked(sd.readJson).mockResolvedValueOnce(null);
      expect(await store.loadProject('missing')).toBeNull();
    });

    it('returns project when found', async () => {
      const fake = { slug: 'my-proj', title: 'My Proj', hypotheses: [] };
      vi.mocked(sd.readJson).mockResolvedValueOnce(fake);
      expect(await store.loadProject('my-proj')).toEqual(fake);
    });
  });

  describe('listProjects', () => {
    it('returns empty array when research dir missing', async () => {
      vi.spyOn(workspace.fs, 'readDirectory').mockRejectedValueOnce(new Error('ENOENT'));
      expect(await store.listProjects()).toEqual([]);
    });

    it('returns projects sorted by updatedAt descending', async () => {
      vi.spyOn(workspace.fs, 'readDirectory').mockResolvedValueOnce([
        ['proj-a', 2],
        ['proj-b', 2],
      ]);
      const older = { slug: 'proj-a', updatedAt: 100, hypotheses: [] };
      const newer = { slug: 'proj-b', updatedAt: 200, hypotheses: [] };
      vi.mocked(sd.readJson).mockResolvedValueOnce(older).mockResolvedValueOnce(newer);
      const list = await store.listProjects();
      expect(list[0].slug).toBe('proj-b');
      expect(list[1].slug).toBe('proj-a');
    });
  });

  describe('addHypothesis', () => {
    it('returns null when project not found', async () => {
      vi.mocked(sd.readJson).mockResolvedValueOnce(null);
      expect(await store.addHypothesis('unknown', 'some hypothesis')).toBeNull();
    });

    it('adds hypothesis with open status', async () => {
      const project = {
        slug: 'proj',
        title: 'Proj',
        question: 'Q?',
        status: 'active',
        hypotheses: [],
        createdAt: 1,
        updatedAt: 1,
      };
      vi.mocked(sd.readJson).mockResolvedValueOnce(project);
      const hypo = await store.addHypothesis('proj', 'FFT outperforms wavelet');
      expect(hypo).not.toBeNull();
      expect(hypo!.status).toBe('open');
      expect(hypo!.text).toBe('FFT outperforms wavelet');
      expect(hypo!.id).toMatch(/^h-/);
    });

    it('writes updated project back to disk', async () => {
      const project = {
        slug: 'proj',
        title: 'Proj',
        question: 'Q?',
        status: 'active',
        hypotheses: [],
        createdAt: 1,
        updatedAt: 1,
      };
      vi.mocked(sd.readJson).mockResolvedValueOnce(project);
      await store.addHypothesis('proj', 'hypothesis text');
      expect(sd.writeJson).toHaveBeenCalledWith(
        'research/proj/project.yaml',
        expect.objectContaining({
          hypotheses: expect.arrayContaining([expect.objectContaining({ text: 'hypothesis text' })]),
        }),
      );
    });
  });

  describe('logExperiment', () => {
    it('writes manifest to experiments subdir', async () => {
      vi.mocked(sd.readJson).mockResolvedValueOnce(null); // project not found — ok
      const manifest = {
        id: 'exp-001',
        command: 'python train.py',
        parameters: {},
        status: 'complete' as const,
        createdAt: 1,
        updatedAt: 1,
      };
      await store.logExperiment('proj', manifest);
      expect(sd.writeJson).toHaveBeenCalledWith('research/proj/experiments/exp-001/manifest.yaml', manifest);
    });
  });

  describe('addObservation', () => {
    it('writes observation file and returns entry', async () => {
      vi.mocked(sd.readJson).mockResolvedValueOnce(null); // project update skip
      const obs = await store.addObservation('proj', 'Interesting result');
      expect(sd.writeText).toHaveBeenCalledWith(
        expect.stringMatching(/research\/proj\/observations\/\d+\.md/),
        expect.stringContaining('Interesting result'),
      );
      expect(obs.note).toBe('Interesting result');
      expect(obs.filePath).toContain('observations');
    });
  });

  describe('setProjectStatus', () => {
    it('returns null when project not found', async () => {
      vi.mocked(sd.readJson).mockResolvedValueOnce(null);
      expect(await store.setProjectStatus('missing', 'complete')).toBeNull();
    });

    it('updates status and writes project', async () => {
      const project = {
        slug: 'proj',
        title: 'Proj',
        question: 'Q?',
        status: 'active' as const,
        hypotheses: [],
        createdAt: 1,
        updatedAt: 1,
      };
      vi.mocked(sd.readJson).mockResolvedValueOnce(project);
      const result = await store.setProjectStatus('proj', 'complete');
      expect(result).not.toBeNull();
      expect(result!.status).toBe('complete');
      expect(sd.writeJson).toHaveBeenCalledWith(
        'research/proj/project.yaml',
        expect.objectContaining({ status: 'complete' }),
      );
    });
  });

  describe('updateHypothesisStatus', () => {
    it('returns null when project not found', async () => {
      vi.mocked(sd.readJson).mockResolvedValueOnce(null);
      expect(await store.updateHypothesisStatus('missing', 'h-1', 'supported')).toBeNull();
    });

    it('returns null when hypothesis id not found', async () => {
      const project = {
        slug: 'proj',
        title: 'Proj',
        question: 'Q?',
        status: 'active',
        hypotheses: [{ id: 'h-1', text: 'T', status: 'open', addedAt: 1 }],
        createdAt: 1,
        updatedAt: 1,
      };
      vi.mocked(sd.readJson).mockResolvedValueOnce(project);
      expect(await store.updateHypothesisStatus('proj', 'h-999', 'supported')).toBeNull();
    });

    it('updates status and writes project', async () => {
      const project = {
        slug: 'proj',
        title: 'Proj',
        question: 'Q?',
        status: 'active',
        hypotheses: [{ id: 'h-1', text: 'Wavelet beats FFT', status: 'open', addedAt: 1 }],
        createdAt: 1,
        updatedAt: 1,
      };
      vi.mocked(sd.readJson).mockResolvedValueOnce(project);
      const result = await store.updateHypothesisStatus('proj', 'h-1', 'supported');
      expect(result).not.toBeNull();
      expect(result!.status).toBe('supported');
      expect(sd.writeJson).toHaveBeenCalledWith(
        'research/proj/project.yaml',
        expect.objectContaining({
          hypotheses: expect.arrayContaining([expect.objectContaining({ id: 'h-1', status: 'supported' })]),
        }),
      );
    });
  });

  describe('getExperimentPath', () => {
    it('returns the manifest path', () => {
      const path = store.getExperimentPath('my-proj', 'exp-001');
      expect(path).toBe('/sidecar/research/my-proj/experiments/exp-001/manifest.yaml');
    });
  });
});
