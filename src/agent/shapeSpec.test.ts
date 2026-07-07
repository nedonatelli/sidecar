import { describe, it, expect } from 'vitest';
import { parseTypeShape, parseShapeTuple, shapeConflict, normalizeDtype } from './shapeSpec.js';

describe('parseTypeShape', () => {
  it('parses jaxtyping (space-separated dims + dtype)', () => {
    expect(parseTypeShape('Float[np.ndarray, "n 3"]')).toEqual({ dtype: 'float', dims: ['n', 3] });
    expect(parseTypeShape('Int[Array, "batch h w"]')).toEqual({ dtype: 'int', dims: ['batch', 'h', 'w'] });
  });

  it('parses nptyping Shape (comma-separated dims) with optional dtype', () => {
    expect(parseTypeShape('NDArray[Shape["3, N"], Float]')).toEqual({ dims: [3, 'N'], dtype: 'float' });
    expect(parseTypeShape('NDArray[Shape["2, 2"]]')).toEqual({ dims: [2, 2], dtype: undefined });
  });

  it('parses dtype-only numpy.typing (no shape)', () => {
    expect(parseTypeShape('npt.NDArray[np.float64]')).toEqual({ dims: null, dtype: 'float64' });
    expect(parseTypeShape('NDArray[Any, np.int32]')).toEqual({ dims: null, dtype: 'int32' });
  });

  it('returns null for a bare unshaped array type', () => {
    expect(parseTypeShape('np.ndarray')).toBeNull();
    expect(parseTypeShape('ndarray')).toBeNull();
    expect(parseTypeShape('int')).toBeNull();
  });

  it('handles variadic dims', () => {
    expect(parseTypeShape('Float[Array, "... 3"]')).toEqual({ dtype: 'float', dims: ['...', 3] });
  });
});

describe('parseShapeTuple', () => {
  it('parses assert-style shape tuples including the 1-tuple', () => {
    expect(parseShapeTuple('(3, N)')).toEqual({ dims: [3, 'N'] });
    expect(parseShapeTuple('(3,)')).toEqual({ dims: [3] });
    expect(parseShapeTuple('x.shape == (4, 4)')).toEqual({ dims: [4, 4] });
  });
});

describe('shapeConflict', () => {
  it('flags rank mismatch', () => {
    expect(shapeConflict({ dims: [3, 'N'] }, { dims: ['N'] })).toMatchObject({ kind: 'rank' });
  });

  it('flags conflicting literal dims at the same position', () => {
    expect(shapeConflict({ dims: [3, 'N'] }, { dims: [4, 'N'] })).toMatchObject({ kind: 'dim' });
  });

  it('flags dtype conflict (after np. normalization)', () => {
    expect(shapeConflict({ dims: null, dtype: 'np.float64' }, { dims: null, dtype: 'float32' })).toMatchObject({
      kind: 'dtype',
    });
    expect(shapeConflict({ dims: null, dtype: 'np.float64' }, { dims: null, dtype: 'Float64' })).toBeNull();
  });

  it('treats symbolic dims as wildcards (no false conflict)', () => {
    expect(shapeConflict({ dims: ['N', 3] }, { dims: [5, 3] })).toBeNull(); // N could be 5
    expect(shapeConflict({ dims: ['N', 'M'] }, { dims: ['M', 'N'] })).toBeNull();
  });

  it('does not flag rank when a variadic is present', () => {
    expect(shapeConflict({ dims: ['...', 3] }, { dims: [4, 5, 3] })).toBeNull();
  });

  it('returns null when one side has no shape (dtype-only vs shaped)', () => {
    expect(shapeConflict({ dims: null, dtype: 'float64' }, { dims: [3, 3] })).toBeNull();
  });
});

describe('normalizeDtype', () => {
  it('strips np. prefix and lowercases', () => {
    expect(normalizeDtype('np.Float64')).toBe('float64');
    expect(normalizeDtype('numpy.int32')).toBe('int32');
  });
});
