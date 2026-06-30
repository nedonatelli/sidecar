import { describe, it, expect } from 'vitest';
import { toPredictionsJsonl, parseResolvedReport } from './predictions.js';
import type { SwePrediction } from './types.js';

const preds: SwePrediction[] = [
  { instance_id: 'a-1', arm: 'scaffold-on', model_patch: 'diff on', durationMs: 1000 },
  { instance_id: 'a-1', arm: 'scaffold-off', model_patch: 'diff off', durationMs: 800 },
  { instance_id: 'b-2', arm: 'scaffold-on', model_patch: '', durationMs: 1200 },
];

describe('toPredictionsJsonl', () => {
  it('emits official-format lines for one arm, suffixing the model name with the arm', () => {
    const out = toPredictionsJsonl(preds, 'gemma4:e4b', 'scaffold-on');
    const lines = out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2); // only the two scaffold-on predictions
    expect(lines[0]).toEqual({
      instance_id: 'a-1',
      model_name_or_path: 'gemma4:e4b__scaffold-on',
      model_patch: 'diff on',
    });
    expect(lines[1].instance_id).toBe('b-2');
  });

  it('keeps the arms in separate files', () => {
    const off = toPredictionsJsonl(preds, 'm', 'scaffold-off');
    expect(off.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(off.trim()).model_patch).toBe('diff off');
  });
});

describe('parseResolvedReport', () => {
  it('reads the resolved_ids array shape', () => {
    expect([...parseResolvedReport('{"resolved_ids":["a-1","c-3"]}')]).toEqual(['a-1', 'c-3']);
  });

  it('reads the per-instance results-map shape', () => {
    const json = '{"results":{"a-1":{"resolved":true},"b-2":{"resolved":false}}}';
    expect([...parseResolvedReport(json)]).toEqual(['a-1']);
  });

  it('returns an empty set for an unrecognized report', () => {
    expect(parseResolvedReport('{"foo":1}').size).toBe(0);
  });
});
