/** Fetch the latest stable version of an npm package. Returns undefined on any error. */
export async function fetchNpmLatest(name: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { signal });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { version?: string };
    return json.version;
  } catch {
    return undefined;
  }
}
