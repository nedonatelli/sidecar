/**
 * The request that unloads a model from Ollama, so the next request starts
 * from a COLD prompt cache.
 *
 * Why the SWE harness does this before every task. Ollama with a pinned seed
 * and fixed temperature is deterministic -- but only for a given cache state.
 * Measured on this workstation with one prompt, seed 42, temperature 0.2:
 *
 *   a cold    4c1192f0c8      (model freshly loaded)
 *   b warm    bdf80eedcf      (same prompt again, prefix cached)
 *   c warm    bdf80eedcf
 *   d cold    4c1192f0c8      (after unloading and reloading)
 *
 *   cold == cold  true      warm == warm  true      cold == warm  FALSE
 *
 * A cached prefix is batched differently from a cold one, which perturbs the
 * logits at the margin and changes the sample. In an eval, tasks run
 * back-to-back on a warm model, so each task's first turn depends on what the
 * PREVIOUS task left cached. Two runs of the same task at the same seed diverged
 * in the model's own call with every prior tool result byte-identical -- the
 * harness fed identical inputs and the model layer sampled differently.
 *
 * Unloading before each task makes every task start cold, and cold is
 * reproducible. It costs one model load per task (~5s here, against tasks of
 * 60-150s). This is the second half of making runs reproducible; the first was
 * the stable clone directory (clonePath.ts), which fixed the prompt but left
 * the cache state uncontrolled.
 *
 * Pure: returns the request rather than sending it, so the shape is unit-tested
 * and the network call stays in the driver.
 */
export function unloadModelRequest(host: string, model: string): { url: string; body: string } {
  return {
    url: `${host.replace(/\/+$/, '')}/api/generate`,
    // keep_alive: 0 is Ollama's documented way to evict a loaded model. No
    // prompt: this request generates nothing, it only changes residency.
    body: JSON.stringify({ model, keep_alive: 0 }),
  };
}
