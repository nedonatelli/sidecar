// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildHtml } from './reviewPanel.js';

// #119: the panel's CSP allows only its nonce'd script, so inline onclick=""
// handlers never ran and every Fork/Facet button did nothing. These tests run
// the panel's real script and click the real buttons.

let posted: Array<Record<string, unknown>>;

function loadPanel(): void {
  const html = buildHtml('testnonce');
  document.body.innerHTML = html.slice(html.indexOf('<body'), html.indexOf('<script'));
  posted = [];
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (m: Record<string, unknown>) => posted.push(m),
  });
  const script = html.slice(html.indexOf('>', html.indexOf('<script')) + 1, html.indexOf('</script>'));
  // eslint-disable-next-line no-new-func
  new Function(script)();
}

function send(data: unknown): void {
  const ev = new Event('message') as Event & { data: unknown };
  ev.data = data;
  window.dispatchEvent(ev);
}

const item = (id: string) => ({
  id,
  label: id,
  files: ['a.ts'],
  linesAdded: 1,
  linesRemoved: 1,
  durationMs: 5,
  diff: '',
});

describe('review panel buttons', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    loadPanel();
  });

  it.each(['fork', 'facet'])('renders no inline event handlers in %s mode (the CSP blocks them)', (mode) => {
    // happy-dom does not enforce CSP, so this is the check that would have
    // caught the dead buttons: no on* attribute on any rendered element.
    send({ command: 'init', mode, items: [item('a'), item('b')] });
    const handlers = [...document.querySelectorAll('*')].flatMap((el) =>
      [...el.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `${el.tagName}.${a.name}`),
    );
    expect(handlers).toEqual([]);
  });

  it('Accept / Reject / Skip post their facet commands', () => {
    send({ command: 'init', mode: 'facet', items: [item('f1'), item('f2'), item('f3')] });
    (document.querySelector('[data-action="accept"][data-id="f1"]') as HTMLElement).click();
    (document.querySelector('[data-action="reject"][data-id="f2"]') as HTMLElement).click();
    (document.querySelector('[data-action="skip"][data-id="f3"]') as HTMLElement).click();
    expect(posted).toContainEqual({ command: 'acceptFacet', facetId: 'f1' });
    expect(posted).toContainEqual({ command: 'rejectFacet', facetId: 'f2' });
    expect(posted).toContainEqual({ command: 'skipFacet', facetId: 'f3' });
  });

  it('selecting a fork enables Apply, which posts applyFork; Dismiss posts dismiss', () => {
    send({ command: 'init', mode: 'fork', items: [item('k1'), item('k2')] });
    (document.querySelector('.card-header[data-id="k2"]') as HTMLElement).click();
    const apply = document.getElementById('applyBtn') as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    apply.click();
    expect(posted).toContainEqual({ command: 'applyFork', forkId: 'k2' });
    (document.querySelector('[data-action="dismiss"]') as HTMLElement).click();
    expect(posted).toContainEqual({ command: 'dismiss' });
  });
});
