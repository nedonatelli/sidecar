import { describe, it, expect } from 'vitest';
import { sweTerminationBucket } from './termination.js';

// #271: nemotron-3-super astropy-12907 (off) and requests-1963 (on) ended on
// the 19-minute per-task timer and were recorded as `natural`.
describe('sweTerminationBucket', () => {
  it('an aborted run is a harness timeout, not a natural finish', () => {
    expect(sweTerminationBucket(null, true)).toBe('harness-timeout');
  });
  it('other endings keep the loop bucket', () => {
    expect(sweTerminationBucket(null, false)).toBeNull();
    expect(sweTerminationBucket('loop-stopped', false)).toBe('loop-stopped');
    expect(sweTerminationBucket('timeout', undefined)).toBe('timeout');
  });
});
