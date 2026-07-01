// ---------------------------------------------------------------------------
// Shared schema normalization for BFCL.
//
// BFCL schemas use a Python-flavored type vocabulary (dict / float / tuple /
// integer / any) that is NOT valid JSON Schema. Sent raw, a model can refuse or
// mis-call and score unfairly low; and it can't drive constrained decoding. This
// maps the types to JSON Schema. Extracted here so both the request backends and
// the constrained-decoding schema builder use one implementation.
// ---------------------------------------------------------------------------

const TYPE_MAP: Record<string, string> = {
  dict: 'object',
  float: 'number',
  integer: 'integer',
  tuple: 'array',
  array: 'array',
  string: 'string',
  boolean: 'boolean',
  number: 'number',
  object: 'object',
};

export function normalizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeSchema);
  if (typeof schema !== 'object' || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === 'type' && typeof v === 'string') {
      const mapped = TYPE_MAP[v.toLowerCase()];
      // 'any' (and any unknown type) → drop the constraint rather than emit junk.
      if (mapped) out[k] = mapped;
    } else {
      out[k] = normalizeSchema(v);
    }
  }
  return out;
}
