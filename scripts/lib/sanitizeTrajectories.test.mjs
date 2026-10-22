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
