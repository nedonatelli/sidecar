import { describe, it, expect } from 'vitest';
import { getTemplateList } from './scaffold.js';

describe('scaffold', () => {
  it('getTemplateList returns available templates', () => {
    const list = getTemplateList();
    expect(typeof list).toBe('string');
    expect(list.length).toBeGreaterThan(0);
    // Should mention common template types
    expect(list.toLowerCase()).toContain('component');
  });
});
