// Outbound URL guard (SSRF). One place that decides whether a URL SideCar
// fetches or browses on the model's say-so points at the user's own machine,
// network, or cloud metadata.
//
// The checks it replaces matched hostname STRINGS, which missed `[::1]`
// (URL.hostname keeps the brackets), `0.0.0.0`, the rest of 127/8,
// IPv4-mapped IPv6 such as `[::ffff:a9fe:a9fe]` (= 169.254.169.254, the
// metadata endpoint), `localhost.` and `*.localhost`, any public NAME that
// resolves to a private address, and redirects -- `fetch` and Playwright both
// follow them. Here an address is classified by its numeric range, names are
// resolved before use, and callers re-check every redirect hop.

import * as net from 'net';
import { lookup } from 'dns/promises';

export type AddressClass = 'public' | 'loopback' | 'private' | 'link-local' | 'unspecified';

function classifyV4(ip: string): AddressClass {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT 100.64/10
  if (a >= 224) return 'private'; // multicast and reserved
  return 'public';
}

/** Classify an IP literal (no brackets). Non-IP input is 'public'. */
export function classifyAddress(ip: string): AddressClass {
  const addr = ip.toLowerCase().replace(/%.*$/, ''); // drop an IPv6 zone id
  const family = net.isIP(addr);
  if (family === 4) return classifyV4(addr);
  if (family !== 6) return 'public';
  if (addr === '::') return 'unspecified';
  if (addr === '::1') return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d / ::ffff:hhhh:hhhh) and IPv4-compatible (::a.b.c.d)
  const dotted = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (dotted) return classifyV4(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return classifyV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (/^fe[89ab]/.test(addr)) return 'link-local'; // fe80::/10
  if (/^f[cd]/.test(addr)) return 'private'; // fc00::/7 unique-local
  return 'public';
}

/** Normalize a URL hostname: no IPv6 brackets, no trailing dot, lower case. */
export function normalizeHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

/**
 * Classify a hostname WITHOUT DNS: IP literals by range, `localhost` and
 * `*.localhost` as loopback. Any other name is 'name' -- it needs resolving.
 */
export function classifyHostLiteral(hostname: string): AddressClass | 'name' {
  const host = normalizeHost(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (net.isIP(host.replace(/%.*$/, ''))) return classifyAddress(host);
  return 'name';
}

const SEVERITY: Record<AddressClass, number> = {
  public: 0,
  private: 1,
  loopback: 2,
  unspecified: 3,
  'link-local': 4,
};

/**
 * Classify a hostname, resolving a name through DNS. A name with ANY
 * non-public address takes the most restrictive class among them. A name that
 * does not resolve is 'public' -- the request will fail on its own.
 */
export async function classifyHost(hostname: string): Promise<AddressClass> {
  const literal = classifyHostLiteral(hostname);
  if (literal !== 'name') return literal;
  try {
    const addrs = await lookup(normalizeHost(hostname), { all: true });
    let worst: AddressClass = 'public';
    for (const { address } of addrs) {
      const c = classifyAddress(address);
      if (SEVERITY[c] > SEVERITY[worst]) worst = c;
    }
    return worst;
  } catch {
    return 'public';
  }
}

/**
 * Why `rawUrl` must not be fetched, or null when it may be. Loopback and
 * private hosts are allowed only when listed in `allowedHosts` (a local dev
 * server is the common, legitimate case); link-local (cloud metadata) and
 * unspecified addresses never are.
 */
export async function urlBlockReason(rawUrl: string, allowedHosts: readonly string[] = []): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `invalid URL: ${rawUrl}`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `only http:// and https:// URLs are allowed (got "${url.protocol}")`;
  }
  const host = normalizeHost(url.hostname);
  const cls = await classifyHost(host);
  return blockReasonFor(cls, host, allowedHosts);
}

/** The policy, given a class: shared by the sync and async checks. */
export function blockReasonFor(cls: AddressClass, host: string, allowedHosts: readonly string[] = []): string | null {
  if (cls === 'public') return null;
  if (cls === 'link-local' || cls === 'unspecified') {
    return `${cls} addresses are blocked (${host})`;
  }
  const allowed = allowedHosts.some((d) => {
    const a = normalizeHost(d);
    return host === a || host.endsWith(`.${a}`);
  });
  return allowed ? null : `${cls} addresses are blocked (${host})`;
}
