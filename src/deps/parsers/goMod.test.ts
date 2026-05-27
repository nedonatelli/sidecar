import { describe, it, expect } from 'vitest';
import { parseGoMod } from './goMod.js';

const SAMPLE = `
module github.com/my/app

go 1.21

require (
  github.com/gin-gonic/gin v1.9.1
  golang.org/x/net v0.15.0 // indirect
)

require github.com/sirupsen/logrus v1.9.3
`;

describe('parseGoMod', () => {
  it('parses block require entries', () => {
    const result = parseGoMod(SAMPLE);
    const gin = result.find((d) => d.name === 'github.com/gin-gonic/gin');
    expect(gin).toMatchObject({
      name: 'github.com/gin-gonic/gin',
      specifiedVersion: 'v1.9.1',
      ecosystem: 'go',
      dev: false,
    });
  });

  it('marks indirect deps as dev=true', () => {
    const result = parseGoMod(SAMPLE);
    const net = result.find((d) => d.name === 'golang.org/x/net');
    expect(net).toMatchObject({ dev: true });
  });

  it('parses inline require', () => {
    const result = parseGoMod(SAMPLE);
    const logrus = result.find((d) => d.name === 'github.com/sirupsen/logrus');
    expect(logrus).toMatchObject({
      name: 'github.com/sirupsen/logrus',
      specifiedVersion: 'v1.9.3',
      dev: false,
    });
  });

  it('skips comment-only lines', () => {
    const result = parseGoMod('// this is a comment\nrequire (\n  pkg/a v1.0.0\n)\n');
    expect(result).toHaveLength(1);
  });

  it('skips blank lines', () => {
    const result = parseGoMod('\n\nrequire pkg/b v2.0.0\n\n');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('pkg/b');
  });

  it('closes block on closing paren', () => {
    const content = 'require (\n  pkg/a v1.0.0\n)\nrequire pkg/b v2.0.0\n';
    const result = parseGoMod(content);
    expect(result).toHaveLength(2);
  });

  it('returns empty array for empty content', () => {
    expect(parseGoMod('')).toEqual([]);
  });

  it('returns empty array when no require statements exist', () => {
    expect(parseGoMod('module github.com/x/y\n\ngo 1.21\n')).toEqual([]);
  });
});
