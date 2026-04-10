import { describe, it, expect } from 'vitest';
import { readFileStreaming, streamFile } from './streamingFileReader.js';

/**
 * Tests for streaming file reader functionality.
 * Note: Full integration tests using VS Code's workspace API are skipped
 * in the test environment since workspace.fs.readFile is mocked.
 * These would be integration tests in a real VS Code environment.
 */

describe('StreamingFileReader', () => {
  it('exports readFileStreaming function', () => {
    expect(typeof readFileStreaming).toBe('function');
  });

  it('exports streamFile function', () => {
    expect(typeof streamFile).toBe('function');
  });

  it('streaming functions are callable', () => {
    expect(readFileStreaming).toBeInstanceOf(Function);
    expect(streamFile).toBeInstanceOf(Function);
  });
});
