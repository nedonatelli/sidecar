// Lightweight validation of LLM-generated tool input against a tool's declared
// input_schema, run in the dispatcher before any executor sees the input. This
// turns "model emitted content: 123" and "model omitted a required field" from
// opaque downstream TypeErrors (e.g. "argument must be of type string") into a
// named, actionable is_error the model can correct on the next turn.
//
// Deliberately conservative: only required-key presence and string/array type
// mismatches are rejected. number / boolean / object are left lenient because
// models routinely send coercible forms (a numeric string for a number field),
// and rejecting those would break working flows for no safety gain.

interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

function jsType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

/**
 * @returns a human-readable error string when the input violates the schema,
 *          or `null` when it is acceptable.
 */
export function validateToolInput(input: unknown, schema: ToolInputSchema | undefined): string | null {
  if (!schema || schema.type !== 'object') return null;

  // A no-argument call may arrive as undefined/null — treat as empty object so
  // required-less tools pass and required-ful tools still report the miss.
  const obj: Record<string, unknown> = input === null || input === undefined ? {} : (input as Record<string, unknown>);
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    return `input must be a JSON object, got ${jsType(input)}`;
  }

  for (const key of schema.required ?? []) {
    if (obj[key] === undefined || obj[key] === null) {
      return `missing required parameter '${key}'`;
    }
  }

  const properties = schema.properties ?? {};
  for (const [key, rawSpec] of Object.entries(properties)) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    const declared = (rawSpec as { type?: string }).type;
    if (declared === 'string' && typeof value !== 'string') {
      return `parameter '${key}' must be a string, got ${jsType(value)}`;
    }
    if (declared === 'array' && !Array.isArray(value)) {
      return `parameter '${key}' must be an array, got ${jsType(value)}`;
    }
  }

  return null;
}
