import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tests } from 'vscode';

import { SidecarTestController } from './testController.js';

function makeContext() {
  return { subscriptions: [] as unknown[] };
}

function makeRun() {
  return {
    started: vi.fn(),
    passed: vi.fn(),
    failed: vi.fn(),
    skipped: vi.fn(),
    appendOutput: vi.fn(),
    end: vi.fn(),
  };
}

const VITEST_PASS = ' Test Files  1 passed (1)\n  ✓ src/foo.test.ts > my suite > does the thing 5ms\n';

const VITEST_FAIL = ' Test Files  1 failed (1)\n  × src/foo.test.ts > my suite > blows up 2ms\n';

const VITEST_SKIP = ' Test Files  1 passed (1)\n  ↓ src/foo.test.ts > my suite > pending test\n';

const VITEST_MIXED = [
  ' Test Files  1 failed (1)',
  '  ✓ src/a.test.ts > passes 1ms',
  '  × src/b.test.ts > fails 2ms',
  '  ↓ src/c.test.ts > skipped',
].join('\n');

describe('SidecarTestController', () => {
  let run: ReturnType<typeof makeRun>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    run = makeRun();
    vi.spyOn(tests, 'createTestController').mockReturnValue({
      items: { add: vi.fn(), delete: vi.fn(), get: vi.fn(), size: 0 },
      createTestItem: vi.fn((id, label, uri) => ({
        id,
        label,
        uri,
        children: { add: vi.fn(), delete: vi.fn(), get: vi.fn(), size: 0 },
      })),
      createRunProfile: vi.fn(),
      createTestRun: vi.fn(() => run),
      dispose: vi.fn(),
    } as never);
  });

  it('registers itself on the extension context subscriptions', () => {
    const ctx = makeContext();
    new SidecarTestController(ctx as never);
    expect(ctx.subscriptions).toHaveLength(1);
  });

  it('creates a test controller with the expected id and label', () => {
    new SidecarTestController(makeContext() as never);
    expect(tests.createTestController).toHaveBeenCalledWith('sidecar-tests', 'SideCar Tests');
  });

  it('creates a run profile during construction', () => {
    const ctrlResult = {
      items: { add: vi.fn(), delete: vi.fn(), get: vi.fn(), size: 0 },
      createTestItem: vi.fn((id, label, uri) => ({
        id,
        label,
        uri,
        children: { add: vi.fn(), delete: vi.fn(), get: vi.fn(), size: 0 },
      })),
      createRunProfile: vi.fn(),
      createTestRun: vi.fn(() => run),
      dispose: vi.fn(),
    };
    vi.spyOn(tests, 'createTestController').mockReturnValue(ctrlResult as never);

    new SidecarTestController(makeContext() as never);

    expect(ctrlResult.createRunProfile).toHaveBeenCalledOnce();
  });

  describe('reportRun', () => {
    it('returns early without creating a run when total is 0', () => {
      const ctrl = new SidecarTestController(makeContext() as never);
      const createRun = vi.mocked(tests.createTestController).mock.results[0]!.value.createTestRun;

      ctrl.reportRun('vitest', 'no recognizable output here');

      expect(createRun).not.toHaveBeenCalled();
    });

    it('calls run.passed for a passing test', () => {
      const ctrl = new SidecarTestController(makeContext() as never);
      ctrl.reportRun('vitest', VITEST_PASS);

      expect(run.passed).toHaveBeenCalledOnce();
      expect(run.failed).not.toHaveBeenCalled();
    });

    it('passes duration to run.passed', () => {
      const ctrl = new SidecarTestController(makeContext() as never);
      ctrl.reportRun('vitest', VITEST_PASS);

      const [, duration] = run.passed.mock.calls[0] as [unknown, number | undefined];
      expect(duration).toBe(5);
    });

    it('calls run.failed for a failing test', () => {
      const ctrl = new SidecarTestController(makeContext() as never);
      ctrl.reportRun('vitest', VITEST_FAIL);

      expect(run.failed).toHaveBeenCalledOnce();
      expect(run.passed).not.toHaveBeenCalled();
    });

    it('calls run.skipped for a skipped test', () => {
      const ctrl = new SidecarTestController(makeContext() as never);
      ctrl.reportRun('vitest', VITEST_SKIP);

      expect(run.skipped).toHaveBeenCalledOnce();
    });

    it('calls run.end after processing all tests', () => {
      const ctrl = new SidecarTestController(makeContext() as never);
      ctrl.reportRun('vitest', VITEST_PASS);
      expect(run.end).toHaveBeenCalledOnce();
    });

    it('handles mixed pass/fail/skip in one run', () => {
      const ctrl = new SidecarTestController(makeContext() as never);
      ctrl.reportRun('vitest', VITEST_MIXED);

      expect(run.passed).toHaveBeenCalledTimes(1);
      expect(run.failed).toHaveBeenCalledTimes(1);
      expect(run.skipped).toHaveBeenCalledTimes(1);
      expect(run.end).toHaveBeenCalledOnce();
    });

    it('reuses the existing test item for a test seen a second time', () => {
      const ctrl = new SidecarTestController(makeContext() as never);
      const createTestItem = vi.mocked(tests.createTestController).mock.results[0]!.value.createTestItem as ReturnType<
        typeof vi.fn
      >;

      ctrl.reportRun('vitest', VITEST_PASS);
      ctrl.reportRun('vitest', VITEST_PASS);

      // createTestItem called once for file item + once for test item = 2 total;
      // second run should not create new items (both are cached).
      const callsBefore = createTestItem.mock.calls.length;
      ctrl.reportRun('vitest', VITEST_PASS);
      expect(createTestItem.mock.calls.length).toBe(callsBefore);
    });

    it('creates a file-level test item for tests with a filePath', () => {
      const ctrl = new SidecarTestController(makeContext() as never);
      // mock.results[0] is valid here because afterEach restores spies,
      // so each test starts with a fresh spy and a fresh results array.
      const createTestItem = vi.mocked(tests.createTestController).mock.results[0]!.value.createTestItem as ReturnType<
        typeof vi.fn
      >;

      ctrl.reportRun('vitest', VITEST_PASS);

      // Expect a call where the label equals the file path
      const fileItemCall = (createTestItem.mock.calls as [string, string, unknown][]).find(
        ([, label]) => label === 'src/foo.test.ts',
      );
      expect(fileItemCall).toBeDefined();
    });
  });
});
