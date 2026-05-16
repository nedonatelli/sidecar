/** Fetch the latest version of a Go module from the Go module proxy. Returns undefined on any error. */
export async function fetchGoLatest(modulePath: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    // The Go proxy encodes module paths with uppercase letters replaced by !lowercase.
    const encoded = modulePath.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
    const res = await fetch(`https://proxy.golang.org/${encoded}/@latest`, { signal });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { Version?: string };
    // Strip leading 'v' to normalize to semver format
    return json.Version?.replace(/^v/, '');
  } catch {
    return undefined;
  }
}
