/**
 * Normalize a user- or environment-supplied Ollama host to a fetchable URL.
 *
 * Cloud GPU templates commonly export a schemeless `OLLAMA_HOST=127.0.0.1:11434`
 * — the ollama CLI tolerates it, but `fetch()` throws `Failed to parse URL`.
 * Observed live on a Vast.ai box: every SWE-campaign LLM call died in <1s and
 * the loop misclassified the runs as bad-reasoning. Prefix `http://` when no
 * scheme is present; pass through everything else untouched.
 */
export function normalizeOllamaHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed === '') return trimmed;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}
