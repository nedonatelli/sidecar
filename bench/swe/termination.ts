import type { FailureBucket } from '../../src/agent/failureTaxonomy.js';
import type { SweTerminationBucket } from './types.js';

/**
 * The SWE label for how a run ended. In this harness an abort can only be the
 * per-task timer: there is no user to press Stop. The loop's taxonomy scores an
 * abort as success (`null`), and the driver wrote `null` as `natural`, so a
 * timed-out run read as a natural finish (#271).
 */
export function sweTerminationBucket(
  bucket: FailureBucket | null,
  aborted: boolean | undefined,
): SweTerminationBucket | null {
  return aborted ? 'harness-timeout' : bucket;
}
