// Sanitize run trajectories for a handoff (#294). A run on another machine (the
// DGX, the laptop) used to come back as predictions only, because its traces
// carry the backend endpoint, credentials and the run machine's home path, and
// scrubbing them was done by hand. Without the traces, questions like "what did
// the model do on the 1/3 flaky case" can't be answered.
//
// Two passes, deliberately unequal:
//   - sanitizeText() REWRITES what it recognises, rule by rule, and counts it;
//   - findSecrets() then scans the result with STRICTER detectors (substring and
//     case-insensitive matches of the explicit values, endpoint-shaped URLs, key
//     shapes, private-key blocks). Any hit means the export writes nothing.
// The scan is the safety property; the rewrite is what makes it pass. A value
// the rewrite misses (a username inside a longer word, a public-looking DNS
// name for the endpoint) stops the export rather than leaking.
//
// Pure functions here; bench/swe/export_trajectories.mjs walks the directories
// and writes the files.

const PLACEHOLDER_RE = /^<[a-z-]+>$/;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The spellings a literal can take inside a trace: raw, JSON-escaped, URL-encoded. */
function variants(value) {
  const v = new Set([value, value.replace(/\\/g, '\\\\'), encodeURIComponent(value)]);
  return [...v].filter((s) => s.length > 0);
}

/** Known credential shapes. Shared by the rewrite and the scan. */
export const KEY_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  /\bnvapi-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
];

const BEARER_RE = /\b(Bearer)\s+([A-Za-z0-9._~+/=-]{8,})/g;

// `api_key = "…"`, `"x-api-key": "…"`. The value must look like a token (a
// letter and a digit, 16+ chars) so source code such as `api_key = os.environ`
// in a repository under test is left alone.
const KEY_ASSIGN_RE =
  /((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|password|x-api-key)["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-.+/=]{16,})/gi;

const URL_RE = /\b((?:https?|wss?):\/\/)([^\s/"'<>?#\\`]+)/g;

const IPV4 = '(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
// Not inside a longer dotted run, so a version such as 1.2.3.4.5 is left alone.
const IPV4_RE = new RegExp(`(?<![\\w.])${IPV4}(?![\\w]|\\.\\d)`, 'g');

// /home/<name>, /Users/<name>, C:\Users\<name> (raw or JSON-escaped), c:/users/<name>.
// The lookbehind keeps URL paths such as api.github.com/users/<login> out.
const HOME_RE =
  /((?<![\w.\-])\/home\/|(?<![\w.\-])\/Users\/|\b[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/))([^/\\\s"'<>:*?|]+)/gi;

const PRIVATE_SUFFIX_RE = /\.(?:local|localdomain|lan|internal|intranet|home|corp)$/i;

/** True for a URL host that names a private machine rather than a public service. */
export function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h.includes(':')) return true; // IPv6 literal
  if (new RegExp(`^${IPV4}$`).test(h)) return true;
  if (!h.includes('.')) return true; // localhost, dgx-01
  return PRIVATE_SUFFIX_RE.test(h);
}

/**
 * Explicit sensitive values: [{ value, placeholder }]. Values shorter than 3
 * characters are dropped (they would rewrite ordinary words); placeholders
 * default to `<redacted>`.
 */
function normalizeExplicit(explicit) {
  return explicit
    .filter((e) => e && typeof e.value === 'string' && e.value.trim().length >= 3)
    .map((e) => ({ value: e.value.trim(), placeholder: e.placeholder || '<redacted>' }))
    .sort((a, b) => b.value.length - a.value.length);
}

function count(counts, rule, n) {
  if (n > 0) counts[rule] = (counts[rule] || 0) + n;
}

function replaceCounting(text, re, fn, counts, rule) {
  let n = 0;
  const out = text.replace(re, (...m) => {
    const r = fn(...m);
    if (r !== m[0]) n++;
    return r;
  });
  count(counts, rule, n);
  return out;
}

/**
 * Rewrite every recognised sensitive value. Returns the new text and a count per
 * rule (never the values).
 */
export function sanitizeText(text, { explicit = [] } = {}) {
  const counts = {};
  let t = text;

  // Explicit values first and longest first, so an endpoint URL is replaced
  // whole before the URL rule sees its host. Word-bounded at alphanumeric ends
  // so a username does not rewrite the middle of a longer word; the scan below
  // catches that case instead.
  for (const { value, placeholder } of normalizeExplicit(explicit)) {
    for (const v of variants(value)) {
      const pre = /^\w/.test(v) ? '(?<!\\w)' : '';
      const post = /\w$/.test(v) ? '(?!\\w)' : '';
      t = replaceCounting(
        t,
        new RegExp(pre + escapeRe(v) + post, 'gi'),
        () => placeholder,
        counts,
        `explicit ${placeholder}`,
      );
    }
  }

  t = replaceCounting(t, BEARER_RE, (_m, b) => `${b} <token>`, counts, 'bearer token');
  for (const re of KEY_SHAPES) t = replaceCounting(t, re, () => '<api-key>', counts, 'api key');
  t = replaceCounting(
    t,
    KEY_ASSIGN_RE,
    (m, k, v) => (/[A-Za-z]/.test(v) && /\d/.test(v) ? `${k}<api-key>` : m),
    counts,
    'key assignment',
  );

  t = replaceCounting(
    t,
    URL_RE,
    (m, scheme, authority) => {
      // Credentials in the URL go whatever the host.
      const at = authority.lastIndexOf('@');
      const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
      const host = hostPort.replace(/:\d+$/, '');
      if (PLACEHOLDER_RE.test(host)) return at >= 0 ? `${scheme}<credentials>@${hostPort}` : m;
      if (isPrivateHost(host)) return `${scheme}<host>`;
      return at >= 0 ? `${scheme}<credentials>@${hostPort}` : m;
    },
    counts,
    'url host',
  );

  t = replaceCounting(t, IPV4_RE, () => '<ip>', counts, 'ip address');
  t = replaceCounting(
    t,
    HOME_RE,
    (m, pre, name) => (PLACEHOLDER_RE.test(name) ? m : `${pre}<user>`),
    counts,
    'home path',
  );

  return { text: t, counts };
}

/**
 * Scan sanitized text for anything secret-shaped that survived. Returns
 * [{ line, detector }] (1-based lines, no values). Stricter than the rewrite on
 * purpose: explicit values match as plain substrings, case-insensitively.
 */
export function findSecrets(text, { explicit = [] } = {}) {
  const lines = text.split('\n');
  const values = normalizeExplicit(explicit).flatMap((e) =>
    variants(e.value).map((v) => [v.toLowerCase(), e.placeholder]),
  );
  const findings = [];
  lines.forEach((line, i) => {
    const hit = (detector) => findings.push({ line: i + 1, detector });
    const lower = line.toLowerCase();
    for (const [v, placeholder] of values) if (lower.includes(v)) hit(`explicit value (${placeholder})`);
    for (const re of KEY_SHAPES) if (new RegExp(re.source).test(line)) hit('api key shape');
    for (const m of line.matchAll(BEARER_RE)) if (!PLACEHOLDER_RE.test(m[2])) hit('bearer token');
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) hit('private key');
    for (const m of line.matchAll(HOME_RE)) if (!PLACEHOLDER_RE.test(m[2])) hit('home path');
    for (const m of line.matchAll(URL_RE)) {
      const authority = m[2];
      const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d+$/, '');
      if (authority.includes('@') && !authority.startsWith('<credentials>@')) hit('url credentials');
      if (!PLACEHOLDER_RE.test(host) && isPrivateHost(host)) hit('private url host');
      // A model endpoint on a public-looking name: an explicit port and an API path.
      const rest = line.slice(m.index + m[0].length);
      if (/:\d+$/.test(authority) && /^\/(?:v1\b|api\/(?:chat|generate|tags|embed))/.test(rest)) hit('endpoint url');
    }
  });
  return findings;
}

/**
 * Sanitize a set of files and decide whether the export may be written.
 * files: [{ path, text }]. Returns { ok, files, manifest, findings }; when ok is
 * false, `files` is empty so a caller cannot write a partial export by mistake.
 */
export function planExport(files, { explicit = [] } = {}) {
  const out = [];
  const findings = [];
  const totals = {};
  const perFile = [];
  for (const f of files) {
    const { text, counts } = sanitizeText(f.text, { explicit });
    for (const s of findSecrets(text, { explicit })) findings.push({ path: f.path, ...s });
    for (const [k, n] of Object.entries(counts)) totals[k] = (totals[k] || 0) + n;
    perFile.push({ path: f.path, bytes: Buffer.byteLength(text), replacements: counts });
    out.push({ path: f.path, text });
  }
  const ok = findings.length === 0;
  const manifest = {
    files: perFile,
    totals,
    explicitValues: normalizeExplicit(explicit).map((e) => e.placeholder),
    findings: findings.length,
  };
  return { ok, files: ok ? out : [], manifest, findings };
}
