import { describe, it, expect } from 'vitest';
import { stripRange, semverGt, semverEq } from './semver.js';

describe('stripRange', () => {
  it('passes through plain versions', () => {
    expect(stripRange('1.2.3')).toBe('1.2.3');
  });
  it('strips caret', () => expect(stripRange('^1.2.3')).toBe('1.2.3'));
  it('strips tilde', () => expect(stripRange('~2.0.0')).toBe('2.0.0'));
  it('strips >= range', () => expect(stripRange('>=3.0.0')).toBe('3.0.0'));
  it('strips v prefix', () => expect(stripRange('v4.1.0')).toBe('4.1.0'));
  it('returns 0.0.0 for wildcard', () => expect(stripRange('*')).toBe('0.0.0'));
  it('handles leading whitespace', () => expect(stripRange('  ^1.0.0')).toBe('1.0.0'));
});

describe('semverGt', () => {
  it('detects higher major', () => expect(semverGt('2.0.0', '1.9.9')).toBe(true));
  it('detects higher minor', () => expect(semverGt('1.2.0', '1.1.9')).toBe(true));
  it('detects higher patch', () => expect(semverGt('1.0.1', '1.0.0')).toBe(true));
  it('equal versions return false', () => expect(semverGt('1.0.0', '1.0.0')).toBe(false));
  it('lower version returns false', () => expect(semverGt('1.0.0', '2.0.0')).toBe(false));
  it('strips range operators before comparing', () => expect(semverGt('^2.0.0', '~1.9.0')).toBe(true));
  it('handles two-part versions', () => expect(semverGt('1.2', '1.1')).toBe(true));
});

describe('semverEq', () => {
  it('equal versions', () => expect(semverEq('1.0.0', '1.0.0')).toBe(true));
  it('with range operators stripped', () => expect(semverEq('^1.0.0', '1.0.0')).toBe(true));
  it('different versions not equal', () => expect(semverEq('1.0.0', '1.0.1')).toBe(false));
});
