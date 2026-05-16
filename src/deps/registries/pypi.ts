/** Fetch the latest stable version of a PyPI package. Returns undefined on any error. */
export async function fetchPypiLatest(name: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { signal });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { info?: { version?: string } };
    return json.info?.version;
  } catch {
    return undefined;
  }
}
