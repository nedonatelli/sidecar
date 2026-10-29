import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileMentions, isQuotedMention, existsInWorkspace } from './mentions.js';
import { buildNoReadReprompt, buildNoFileWriteReprompt } from '../completionGate.js';

// #317: issue reports quote files that are not in the workspace, and the
// no-read / no-file-write gates demanded them. These shapes are from the
// 2026-10-21 canary's problem statements.
const quoted = (text: string, name: string) => {
  const m = fileMentions(text).find((x) => x.file.endsWith(name));
  if (!m) throw new Error(`no mention of ${name}`);
  return isQuotedMention(text, m.index);
};

describe('isQuotedMention', () => {
  it('a row of pip list output inside a code block (pytest-7490)', () => {
    expect(
      quoted('Environment:\n```\naspy.yaml                     1.3.0\n```\nThe xfail marker...', 'aspy.yaml'),
    ).toBe(true);
  });

  it('a traceback frame, whose leading slash the mention pattern drops (django-16816)', () => {
    const text = 'Traceback:\n File "/some/path/django/contrib/admin/utils.py", line 334, in label_for_field';
    expect(quoted(text, 'utils.py')).toBe(true);
  });

  it('a shell command line (django-15781)', () => {
    expect(quoted('Running it:\n$ ./manage.py help tzkt_import\nprints the help', 'manage.py')).toBe(true);
  });

  it('an indented code line', () => {
    expect(quoted('Example:\n\t./manage.py tzkt_import "Tezos"\n', 'manage.py')).toBe(true);
  });

  it('a file the request names in its own words is not quoted', () => {
    expect(quoted('Add a docstring to src/greeter.ts and fix calculator.py.', 'greeter.ts')).toBe(false);
    expect(quoted('Add a docstring to src/greeter.ts and fix calculator.py.', 'calculator.py')).toBe(false);
  });
});

describe('existsInWorkspace', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mentions-'));
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'views.py'), 'x = 1\n');
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'hidden.py'), 'x = 1\n');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('finds a path as given, and a bare name anywhere in the workspace', () => {
    expect(existsInWorkspace(root, 'app/views.py')).toBe(true);
    expect(existsInWorkspace(root, 'views.py')).toBe(true); // "fix views.py" means app/views.py
  });

  it('a path that is not there, a bare name that is nowhere, and node_modules do not count', () => {
    expect(existsInWorkspace(root, 'pmxbot/logging.py')).toBe(false);
    expect(existsInWorkspace(root, 'aspy.yaml')).toBe(false);
    expect(existsInWorkspace(root, 'hidden.py')).toBe(false);
  });
});

describe('the gates on issue-report text (#317)', () => {
  it('no-read does not demand a file that is not in the workspace', () => {
    const msgs = [{ role: 'user' as const, content: 'The xfail marker breaks. My env has aspy.yaml installed.' }];
    expect(buildNoReadReprompt(msgs, undefined, undefined, () => false)).toBeNull();
  });

  it('no-read still demands an existing file, worded as the request mentioning it', () => {
    const msgs = [{ role: 'user' as const, content: 'What does src/greeter.ts export?' }];
    const r = buildNoReadReprompt(msgs, undefined, undefined, () => true);
    expect(r).toContain('The request mentions `src/greeter.ts`');
    expect(r).not.toMatch(/^You mentioned/);
  });

  it('no-file-write ignores files named only in a traceback or a shell line', async () => {
    const text =
      'Fix the crash in the admin.\nTraceback:\n File "/some/path/django/contrib/admin/utils.py", line 334\n' +
      'Reproduce:\n$ ./manage.py check\n';
    const msgs = [{ role: 'user' as const, content: text }];
    expect(await buildNoFileWriteReprompt(msgs, new Set(), undefined, async () => false)).toBeNull();
  });

  it('no-file-write does not ask about a file the run deleted (delete-file-when-requested)', async () => {
    const msgs = [
      { role: 'user' as const, content: 'Delete src/legacy.ts. Do not touch src/modern.ts.' },
      {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: 't1',
            content: '<tool_output tool="delete_file">\nFile deleted: src/legacy.ts\n</tool_output>',
          },
        ],
      },
    ];
    // Neither file is in editedFiles; legacy.ts is gone from disk, modern.ts exists.
    const exists = async (p: string) => p.endsWith('modern.ts');
    expect(await buildNoFileWriteReprompt(msgs, new Set(), undefined, exists)).toBeNull();
  });

  it('no-file-write still asks about a file the request asks to create', async () => {
    const msgs = [{ role: 'user' as const, content: 'Create src/hello.ts exporting hello().' }];
    const r = await buildNoFileWriteReprompt(msgs, new Set(), undefined, async () => false);
    expect(r).toContain('The request mentions `src/hello.ts`');
  });
});
