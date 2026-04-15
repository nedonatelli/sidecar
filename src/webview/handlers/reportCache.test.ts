import { describe, it, expect, beforeEach } from 'vitest';
import { getOrComputeReport, clearReportCache, reportCacheSize } from './reportCache';

describe('reportCache', () => {
  beforeEach(() => {
    clearReportCache();
  });

  it('computes on first call and reports cacheHit=false', async () => {
    let computed = 0;
    const result = await getOrComputeReport('k', 'fp1', () => {
      computed++;
      return 'report-v1';
    });
    expect(result.value).toBe('report-v1');
    expect(result.cacheHit).toBe(false);
    expect(computed).toBe(1);
  });

  it('returns cached value on second call with matching fingerprint', async () => {
    let computed = 0;
    const compute = () => {
      computed++;
      return `report-${computed}`;
    };
    await getOrComputeReport('k', 'fp1', compute);
    const second = await getOrComputeReport('k', 'fp1', compute);
    expect(second.cacheHit).toBe(true);
    expect(second.value).toBe('report-1');
    expect(computed).toBe(1);
  });

  it('recomputes when fingerprint changes', async () => {
    let computed = 0;
    const compute = () => {
      computed++;
      return `report-${computed}`;
    };
    await getOrComputeReport('k', 'fp1', compute);
    const second = await getOrComputeReport('k', 'fp2', compute);
    expect(second.cacheHit).toBe(false);
    expect(second.value).toBe('report-2');
    expect(computed).toBe(2);
  });

  it('recomputes after TTL expiry', async () => {
    let computed = 0;
    const compute = () => {
      computed++;
      return `report-${computed}`;
    };
    // TTL of 0 guarantees every subsequent call is past expiry.
    await getOrComputeReport('k', 'fp1', compute, 0);
    const second = await getOrComputeReport('k', 'fp1', compute, 0);
    expect(second.cacheHit).toBe(false);
    expect(computed).toBe(2);
  });

  it('isolates entries by key', async () => {
    await getOrComputeReport('usage', 'fp', () => 'u');
    await getOrComputeReport('insights', 'fp', () => 'i');
    expect(reportCacheSize()).toBe(2);
  });

  it('supports async compute functions', async () => {
    const result = await getOrComputeReport('k', 'fp', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return 'async-report';
    });
    expect(result.value).toBe('async-report');
  });
});
