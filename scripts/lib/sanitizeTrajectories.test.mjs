import { describe, it, expect } from 'vitest';
import { sanitizeText, findSecrets, planExport, isPrivateHost } from './sanitizeTrajectories.mjs';

// #294: a remote run's traces carry the backend endpoint, credentials and the
// run machine's home path. These pin that each is rewritten, that what the
// rewrite misses stops the export, and that ordinary repository code in tool
// output survives.

const EXPLICIT = [
  { value: 'http://dgx-07.example.net:11434', placeholder: '<host>' },
  { value: 'C:\\Users\\nedon', placeholder: '<home>' },
  { value: 'nedon', placeholder: '<user>' },
];

// A trace line as the SWE loop writes it: JSON, so a Windows path is escaped.
const PLANTED = [
  '{"t":1,"type":"request","baseUrl":"http://dgx-07.example.net:11434/api/chat"}',
  '{"t":2,"headers":{"Authorization":"Bearer abcdEFGH1234ijkl5678"}}',
  '{"t":3,"apiKey":"sk-proj-AbCdEf0123456789XyZ"}',
  '{"t":4,"cwd":"C:\\\\Users\\\\nedon\\\\Documents\\\\swe-clones\\\\psf__requests"}',
  '[+5ms] TOOL run_command curl http://10.0.4.17:8000/v1/models',
  '[+6ms] cwd /home/dgxuser/work/astropy',
].join('\n');

describe('sanitizeText', () => {
  it('removes a planted URL, IP address, token, API key and home path', () => {
    const { text, counts } = sanitizeText(PLANTED, { explicit: EXPLICIT });
    expect(text).not.toMatch(/dgx-07|example\.net|11434/);
    expect(text).not.toMatch(/10\.0\.4\.17|8000/);
    expect(text).not.toMatch(/abcdEFGH1234ijkl5678/);
    expect(text).not.toMatch(/sk-proj/);
    expect(text).not.toMatch(/nedon|dgxuser/);
    expect(text).toContain('"baseUrl":"<host>/api/chat"');
    expect(text).toContain('Bearer <token>');
    expect(text).toContain('"apiKey":"<api-key>"');
    expect(text).toContain('<home>\\\\Documents');
    expect(text).toContain('curl http://<host>/v1/models');
    expect(text).toContain('/home/<user>/work/astropy');
    expect(counts).toMatchObject({
      'explicit <host>': 1,
      'bearer token': 1,
      'api key': 1,
      'url host': 1,
      'home path': 1,
    });
    expect(findSecrets(text, { explicit: EXPLICIT })).toEqual([]);
  });

  it('rewrites a bare IP address and private hosts, keeps public hosts', () => {
    const { text } = sanitizeText(
      'ping 192.168.1.20 then http://localhost:5000/x and http://gpu.lab.internal/y, docs at https://github.com/psf/requests',
    );
    expect(text).toBe('ping <ip> then http://<host>/x and http://<host>/y, docs at https://github.com/psf/requests');
  });

  it('strips credentials from a public URL', () => {
    expect(sanitizeText('git clone https://bob:hunter2@github.com/a/b').text).toBe(
      'git clone https://<credentials>@github.com/a/b',
    );
  });

  it('leaves repository code alone: versions, os.environ lookups, URL paths', () => {
    const code = [
      'requests 2.31.0 on Python 3.11.4, build 1.2.3.4.5',
      "api_key = os.environ['OPENAI_API_KEY']",
      'see https://api.github.com/users/octocat/repos',
      'a.b.c.d = 1',
    ].join('\n');
    expect(sanitizeText(code).text).toBe(code);
  });

  it('rewrites a four-part version, which cannot be told from an IP address', () => {
    // The trade-off taken: over-redact a rare version string rather than leak an
    // address. The manifest's `ip address` count shows how often it happened.
    expect(sanitizeText('pinned 2.31.0.1').text).toBe('pinned <ip>');
  });

  it('word-bounds explicit values, so a short username does not rewrite a longer word', () => {
    const { text } = sanitizeText('user nedon wrote nedonatelli/sidecar', {
      explicit: [{ value: 'nedon', placeholder: '<user>' }],
    });
    expect(text).toBe('user <user> wrote nedonatelli/sidecar');
  });
});

// Shapes that got past the exporter in a real handoff: a Windows path at the
// start of a line of tool output, the short form of a long username, project
// names in a temp-folder listing, and a value that is only a name's prefix.
describe('sanitizeText: what a real Windows handoff carried', () => {
  const USER = [{ value: 'jsmithers', placeholder: '<user>' }];

  it('rewrites a home path that starts a line inside a JSON string', () => {
    const line = '{"result":"<tool_output>\\nC:\\\\Users\\\\jsmithers\\\\AppData\\\\Local\\\\Temp"}';
    const { text } = sanitizeText(line, {});
    expect(text).toBe('{"result":"<tool_output>\\nC:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp"}');
    expect(findSecrets(line, {}).map((f) => f.detector)).toEqual(['home path']);
  });

  it('rewrites the Windows short form of a long username, and the scan catches it', () => {
    const line = '{"result":"C:\\\\Users\\\\JSMITH~1\\\\AppData\\\\Local\\\\Temp\\\\x.py"}';
    expect(sanitizeText(line, { explicit: USER }).text).not.toMatch(/JSMITH~1/i);
    expect(findSecrets('cd /c/Users/jsmith~1/tmp', { explicit: USER }).map((f) => f.detector)).toContain(
      'short user name',
    );
    // A name of eight characters or fewer has no short form to look for.
    const short = findSecrets('JSMITH~1', { explicit: [{ value: 'jsmith', placeholder: '<user>' }] });
    expect(short.map((f) => f.detector)).not.toContain('short user name');
  });

  it('omits a run of `ls -l` entries, in raw text and inside a JSON string', () => {
    const entries = [
      '-rw-r--r-- 1 jsmithers 197121    120 Oct 22 12:06 acme-billing-tests-3f2a',
      'drwxr-xr-x 1 jsmithers 197121      0 Oct 22 12:06 acme-radar-sim',
      '-rw-r--r-- 1 jsmithers 197121   3477 Aug 25  2025 orbit_backup.sim',
    ];
    const raw = sanitizeText(`total 12\n${entries.join('\n')}\nnext`, {});
    expect(raw.text).toBe('total 12\n[3 directory entries omitted]\nnext');
    expect(raw.counts['directory listing']).toBe(1);
    const json = sanitizeText(JSON.stringify({ result: `total 12\n${entries.join('\n')}\n` }), {});
    expect(json.text).toBe('{"result":"total 12\\n[3 directory entries omitted]\\n"}');
  });

  it('omits a listing flattened onto one line, as the .log files write it', () => {
    const line =
      '[+5ms] → run_command ok: total 8 drwxr-xr-x 1 u 197121 0 Oct 22 12:06 acme-a ' +
      '-rw-r--r-- 1 u 197121 9 Oct 22 12:06 acme-b drwxr-xr-x 1 u 197121 0 Oct 27 09:01 acme-c';
    expect(sanitizeText(line, {}).text).toBe('[+5ms] → run_command ok: total 8 [3 directory entries omitted]');
  });

  it('rewrites everything under a temp folder, raw and JSON-escaped', () => {
    const t =
      '/tmp/claude/c--Users-u-Documents-Code-acme/1/x.log and ' +
      '{"p":"C:\\\\Users\\\\u\\\\AppData\\\\Local\\\\Temp\\\\acme-tests-3f\\\\out.txt"}';
    expect(sanitizeText(t, {}).text).toBe(
      '/tmp/<tmp-path> and {"p":"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\<tmp-path>"}',
    );
    expect(sanitizeText('see /tmp/acme-x\\nnext', {}).text).toBe('see /tmp/<tmp-path>\\nnext');
    // A path that starts a line of JSON-escaped tool output.
    expect(sanitizeText('out\\n/tmp/acme-y/z', {}).text).toBe('out\\n/tmp/<tmp-path>');
  });

  it('leaves listings and temp paths in a predictions file: the patch is scored as written', () => {
    const patch = '{"model_patch":"+    path = \\"/tmp/acme-cache\\"\\n"}';
    const plan = planExport([{ path: 'run/preds.scaffold-on.jsonl', text: patch }]);
    expect(plan.ok).toBe(true);
    expect(plan.files[0].text).toBe(patch);
  });

  it('keeps one or two `ls -l` lines: a file the model checked is not a listing', () => {
    const two = '-rw-r--r-- 1 u g 10 Oct 22 12:06 setup.py\n-rw-r--r-- 1 u g 20 Oct 22 12:06 setup.cfg';
    expect(sanitizeText(two, {}).text).toBe(two);
  });

  it('a token value takes the whole name around it; a plain value only itself', () => {
    const t = 'ls /work/acme-billing-tests-3f2a and acme-radar-sim.cfg';
    expect(sanitizeText(t, { explicit: [{ value: 'acme-', placeholder: '<redacted>', token: true }] }).text).toBe(
      'ls /work/<redacted> and <redacted>',
    );
    expect(sanitizeText('a sat_backup.SIM file', { explicit: [{ value: '.sim', token: true }] }).text).toBe(
      'a <redacted> file',
    );
  });
});

describe('isPrivateHost', () => {
  it('classifies IPs, single labels and private suffixes as private', () => {
    for (const h of ['10.1.2.3', 'localhost', 'dgx-01', 'box.local', 'gpu.corp', '[::1]'])
      expect(isPrivateHost(h)).toBe(true);
    for (const h of ['github.com', 'pypi.org', 'api.openai.com']) expect(isPrivateHost(h)).toBe(false);
  });
});

describe('findSecrets', () => {
  it('reports line and detector, never the value', () => {
    const f = findSecrets('ok\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123', {});
    expect(f).toEqual([{ line: 2, detector: 'api key shape' }]);
    expect(JSON.stringify(f)).not.toContain('ghp_');
  });

  it('flags an endpoint on a public-looking name by its port and API path', () => {
    expect(findSecrets('POST https://llm.example.com:8443/v1/chat/completions').map((f) => f.detector)).toEqual([
      'endpoint url',
    ]);
  });

  it('flags a private key block', () => {
    expect(findSecrets('-----BEGIN OPENSSH PRIVATE KEY-----').map((f) => f.detector)).toEqual(['private key']);
  });
});

describe('planExport', () => {
  it('writes the sanitized files and a manifest of counts when nothing survives', () => {
    const plan = planExport([{ path: 'a.trial0.jsonl', text: PLANTED }], { explicit: EXPLICIT });
    expect(plan.ok).toBe(true);
    expect(plan.files).toHaveLength(1);
    expect(plan.manifest.totals['bearer token']).toBe(1);
    expect(plan.manifest.explicitValues).toEqual(['<host>', '<home>', '<user>']);
    // The manifest carries counts, not values.
    expect(JSON.stringify(plan.manifest)).not.toMatch(/dgx-07|nedon|abcdEFGH/);
  });

  it('fails closed: a secret the rewrite missed means no files at all', () => {
    // The username inside a longer word is left by the word-bounded rewrite, and
    // the substring scan catches it.
    const plan = planExport(
      [
        { path: 'clean.log', text: 'nothing here' },
        { path: 'leaky.log', text: 'author nedonatelli' },
      ],
      { explicit: [{ value: 'nedon', placeholder: '<user>' }] },
    );
    expect(plan.ok).toBe(false);
    expect(plan.files).toEqual([]);
    expect(plan.findings).toEqual([{ path: 'leaky.log', line: 1, detector: 'explicit value (<user>)' }]);
  });

  it('fails closed on an endpoint the rewrite cannot recognise', () => {
    const plan = planExport([{ path: 'x.log', text: 'base https://llm.example.com:8443/v1' }]);
    expect(plan.ok).toBe(false);
    expect(plan.findings.map((f) => f.detector)).toEqual(['endpoint url']);
  });
});
