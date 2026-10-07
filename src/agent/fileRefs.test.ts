import { describe, it, expect } from 'vitest';
import { isLibraryName } from './fileRefs.js';
import { isMutationRequest } from './loop/actionReprompt.js';
import { synthesizeFenceWrite } from './loop/textParsing.js';
import { buildNoReadReprompt } from './completionGate/reprompts.js';

// #107: library names matched every file-reference regex.
describe('isLibraryName', () => {
  it('recognizes capitalized library names', () => {
    for (const name of ['Node.js', 'Vue.js', 'Chart.js', 'D3.js', 'Next.js']) expect(isLibraryName(name)).toBe(true);
  });

  it('leaves real file names alone', () => {
    for (const name of ['App.js', 'chart.js', 'src/Node.js', 'node.ts', 'server.js']) {
      expect(isLibraryName(name)).toBe(false);
    }
  });
});

describe('library names are not workspace files', () => {
  const fence = '```javascript\nconst http = require("http");\nhttp.createServer().listen(3000);\n```';

  it('does not count "Node.js" as the file a mutation request names', () => {
    expect(isMutationRequest('Write a simple Node.js http server')).toBe(false);
    expect(isMutationRequest('Write a simple http server in server.js')).toBe(true);
  });

  it('never synthesizes a write to a file named after a library', () => {
    expect(synthesizeFenceWrite(fence, 'Write a Node.js http server', new Set(['write_file']))).toBeNull();
  });

  it('picks the real file when a library is mentioned alongside it', () => {
    const synth = synthesizeFenceWrite(fence, 'Write a Node.js server in server.js', new Set(['write_file']));
    expect(synth?.input.path).toBe('server.js');
  });

  it('does not demand a read of "Vue.js"', () => {
    const messages = [{ role: 'user' as const, content: 'How does Vue.js reactivity work?' }];
    expect(buildNoReadReprompt(messages)).toBeNull();
  });
});
