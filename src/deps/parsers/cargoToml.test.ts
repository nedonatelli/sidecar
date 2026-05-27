import { describe, it, expect } from 'vitest';
import { parseCargoToml } from './cargoToml.js';

const SAMPLE = `
[package]
name = "my-crate"
version = "0.1.0"

[dependencies]
serde = "1.0"
tokio = { version = "1.28", features = ["full"] }

[dev-dependencies]
criterion = "0.5"

[build-dependencies]
cc = "1.0"
`;

describe('parseCargoToml', () => {
  it('parses [dependencies] as non-dev', () => {
    const result = parseCargoToml(SAMPLE);
    const serde = result.find((d) => d.name === 'serde');
    expect(serde).toMatchObject({ name: 'serde', specifiedVersion: '1.0', ecosystem: 'cargo', dev: false });
  });

  it('parses inline-table syntax with version field', () => {
    const result = parseCargoToml(SAMPLE);
    const tokio = result.find((d) => d.name === 'tokio');
    expect(tokio).toMatchObject({ name: 'tokio', specifiedVersion: '1.28', dev: false });
  });

  it('parses [dev-dependencies] as dev=true', () => {
    const result = parseCargoToml(SAMPLE);
    const criterion = result.find((d) => d.name === 'criterion');
    expect(criterion).toMatchObject({ name: 'criterion', specifiedVersion: '0.5', dev: true });
  });

  it('parses [build-dependencies] as dev=true', () => {
    const result = parseCargoToml(SAMPLE);
    const cc = result.find((d) => d.name === 'cc');
    expect(cc).toMatchObject({ name: 'cc', specifiedVersion: '1.0', dev: true });
  });

  it('ignores [package] section entries', () => {
    const result = parseCargoToml(SAMPLE);
    expect(result.find((d) => d.name === 'my-crate')).toBeUndefined();
  });

  it('skips comment lines', () => {
    const content = '[dependencies]\n# serde = "1.0"\nfloc = "0.2"\n';
    const result = parseCargoToml(content);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('floc');
  });

  it('handles underscore alias for dev_dependencies', () => {
    const content = '[dev_dependencies]\nfakecrate = "0.1"\n';
    const result = parseCargoToml(content);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'fakecrate', dev: true });
  });

  it('returns empty array for empty content', () => {
    expect(parseCargoToml('')).toEqual([]);
  });

  it('returns empty array when no dep section exists', () => {
    expect(parseCargoToml('[package]\nname = "x"\n')).toEqual([]);
  });
});
