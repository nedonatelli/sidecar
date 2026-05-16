/** Fetch the latest stable version of a crates.io package. Returns undefined on any error. */
export async function fetchCargoLatest(name: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const res = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, {
      headers: { 'User-Agent': 'sidecar-vscode/1.0 (https://github.com/nedonatelli/sidecar)' },
      signal,
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { crate?: { max_stable_version?: string; newest_version?: string } };
    return json.crate?.max_stable_version ?? json.crate?.newest_version;
  } catch {
    return undefined;
  }
}
