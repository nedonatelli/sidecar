import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initWarmup } from './warmup.js';
import type { SideCarConfig } from '../config/settings.js';

/**
 * Local-first egress guard (compliance).
 *
 * SideCar's headline promise is "with local models, no data leaves your
 * machine." That is a compliance claim nothing tested until now. The backend
 * call itself legitimately goes to whatever provider the user chose (a cloud
 * key is a deliberate, disclosed choice), so the real risk is INCIDENTAL
 * egress: an activation ping, a model-discovery probe, or a phone-home
 * dependency reaching the network on its own during a local session. These
 * tests pin the two concrete vectors — the warmup path and the dependency set.
 */

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

function hostOf(target: string | URL | Request): string {
  const url = typeof target === 'string' ? target : target instanceof URL ? target.href : target.url;
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return url;
  }
}

function isLocalHost(target: string | URL | Request): boolean {
  const h = hostOf(target);
  return LOCAL_HOSTS.includes(h) || LOCAL_HOSTS.includes(`[${h}]`);
}

/** Minimal config — initWarmup only reads baseUrl / model / provider. */
function cfg(over: Partial<SideCarConfig>): SideCarConfig {
  return { baseUrl: 'http://localhost:11434', model: 'qwen2.5-coder:7b', provider: 'ollama', ...over } as SideCarConfig;
}

/** Let the setImmediate-scheduled warmup callbacks (and their fetch chains) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

describe('local-first egress — activation warmup', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a local Ollama session only ever fetches localhost', async () => {
    const calls: Array<string | URL | Request> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((t: string | URL | Request) => {
        calls.push(t);
        return Promise.resolve(new Response('{}', { status: 200 }));
      }),
    );
    initWarmup(cfg({ baseUrl: 'http://localhost:11434', provider: 'ollama' }));
    await flush();
    expect(calls.length).toBeGreaterThan(0); // warmup actually ran — not vacuous
    const external = calls.filter((c) => !isLocalHost(c)).map(hostOf);
    expect(external, `warmup reached non-local hosts: ${external.join(', ')}`).toEqual([]);
  });

  it('a Kickstand session only ever fetches localhost', async () => {
    const calls: Array<string | URL | Request> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((t: string | URL | Request) => {
        calls.push(t);
        return Promise.resolve(new Response('{}', { status: 200 }));
      }),
    );
    initWarmup(cfg({ baseUrl: 'http://localhost:11435', provider: 'kickstand' }));
    await flush();
    const external = calls.filter((c) => !isLocalHost(c)).map(hostOf);
    expect(external, `warmup reached non-local hosts: ${external.join(', ')}`).toEqual([]);
  });

  it('choosing a cloud backend triggers NO incidental warmup fetch', async () => {
    // A cloud key is a deliberate choice for the BACKEND CALL; activation must
    // not additionally probe anything. Zero fetches is the guarantee.
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchSpy);
    initWarmup(cfg({ baseUrl: 'https://api.anthropic.com', provider: 'anthropic', model: 'claude-sonnet-5' }));
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a remote Ollama URL is not treated as local — no pre-warm to a remote host', async () => {
    // isLocalOllama gates the pre-warm on the localhost:11434 host specifically,
    // so a user pointing at a remote Ollama does not get a silent pre-warm ping.
    const calls: Array<string | URL | Request> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((t: string | URL | Request) => {
        calls.push(t);
        return Promise.resolve(new Response('{}', { status: 200 }));
      }),
    );
    initWarmup(cfg({ baseUrl: 'http://10.0.0.9:11434', provider: 'ollama' }));
    await flush();
    // Discovery may still probe localhost fallbacks; what must NOT happen is a
    // fetch to the remote host.
    const remote = calls.filter((c) => hostOf(c) === '10.0.0.9');
    expect(remote, 'pre-warmed a remote Ollama host').toEqual([]);
  });
});

describe('local-first egress — no phone-home dependency', () => {
  it('ships no third-party telemetry / analytics SDK', () => {
    // vitest and tsc both run from the repo root.
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const banned =
      /(^|[/-])(telemetry|analytics|posthog|segment|amplitude|mixpanel|@sentry|heap|rudder|snowplow|bugsnag|datadog)([/-]|$)/i;
    const offenders = deps.filter((d) => banned.test(d));
    expect(offenders, `phone-home dependency present: ${offenders.join(', ')}`).toEqual([]);
  });
});
