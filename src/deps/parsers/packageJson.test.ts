import { describe, it, expect } from 'vitest';
import { parsePackageJson } from './packageJson.js';

describe('parsePackageJson', () => {
  it('parses dependencies and devDependencies', () => {
    const result = parsePackageJson(
      JSON.stringify({
        dependencies: { react: '^18.0.0', lodash: '4.17.21' },
        devDependencies: { typescript: '~5.0.0', vitest: '^1.0.0' },
      }),
    );
    expect(result).toHaveLength(4);
    expect(result.find((d) => d.name === 'react')).toMatchObject({
      name: 'react',
      specifiedVersion: '^18.0.0',
      ecosystem: 'npm',
      dev: false,
    });
    expect(result.find((d) => d.name === 'typescript')).toMatchObject({
      name: 'typescript',
      specifiedVersion: '~5.0.0',
      ecosystem: 'npm',
      dev: true,
    });
  });

  it('returns empty array for invalid JSON', () => {
    expect(parsePackageJson('not json')).toEqual([]);
  });

  it('returns empty array for empty object', () => {
    expect(parsePackageJson('{}')).toEqual([]);
  });

  it('handles missing devDependencies', () => {
    const result = parsePackageJson(JSON.stringify({ dependencies: { express: '4.18.0' } }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'express', dev: false });
  });

  it('handles missing dependencies', () => {
    const result = parsePackageJson(JSON.stringify({ devDependencies: { jest: '^29.0.0' } }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'jest', dev: true });
  });

  it('skips non-string version values', () => {
    const result = parsePackageJson(JSON.stringify({ dependencies: { good: '1.0.0', bad: { version: '2.0.0' } } }));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('good');
  });

  it('returns empty array for empty string', () => {
    expect(parsePackageJson('')).toEqual([]);
  });
});
